import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { defaultIsProcessAlive as isProcessAlive } from "./process-liveness"

// A process tree that never ends on its own. POSIX: the child ignores SIGTERM and starts a descendant that does
// too. Windows: the child is cmd.exe waiting on a Bun descendant; a Bun child would take its descendants down
// with its own job object, which would hide a missing tree kill.
const POSIX_WEDGED_CHILD = `
const { spawn } = require("node:child_process")
const { writeFileSync } = require("node:fs")
process.on("SIGTERM", () => {})
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e9)"], { stdio: "ignore" })
descendant.once("spawn", () => writeFileSync(process.argv[2], JSON.stringify({ child: process.pid, descendant: descendant.pid })))
setInterval(() => {}, 1e9)
`
const WINDOWS_WEDGED_DESCENDANT = `
require("node:fs").writeFileSync(process.argv[2], JSON.stringify({ child: process.ppid, descendant: process.pid }))
setInterval(() => {}, 1e9)
`

// A child that exits at once and leaves a descendant holding the stdio pipes it inherited, so the child's
// `close` never fires on its own. Windows: `cmd /c start /b`; POSIX: a detached-free spawn with inherited stdio.
const POSIX_ORPHANING_CHILD = `
const { spawn } = require("node:child_process")
const { writeFileSync } = require("node:fs")
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1e9)"], { stdio: "inherit" })
descendant.once("spawn", () => {
  writeFileSync(process.argv[2], JSON.stringify({ child: process.pid, descendant: descendant.pid }))
  descendant.unref()
  process.exit(0)
})
`

export interface WedgedTree {
  readonly command: string
  readonly args: readonly string[]
  readonly pids: () => Promise<{ readonly child: number; readonly descendant: number }>
}

export function createWedgedTrees(): {
  readonly tree: () => WedgedTree
  readonly orphaningTree: () => WedgedTree
  readonly dispose: () => void
} {
  const roots: string[] = []
  const started: number[] = []
  const windows = process.platform === "win32"
  const fixture = (posixChild: string, windowsArgs: (script: string, pidFile: string) => string[]): WedgedTree => {
    const root = mkdtempSync(join(tmpdir(), "wedged-tree-"))
    roots.push(root)
    const pidFile = join(root, "pids.json")
    const script = join(root, "wedged.cjs")
    writeFileSync(script, windows ? WINDOWS_WEDGED_DESCENDANT : posixChild)
    return {
      command: windows ? "cmd.exe" : process.execPath,
      args: windows ? windowsArgs(script, pidFile) : [script, pidFile],
      async pids() {
        while (!existsSync(pidFile)) await Bun.sleep(20)
        const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { child: number; descendant: number }
        started.push(pids.child, pids.descendant)
        return pids
      },
    }
  }
  return {
    tree: () => fixture(POSIX_WEDGED_CHILD, (script, pidFile) => ["/d", "/c", process.execPath, script, pidFile]),
    orphaningTree: () =>
      fixture(POSIX_ORPHANING_CHILD, (script, pidFile) => [
        "/d",
        "/c",
        "start",
        '""',
        "/b",
        process.execPath,
        script,
        pidFile,
      ]),
    dispose() {
      for (const pid of started.splice(0)) killIfPresent(pid)
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    },
  }
}

function killIfPresent(pid: number): void {
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // ESRCH: the process already exited.
    return
  }
}

async function stillAlive(pids: readonly number[]): Promise<number[]> {
  const verdicts = await Promise.all(pids.map((pid) => isProcessAlive(pid)))
  return pids.filter((_, index) => verdicts[index])
}

export async function aliveAfter(pids: readonly number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms
  let alive = await stillAlive(pids)
  while (alive.length > 0 && Date.now() < deadline) {
    await Bun.sleep(25)
    alive = await stillAlive(alive)
  }
  return alive
}
