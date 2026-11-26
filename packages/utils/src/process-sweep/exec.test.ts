import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"

import { defaultIsProcessAlive } from "./exec"

const parents: ChildProcess[] = []

afterEach(() => {
  for (const parent of parents.splice(0)) parent.kill("SIGKILL")
})

function procField(pid: number, read: (stat: string) => string): string | null {
  try {
    return read(readFileSync(`/proc/${pid}/stat`, "utf8"))
  } catch {
    return null
  }
}

const procState = (pid: number): string | null => procField(pid, (stat) => stat.charAt(stat.lastIndexOf(")") + 2))
const procComm = (pid: number): string | null =>
  procField(pid, (stat) => stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")))

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(10)
  }
}

// A zombie needs a parent that never waits: `sh` starts the background child, then becomes `sleep` by exec.
async function startNonReapingParent(): Promise<{ readonly parent: number; readonly child: number }> {
  const parent = spawn("/bin/sh", ["-c", "sleep 600 & echo $!; exec sleep 600"], {
    stdio: ["ignore", "pipe", "ignore"],
  })
  parents.push(parent)
  const firstLine = await new Promise<string>((resolve, reject) => {
    let buffered = ""
    parent.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8")
      if (buffered.includes("\n")) resolve(buffered.split("\n")[0] ?? "")
    })
    parent.once("error", reject)
  })
  const parentPid = parent.pid ?? 0
  await until(() => procComm(parentPid) === "sleep", "the parent to exec sleep")
  return { parent: parentPid, child: Number(firstLine.trim()) }
}

describe("defaultIsProcessAlive", () => {
  test.skipIf(process.platform !== "linux")(
    "#given a child killed while its parent never reaps it #when liveness is checked #then the zombie counts as dead",
    async () => {
      // given
      const { child } = await startNonReapingParent()
      expect(defaultIsProcessAlive(child)).toBe(true)
      process.kill(child, "SIGKILL")
      await until(() => procState(child) === "Z", "the child to become a zombie")

      // when
      const alive = defaultIsProcessAlive(child)

      // then
      expect(alive).toBe(false)
    },
  )
})
