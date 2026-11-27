import { afterEach, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"

import { defaultIsProcessAlive } from "./exec"

// The parent forks a child that exits at once, then blocks in waitid(WEXITED | WNOWAIT): it returns only
// once the child is a zombie and leaves it unreaped. The parent prints the pid after that, and stays until
// its stdin closes, so the zombie exists exactly while the test reads it.
const NON_REAPING_PARENT = `
import os, sys
child = os.fork()
if child == 0:
    os._exit(0)
os.waitid(os.P_PID, child, os.WEXITED | os.WNOWAIT)
sys.stdout.write(f"{child}\\n")
sys.stdout.flush()
sys.stdin.read()
`

const groups: number[] = []

afterEach(() => {
  for (const group of groups.splice(0)) {
    try {
      process.kill(-group, "SIGKILL")
    } catch {
      // ESRCH: the parent already exited and init reaped the zombie.
      continue
    }
  }
})

async function startUnreapedZombie(): Promise<{ readonly parent: number; readonly zombie: number }> {
  const parent = spawn("python3", ["-c", NON_REAPING_PARENT], { detached: true, stdio: ["pipe", "pipe", "inherit"] })
  if (parent.pid !== undefined) groups.push(parent.pid)
  const line = await new Promise<string>((resolve, reject) => {
    let buffered = ""
    parent.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8")
      if (buffered.includes("\n")) resolve(buffered.slice(0, buffered.indexOf("\n")))
    })
    parent.once("error", reject)
    parent.once("exit", (code, signal) => reject(new Error(`zombie parent exited early: ${code ?? signal}`)))
  })
  return { parent: parent.pid ?? 0, zombie: Number(line) }
}

describe("defaultIsProcessAlive", () => {
  // Windows is not applicable: kill(pid, 0) already fails there once a process stopped running.
  test.skipIf(process.platform === "win32")(
    "#given a POSIX child that exited and whose parent never reaps it #when liveness is checked #then the zombie counts as dead and its parent as alive",
    async () => {
      // given
      const { parent, zombie } = await startUnreapedZombie()

      // when
      const zombieAlive = defaultIsProcessAlive(zombie)
      const parentAlive = defaultIsProcessAlive(parent)

      // then
      expect(zombieAlive).toBe(false)
      expect(parentAlive).toBe(true)
    },
  )
})
