import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createReadStream, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import {
  discoverTestFiles,
  MEMORY_CORE_PARTITIONS,
  memoryCoreWeight,
  partitionByWeight,
} from "./ci-windows-shard-1-partition"

const directory = process.argv[2]
if (!directory) throw new Error("Usage: bun script/ci-windows-shard-1.ts <artifact-directory>")
mkdirSync(directory, { recursive: true })

const active = new Set<ChildProcess>()
let stopping = false
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    for (const child of active) {
      if (!child.pid) continue
      if (process.platform === "win32") {
        // No detached Windows children: runner cancellation also retains the
        // ancestry and RUNNER_TRACKING_ID used by GitHub's process-tree cleanup.
        const killed = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8" })
        if (killed.status !== 0) console.error(`taskkill ${child.pid}: ${killed.stderr}`)
      } else {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
        }
      }
    }
    process.exitCode = signal === "SIGINT" ? 130 : 143
  })
}

// One omo-opencode process plus balanced memory-core file sets; each keeps Bun's sequential
// file loading and the root bunfig/preloads. Never use per-file --parallel or --isolate here.
const memoryCoreSets = partitionByWeight(
  discoverTestFiles(join("packages", "memory-core")),
  memoryCoreWeight,
  MEMORY_CORE_PARTITIONS,
)
const targets = [
  { target: "omo-opencode", paths: ["packages/omo-opencode"] },
  ...memoryCoreSets.map((files, index) => ({
    target: `memory-core-${index + 1}`,
    paths: files.map((file) => `./packages/memory-core/${file}`),
  })),
]
const runs = targets.map(async ({ target, paths }) => {
  const args = ["test", "--timeout", "30000", ...paths]
  const log = join(directory, `${target}.log`)
  const fd = openSync(log, "w")
  const started = Date.now()
  console.log(`${target}: starting bun ${args.join(" ")}; log: ${log}`)
  try {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", fd, fd],
      detached: process.platform !== "win32",
    })
    active.add(child)
    const exitCode = await new Promise<number>((resolve) => {
      child.once("error", (error) => {
        console.error(`${target}: launch failed: ${error.message}`)
        resolve(1)
      })
      child.once("close", (code) => resolve(code ?? 1))
    })
    active.delete(child)
    return {
      target,
      args,
      log,
      pid: child.pid,
      exitCode,
      elapsedMs: Date.now() - started,
      startedUtc: new Date(started).toISOString(),
      // CIM child birth times have finer precision than Date.now().
      exitedUtc: new Date(Date.now() + 1).toISOString(),
    }
  } finally {
    closeSync(fd)
  }
})

const heartbeat = setInterval(() => console.log(`Windows shard 1: waiting for ${active.size} package processes`), 60000)
try {
  // allSettled also joins a sibling when opening or spawning the other fails.
  const results = await Promise.allSettled(runs)
  writeFileSync(join(directory, "shard-1-packages.json"), JSON.stringify(results, null, 2))
  const rootsPath = process.env.OMO_CI_PACKAGE_ROOTS_PATH
  const captureId = process.env.OMO_CI_PACKAGE_ROOTS_CAPTURE_ID
  if (rootsPath && captureId) {
    try {
      writeFileSync(
        rootsPath,
        JSON.stringify({
          schemaVersion: 1,
          captureId,
          ownerPid: process.pid,
          roots: results.flatMap((result) =>
            result.status === "fulfilled" && result.value.pid
              ? [{ pid: result.value.pid, startedUtc: result.value.startedUtc, exitedUtc: result.value.exitedUtc }]
              : [],
          ),
        }),
      )
    } catch {
      console.warn("Windows CI telemetry package-root receipt failed; test outcomes remain authoritative.")
    }
  }
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(result.reason)
      process.exitCode = 1
      continue
    }
    const { target, log, exitCode, elapsedMs } = result.value
    console.log(`::group::${target} (${elapsedMs} ms)`)
    await pipeline(createReadStream(log), process.stdout, { end: false })
    console.log(`::endgroup::\n${target}: exit ${exitCode}`)
    if (exitCode !== 0) process.exitCode = 1
  }
} finally {
  clearInterval(heartbeat)
}
