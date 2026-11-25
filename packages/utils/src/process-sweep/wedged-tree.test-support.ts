import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

export interface WedgedTree {
  readonly command: string
  readonly args: readonly string[]
  readonly pids: () => Promise<{ readonly child: number; readonly descendant: number }>
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function createWedgedTrees(): { readonly tree: () => WedgedTree; readonly dispose: () => void } {
  const roots: string[] = []
  const started: number[] = []
  return {
    tree() {
      const root = mkdtempSync(join(tmpdir(), "wedged-tree-"))
      roots.push(root)
      const pidFile = join(root, "pids.json")
      const script = join(root, "wedged.cjs")
      const windows = process.platform === "win32"
      writeFileSync(script, windows ? WINDOWS_WEDGED_DESCENDANT : POSIX_WEDGED_CHILD)
      return {
        command: windows ? "cmd.exe" : process.execPath,
        args: windows ? ["/d", "/c", process.execPath, script, pidFile] : [script, pidFile],
        async pids() {
          while (!existsSync(pidFile)) await Bun.sleep(20)
          const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { child: number; descendant: number }
          started.push(pids.child, pids.descendant)
          return pids
        },
      }
    },
    dispose() {
      for (const pid of started.splice(0)) if (isProcessAlive(pid)) process.kill(pid, "SIGKILL")
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    },
  }
}

export async function aliveAfter(pids: readonly number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms
  let alive = pids.filter(isProcessAlive)
  while (alive.length > 0 && Date.now() < deadline) {
    await Bun.sleep(25)
    alive = alive.filter(isProcessAlive)
  }
  return alive
}
