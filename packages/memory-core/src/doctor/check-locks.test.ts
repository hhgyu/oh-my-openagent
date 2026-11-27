import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { createLockRecord } from "../locks"
import { checkLocks } from "./checks"

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function retainedSlot(childPid: number, supervisorPid: number): Promise<string> {
  const locks = await mkdtemp(path.join(tmpdir(), "check-locks-"))
  temporaryDirectories.push(locks)
  const record = await createLockRecord("reflection-run")
  await writeFile(
    path.join(locks, "reflection-run.slot-1.lock"),
    `${JSON.stringify({ ...record, pid: childPid, co_owner: { pid: supervisorPid, process_start: record.process_start } })}\n`,
  )
  return locks
}

test("#given a slot retained for an exited child whose supervisor still runs #when doctor checks locks #then it is not reported stale", async () => {
  const locks = await retainedSlot(1001, 1002)

  const check = await checkLocks({ isProcessAlive: (pid) => pid === 1002 }, locks)

  expect(check).toMatchObject({ name: "locks", level: "ok" })
})

test("#given a retained slot whose child and supervisor have both exited #when doctor checks locks #then it names both pids as stale", async () => {
  const locks = await retainedSlot(1001, 1002)

  const check = await checkLocks({ isProcessAlive: () => false }, locks)

  expect(check.level).toBe("warn")
  expect(check.detail).toContain("pid 1001 and pid 1002 are not running")
})
