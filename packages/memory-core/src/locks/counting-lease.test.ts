import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import * as resilientFs from "../fs/resilient"
import { countingLeaseLockPath } from "./counting-lease"
import { LockContentionError, acquireLock, acquireReflectionRunLease, createLockRecord } from "./index"

const temporaryDirectories: string[] = []
const restores: Array<() => void> = []

afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore()
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function locksDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "counting-lease-"))
  temporaryDirectories.push(directory)
  return directory
}

/** A pid the kernel no longer knows: a child that has already exited and been reaped. */
function exitedPid(): number {
  const child = Bun.spawnSync([process.execPath, "-e", ""])
  if (child.exitCode !== 0 || child.pid === undefined) throw new Error("could not spawn a short-lived child")
  return child.pid
}

test("#given a slot retained for a child that has exited #when the queue head contends while the retaining supervisor lives #then the slot is not reclaimed and only the supervisor removes it", async () => {
  // given
  const locks = await locksDirectory()
  const lease = await acquireReflectionRunLease(locks)
  const lockPath = countingLeaseLockPath(locks, "reflection-run", lease.slot)
  await lease.retainFor(exitedPid(), null)
  const retained = await readFile(lockPath, "utf8")
  const queueHead = await createLockRecord("reflection-run")

  // when
  const contention = await acquireLock(lockPath, queueHead, { waitTimeoutMs: 0 }).catch((error: unknown) => error)

  // then
  expect(contention).toBeInstanceOf(LockContentionError)
  expect(await readFile(lockPath, "utf8")).toBe(retained)
  expect(await lease.release()).toBe(true)
  await acquireLock(lockPath, queueHead, { waitTimeoutMs: 0 })
  expect(JSON.parse(await readFile(lockPath, "utf8")).nonce).toBe(queueHead.nonce)
})

test("#given a retained slot whose child and supervisor have both exited #when the queue head contends #then it reclaims the slot", async () => {
  // given
  const locks = await locksDirectory()
  const lockPath = countingLeaseLockPath(locks, "reflection-run", 1)
  const supervisor = await createLockRecord("reflection-run")
  await writeFile(
    lockPath,
    `${JSON.stringify({
      ...supervisor,
      pid: exitedPid(),
      process_start: "unavailable",
      co_owner: { pid: exitedPid(), process_start: supervisor.process_start },
    })}\n`,
  )
  const queueHead = await createLockRecord("reflection-run")

  // when
  await acquireLock(lockPath, queueHead, { waitTimeoutMs: 0 })

  // then
  expect(JSON.parse(await readFile(lockPath, "utf8")).nonce).toBe(queueHead.nonce)
})

test("#given a released lease whose slot a successor now holds #when the supervisor's exit handler runs releaseSync #then it does not read the slot and the successor's lock survives", async () => {
  // given
  const locks = await locksDirectory()
  const lease = await acquireReflectionRunLease(locks)
  expect(await lease.release()).toBe(true)
  const successor = await acquireReflectionRunLease(locks)
  const lockPath = countingLeaseLockPath(locks, "reflection-run", successor.slot)
  const before = await readFile(lockPath, "utf8")
  const spy = spyOn(resilientFs, "readFileSync")
  restores.push(() => spy.mockRestore())

  // when
  const removed = lease.releaseSync()

  // then
  expect(removed).toBe(false)
  expect(spy).not.toHaveBeenCalledWith(lockPath, "utf8")
  expect(await readFile(lockPath, "utf8")).toBe(before)
  expect(await successor.release()).toBe(true)
})
