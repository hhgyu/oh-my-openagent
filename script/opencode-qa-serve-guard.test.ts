import { afterEach, describe, expect, it } from "bun:test"
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// Platform + process-lifecycle contract of the opencode-qa serve guard
// (scripts/lib/serve-guard.mjs reached through common.sh `oqa_guarded_spawn`):
// a QA child started by a bash driver must never outlive that driver, even when
// the driver dies without running its EXIT trap. The child -> grandchild pair
// models the ~/.bun/bin/opencode.exe shim -> real `opencode serve` topology; on
// Windows the grandchild is spawned outside the child's own libuv job, exactly
// like the shim's CreateProcess child, so only the guard can reap it.
const COMMON_SH = join(import.meta.dir, "..", ".agents", "skills", "opencode-qa", "scripts", "lib", "common.sh")
const isWindows = process.platform === "win32"
const LINE_TIMEOUT_MS = 20_000
const DEATH_TIMEOUT_MS = 10_000

const tracked: { dir: string; pids: number[] }[] = []

function resolveBash(): string {
  if (!isWindows) return "bash"
  const gitRoot = dirname(dirname(dirname(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim())))
  const bash = join(gitRoot, "usr", "bin", "bash.exe")
  if (!existsSync(bash)) throw new Error(`Git Bash not found at ${bash}`)
  return bash
}

function toBashPath(path: string): string {
  return isWindows ? path.replaceAll("\\", "/") : path
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function terminateTree(pid: number): void {
  if (!isAlive(pid)) return
  if (isWindows) {
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true })
    return
  }
  try {
    process.kill(pid, "SIGKILL")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}

async function waitForDeath(pids: number[]): Promise<number[]> {
  const deadline = Date.now() + DEATH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isAlive(pid))) return []
    await Bun.sleep(50)
  }
  return pids.filter(isAlive)
}

function writeChildFixture(dir: string, childExitCode: number | null): string {
  const grandchild = join(dir, "grandchild.mjs")
  const child = join(dir, "child.mjs")
  writeFileSync(grandchild, "setInterval(() => {}, 1_000_000)\n")
  writeFileSync(
    child,
    [
      'import { spawn } from "node:child_process"',
      `const gc = spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: "ignore", windowsHide: true, detached: ${isWindows} })`,
      'process.stdout.write("GRANDCHILD " + gc.pid + "\\nCHILD " + process.pid + "\\nGUARD " + process.ppid + "\\n")',
      childExitCode === null
        ? "setInterval(() => {}, 1_000_000)"
        : `setTimeout(() => { gc.kill(); process.exit(${childExitCode}) }, 200)`,
      "",
    ].join("\n"),
  )
  return child
}

async function startGuardedTopology(childExitCode: number | null) {
  const dir = mkdtempSync(join(tmpdir(), "oqa-serve-guard-"))
  const entry = { dir, pids: [] as number[] }
  tracked.push(entry)
  const child = writeChildFixture(dir, childExitCode)
  const script = [
    `. ${JSON.stringify(toBashPath(COMMON_SH))}`,
    `( oqa_guarded_spawn ${JSON.stringify(toBashPath(join(dir, "child.pid")))} ${JSON.stringify(process.execPath)} ${JSON.stringify(child)} ) &`,
    'wait "$!"',
    'echo "GUARD_EXIT $?"',
    "while :; do sleep 1; done",
  ].join("\n")
  const driver: ChildProcess = spawn(resolveBash(), ["-c", script], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  })
  entry.pids.push(driver.pid ?? 0)
  const seen = new Map<string, number>()
  let stderr = ""
  driver.stderr?.on("data", (chunk) => (stderr += String(chunk)))
  driver.stdout?.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const [label, value] = line.trim().split(" ")
      if (!label || value === undefined || !Number.isInteger(Number(value))) continue
      seen.set(label, Number(value))
      if (label !== "GUARD_EXIT") entry.pids.push(Number(value))
    }
  })
  const waitFor = async (labels: string[]) => {
    const deadline = Date.now() + LINE_TIMEOUT_MS
    while (!labels.every((label) => seen.has(label))) {
      if (Date.now() > deadline) {
        throw new Error(
          `waited ${LINE_TIMEOUT_MS}ms for ${labels.join(",")}; saw ${[...seen.keys()]}; stderr=${stderr}`,
        )
      }
      await Bun.sleep(25)
    }
  }
  await waitFor(["GUARD", "CHILD", "GRANDCHILD"])
  const pid = (label: string) => {
    const value = seen.get(label)
    if (value === undefined) throw new Error(`missing ${label}`)
    return value
  }
  return { driverPid: driver.pid ?? 0, pid, seen, waitFor }
}

afterEach(() => {
  for (const entry of tracked.splice(0)) {
    for (const pid of entry.pids) if (pid > 0) terminateTree(pid)
    rmSync(entry.dir, { recursive: true, force: true })
  }
})

describe("opencode-qa serve-guard", () => {
  describe("#given a bash driver whose guarded child spawned a grandchild", () => {
    it("#when only the driver is force-killed (its EXIT trap never runs) #then the guarded tree dies", async () => {
      // given
      const { driverPid, pid } = await startGuardedTopology(null)
      const guarded = [pid("GUARD"), pid("CHILD"), pid("GRANDCHILD")]

      // when
      process.kill(driverPid, "SIGKILL")

      // then
      expect(await waitForDeath(guarded)).toEqual([])
    })

    it(
      isWindows
        ? "#when only the guard is force-killed (TerminateProcess) #then the kill-on-close job takes the tree with it"
        : "#when only the guard receives SIGTERM #then it kills the child's process group",
      async () => {
        // given
        const { pid } = await startGuardedTopology(null)

        // when
        process.kill(pid("GUARD"), isWindows ? "SIGKILL" : "SIGTERM")

        // then
        expect(await waitForDeath([pid("GUARD"), pid("CHILD"), pid("GRANDCHILD")])).toEqual([])
      },
    )
  })

  describe("#given a guarded child that exits on its own", () => {
    it("#when it exits with a code #then the guard exits with the same code", async () => {
      // given
      const { seen, waitFor } = await startGuardedTopology(7)

      // when
      await waitFor(["GUARD_EXIT"])

      // then
      expect(seen.get("GUARD_EXIT")).toBe(7)
    })
  })
})
