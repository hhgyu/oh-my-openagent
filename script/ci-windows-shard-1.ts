import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createReadStream, closeSync, mkdirSync, openSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"

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

// Exactly two package-level processes; each keeps Bun's sequential file loading
// and the root bunfig/preloads. Never use per-file --parallel or --isolate here.
const runs = ["omo-opencode", "memory-core"].map(async (target) => {
  const args = ["test", "--timeout", "30000", `packages/${target}`]
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
    return { target, args, log, pid: child.pid, exitCode, elapsedMs: Date.now() - started }
  } finally {
    closeSync(fd)
  }
})

const heartbeat = setInterval(() => console.log(`Windows shard 1: waiting for ${active.size} package processes`), 60000)
try {
  // allSettled also joins a sibling when opening or spawning the other fails.
  const results = await Promise.allSettled(runs)
  writeFileSync(join(directory, "shard-1-packages.json"), JSON.stringify(results, null, 2))
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
