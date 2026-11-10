import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, readdir, rm, unlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import * as resilientFs from "../fs/resilient"
import { sweepStaleLockCandidates } from "./candidate-sweep"
import { LOCK_DIRECTORY_SWEEP_INTERVAL_MS } from "./acquire"
import { sweepDeadOwnerLocks } from "./dead-owner-sweep"
import {
  LockContentionError,
  acquireLock,
  createLockRecord,
  memoryWriterLockPath,
  noticeLockPath,
  receiptsLockPath,
  releaseLock,
  setLockCandidateFsForTests,
} from "./index"
import type { LockRecord } from "./lock-record"
import { acquireWithoutDirectorySweep } from "./acquire-core"
import { readOwner } from "./lock-owner"
import { provenDeadTakeoverFor } from "./proven-dead-takeovers"
import { recoverStaleOwner } from "./stale-owner"

const temporaryDirectories: string[] = []
const restoreFilesystem: Array<() => void> = []

async function createLocksDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "dead-owner-reclaim-"))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  for (const restore of restoreFilesystem.splice(0).reverse()) restore()
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

/** A pid the kernel no longer knows: a child that has already exited and been reaped. */
function exitedPid(): number {
  const child = Bun.spawnSync([process.execPath, "-e", ""])
  if (child.exitCode !== 0 || child.pid === undefined) throw new Error("could not spawn a short-lived child")
  return child.pid
}

async function deadOwnerRecord(purpose: string): Promise<LockRecord> {
  return { ...(await createLockRecord(purpose)), pid: exitedPid(), process_start: "unavailable" }
}

async function writeRecord(lockPath: string, record: LockRecord): Promise<void> {
  await writeFile(lockPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

function countPublishAttempts(): { readonly names: () => readonly string[]; readonly restore: () => void } {
  const names: string[] = []
  const restore = setLockCandidateFsForTests({
    unlink: async (candidatePath) => {
      names.push(path.basename(candidatePath))
      await unlink(candidatePath).catch(() => {})
    },
  })
  return { names: () => names, restore }
}

describe("dead-owner lock reclaim", () => {
  async function disappearingPrimary() {
    const lockPath = path.join(await createLocksDirectory(), "primary.lock")
    const deadOwner = await deadOwnerRecord("memory-write")
    const contender = await createLockRecord("memory-write")
    await writeRecord(lockPath, deadOwner)
    const snapshot = await readOwner(lockPath)
    if (snapshot === null) throw new Error("missing primary fixture")
    return { lockPath, deadOwner, contender, snapshot }
  }

  function vanishAtFinalUnlink(lockPath: string, replacement?: LockRecord): () => number {
    const originalUnlink = resilientFs.unlink
    let calls = 0
    const intercepted = spyOn(resilientFs, "unlink").mockImplementation(async (candidate) => {
      if (String(candidate) === lockPath && calls++ === 0) {
        await unlink(lockPath)
        if (replacement !== undefined) {
          // The original unlink observed absence; a successor published before its caller resumed.
          try {
            await unlink(lockPath)
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
            await writeRecord(lockPath, replacement)
            throw error
          }
          throw new Error("expected missing primary")
        }
        return unlink(lockPath)
      }
      return originalUnlink(candidate)
    })
    restoreFilesystem.push(() => intercepted.mockRestore())
    return () => calls
  }

  test("#given the primary vanishes after the final recovery fence #when unlink sees ENOENT #then retry is allowed without takeover proof", async () => {
    const { lockPath, contender, snapshot } = await disappearingPrimary()
    const calls = vanishAtFinalUnlink(lockPath)

    let failure: unknown
    try {
      await recoverStaleOwner(lockPath, snapshot, contender, Date.now(), 5_000)
    } catch (error) { failure = error }

    expect(calls()).toBe(1)
    expect(existsSync(lockPath)).toBe(false)
    expect(existsSync(`${lockPath}.recovery`)).toBe(false)
    expect(provenDeadTakeoverFor(lockPath, contender.nonce)).toBeUndefined()
    expect(failure).toBeUndefined()
  })

  test("#given the primary vanishes at unlink #when a zero-wait contender acquires #then it republishes exclusively without unearned takeover proof", async () => {
    const { lockPath, contender } = await disappearingPrimary()
    const calls = vanishAtFinalUnlink(lockPath)

    let failure: unknown
    try {
      await acquireWithoutDirectorySweep(lockPath, contender, { waitTimeoutMs: 0 })
    } catch (error) { failure = error }

    expect(calls()).toBe(1)
    expect(existsSync(`${lockPath}.recovery`)).toBe(false)
    expect(provenDeadTakeoverFor(lockPath, contender.nonce)).toBeUndefined()
    expect(failure).toBeUndefined()
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(contender)
  })

  test("#given a live successor publishes after primary unlink sees ENOENT #when a zero-wait contender retries #then live custody stays intact and contention is typed", async () => {
    const { lockPath, contender } = await disappearingPrimary()
    const successor = await createLockRecord("memory-write")
    const calls = vanishAtFinalUnlink(lockPath, successor)

    let failure: unknown
    try {
      await acquireWithoutDirectorySweep(lockPath, contender, { waitTimeoutMs: 0 })
    } catch (error) { failure = error }

    expect(calls()).toBe(1)
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(successor)
    expect(provenDeadTakeoverFor(lockPath, contender.nonce)).toBeUndefined()
    expect(existsSync(`${lockPath}.recovery`)).toBe(false)
    expect(failure).toBeInstanceOf(LockContentionError)
  })

  test("#given final primary unlink fails with EACCES #when recovery runs #then the error propagates and neither custody nor proof is fabricated", async () => {
    const { lockPath, deadOwner, contender, snapshot } = await disappearingPrimary()
    const expected = Object.assign(new Error("injected EACCES"), { code: "EACCES" })
    const originalUnlink = resilientFs.unlink
    const intercepted = spyOn(resilientFs, "unlink").mockImplementation(async (candidate) => {
      if (String(candidate) === lockPath) throw expected
      return originalUnlink(candidate)
    })
    restoreFilesystem.push(() => intercepted.mockRestore())

    let failure: unknown
    try {
      await recoverStaleOwner(lockPath, snapshot, contender, Date.now(), 5_000)
    } catch (error) { failure = error }

    expect(failure).toBe(expected)
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(deadOwner)
    expect(existsSync(`${lockPath}.recovery`)).toBe(false)
    expect(provenDeadTakeoverFor(lockPath, contender.nonce)).toBeUndefined()
  })

  test("#given a public acquisition whose primary vanishes at unlink #when its directory sweep acquires #then no takeover proof is inherited", async () => {
    const { lockPath, contender } = await disappearingPrimary()
    const calls = vanishAtFinalUnlink(lockPath)

    await acquireLock(lockPath, contender, { waitTimeoutMs: 0 })

    expect(calls()).toBeGreaterThanOrEqual(1)
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(contender)
    expect(provenDeadTakeoverFor(lockPath, contender.nonce)).toBeUndefined()
    await releaseLock(lockPath, contender)
  })

  test("#given a primary disappears before the recovery current read #when public acquisition sweeps #then the existing absent-primary retry grants no proof", async () => {
    const { lockPath, contender } = await disappearingPrimary()
    const originalRead = resilientFs.readFile
    let reads = 0
    const intercepted = spyOn(resilientFs, "readFile").mockImplementation((async (candidate: string, ...rest: unknown[]) => {
      // Sweep's initial owner read, acquisition snapshot, then recovery's current-owner read.
      if (String(candidate) === lockPath && ++reads === 3) await unlink(lockPath)
      return (originalRead as (...args: unknown[]) => unknown)(candidate, ...rest)
    }) as typeof resilientFs.readFile)
    restoreFilesystem.push(() => intercepted.mockRestore())

    await acquireLock(lockPath, contender, { waitTimeoutMs: 0 })

    expect(reads).toBeGreaterThanOrEqual(3)
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(contender)
    expect(provenDeadTakeoverFor(lockPath, contender.nonce)).toBeUndefined()
    await releaseLock(lockPath, contender)
  })

  test("#given the initially scanned dead owner is replaced by another dead owner #when the sweep removes the actual owner #then public proof names that actual owner", async () => {
    const { lockPath, contender } = await disappearingPrimary()
    const actualOwner = await deadOwnerRecord("memory-write")
    const originalRead = resilientFs.readFile
    let reads = 0
    const intercepted = spyOn(resilientFs, "readFile").mockImplementation((async (candidate: string, ...rest: unknown[]) => {
      if (String(candidate) === lockPath && ++reads === 2) await writeRecord(lockPath, actualOwner)
      return (originalRead as (...args: unknown[]) => unknown)(candidate, ...rest)
    }) as typeof resilientFs.readFile)
    restoreFilesystem.push(() => intercepted.mockRestore())

    await acquireLock(lockPath, contender, { waitTimeoutMs: 0 })

    expect(provenDeadTakeoverFor(lockPath, contender.nonce)).toEqual(actualOwner)
    await releaseLock(lockPath, contender)
  })

  test("#given a dead primary actually removed by the sweep #when public acquisition succeeds #then only its nonce inherits the actual owner proof and release clears it", async () => {
    const { lockPath, contender, deadOwner } = await disappearingPrimary()

    await acquireLock(lockPath, contender, { waitTimeoutMs: 0 })

    expect(provenDeadTakeoverFor(lockPath, contender.nonce)).toEqual(deadOwner)
    expect(provenDeadTakeoverFor(lockPath, randomUUID())).toBeUndefined()
    expect(await releaseLock(lockPath, contender)).toBe(true)
    expect(provenDeadTakeoverFor(lockPath, contender.nonce)).toBeUndefined()
  })

  test("#given a live successor publishes after the missing unlink #when public acquisition sweeps and retries #then live custody and no-proof refusal survive", async () => {
    const { lockPath, contender } = await disappearingPrimary()
    const successor = await createLockRecord("memory-write")
    vanishAtFinalUnlink(lockPath, successor)

    let failure: unknown
    try { await acquireLock(lockPath, contender, { waitTimeoutMs: 0 }) } catch (error) { failure = error }

    expect(failure).toBeInstanceOf(LockContentionError)
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(successor)
    expect(provenDeadTakeoverFor(lockPath, contender.nonce)).toBeUndefined()
  })

  test.each([false, true])("#given an intervening publisher remains=%s #when public acquisition loses its publish after a real takeover #then no proof crosses that publisher", async (remains) => {
    const { lockPath, contender } = await disappearingPrimary()
    const successor = await createLockRecord("memory-write")
    const realLink = resilientFs.link
    let publications = 0
    const restore = setLockCandidateFsForTests({ link: async (from, to) => {
      if (String(to) === lockPath && publications++ === 1) {
        await writeRecord(lockPath, successor)
        try { await realLink(from, to) } catch (error) {
          if (!remains) await unlink(lockPath)
          throw error
        }
        throw new Error("expected lost exclusive publish")
      }
      await realLink(from, to)
    } })
    restoreFilesystem.push(restore)

    let failure: unknown
    try { await acquireLock(lockPath, contender, { waitTimeoutMs: 0 }) } catch (error) { failure = error }

    expect(publications).toBeGreaterThanOrEqual(2)
    expect(provenDeadTakeoverFor(lockPath, contender.nonce)).toBeUndefined()
    if (remains) {
      expect(failure).toBeInstanceOf(LockContentionError)
      expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(successor)
    } else {
      expect(failure).toBeUndefined()
      expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(contender)
      await releaseLock(lockPath, contender)
    }
  })

  test("#given a sweeper's own release loses the primary #when release returns false #then no reclaim count or callback is fabricated", async () => {
    const { lockPath } = await disappearingPrimary()
    const originalUnlink = resilientFs.unlink
    const callbacks: LockRecord[] = []
    let calls = 0
    const intercepted = spyOn(resilientFs, "unlink").mockImplementation(async (candidate) => {
      if (String(candidate) === lockPath && ++calls === 2) {
        await unlink(lockPath)
        return unlink(lockPath)
      }
      return originalUnlink(candidate)
    })
    restoreFilesystem.push(() => intercepted.mockRestore())

    const reclaimed = await sweepDeadOwnerLocks(path.dirname(lockPath), { onReclaimed: (_path, owner) => callbacks.push(owner) })

    expect(calls).toBe(2)
    expect(existsSync(lockPath)).toBe(false)
    expect(reclaimed).toBe(0)
    expect(callbacks).toEqual([])
  })

  test("#given recovery nonce custody changes after publication #when the final fence reads it #then primary and replacement recovery custody stay intact", async () => {
    const { lockPath, contender, deadOwner, snapshot } = await disappearingPrimary()
    const replacement = await createLockRecord("memory-write:recovery")
    const recoveryPath = `${lockPath}.recovery`
    const originalRead = resilientFs.readFile
    let reads = 0
    const intercepted = spyOn(resilientFs, "readFile").mockImplementation((async (candidate: string, ...rest: unknown[]) => {
      if (String(candidate) === recoveryPath && ++reads === 2) await writeRecord(recoveryPath, replacement)
      return (originalRead as (...args: unknown[]) => unknown)(candidate, ...rest)
    }) as typeof resilientFs.readFile)
    restoreFilesystem.push(() => intercepted.mockRestore())

    expect(await recoverStaleOwner(lockPath, snapshot, contender, Date.now(), 5_000)).toBe(false)
    expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(deadOwner)
    expect(JSON.parse(await readFile(recoveryPath, "utf8"))).toEqual(replacement)
    expect(provenDeadTakeoverFor(lockPath, contender.nonce)).toBeUndefined()
  })

  test("#given a dead primary owner and a live recovery holder #when six contenders wait #then none publishes a candidate", async () => {
    // #given
    const lockPath = memoryWriterLockPath(await createLocksDirectory())
    await writeRecord(lockPath, await deadOwnerRecord("memory-write"))
    const recoveryHolder = await createLockRecord("memory-write:recovery")
    await writeRecord(`${lockPath}.recovery`, recoveryHolder)
    const publishes = countPublishAttempts()

    // #when
    try {
      const contenders = await Promise.allSettled(
        Array.from({ length: 6 }, async (_, index) =>
          acquireLock(lockPath, await createLockRecord("memory-write", { runId: `c${index}` }), { waitTimeoutMs: 300, retryDelayMs: 10 }),
        ),
      )

      // #then
      // Every tick used to run create+write+fsync+link+unlink on the recovery path while a live
      // owner visibly held it: about 40 publishes per second per waiter.
      expect(contenders.every((result) => result.status === "rejected" && result.reason instanceof LockContentionError)).toBe(true)
      expect(publishes.names()).toEqual([])
    } finally {
      publishes.restore()
    }
  })

  test("#given locks left by crashed and live owners #when the directory is swept #then only proven-dead owners are reclaimed", async () => {
    // #given
    const locksDirectory = await createLocksDirectory()
    const crashed = receiptsLockPath(locksDirectory)
    const crashedWithRecovery = noticeLockPath(locksDirectory)
    const live = memoryWriterLockPath(locksDirectory)
    const unparsable = path.join(locksDirectory, "half-written.lock")
    await writeRecord(crashed, await deadOwnerRecord("receipts"))
    await writeRecord(crashedWithRecovery, await deadOwnerRecord("notice"))
    await writeRecord(`${crashedWithRecovery}.recovery`, await deadOwnerRecord("notice:recovery"))
    const liveOwner = await createLockRecord("memory-write")
    await writeRecord(live, liveOwner)
    await writeFile(unparsable, "{\"pid\":", { mode: 0o600 })

    // #when
    const reclaimed = await sweepDeadOwnerLocks(locksDirectory)

    // #then
    expect(reclaimed).toBe(2)
    expect((await readdir(locksDirectory)).sort()).toEqual([path.basename(unparsable), path.basename(live)].sort())
    await releaseLock(live, liveOwner)
  })

  test("#given a crashed owner's lock #when the process first takes any lock in that directory #then the dead lock is gone", async () => {
    // #given
    const locksDirectory = await createLocksDirectory()
    const crashed = receiptsLockPath(locksDirectory)
    await writeRecord(crashed, await deadOwnerRecord("receipts"))

    // #when
    const holder = await createLockRecord("memory-write")
    await acquireLock(memoryWriterLockPath(locksDirectory), holder)

    // #then
    expect(await readdir(locksDirectory)).toEqual([path.basename(memoryWriterLockPath(locksDirectory))])
    await releaseLock(memoryWriterLockPath(locksDirectory), holder)
  })

  test("#given a process that already swept a directory #when a crashed owner leaves a lock later #then the next sweep after the interval reclaims it", async () => {
    // #given
    const locksDirectory = await createLocksDirectory()
    const writer = memoryWriterLockPath(locksDirectory)
    const crashed = receiptsLockPath(locksDirectory)
    const start = Date.now()
    const holder = await createLockRecord("memory-write")
    await acquireLock(writer, holder, { now: () => start })
    await releaseLock(writer, holder)
    await writeRecord(crashed, await deadOwnerRecord("receipts"))

    // #when
    await acquireLock(writer, holder, { now: () => start + 60_000 })
    await releaseLock(writer, holder)
    const beforeInterval = await readdir(locksDirectory)
    await acquireLock(writer, holder, { now: () => start + LOCK_DIRECTORY_SWEEP_INTERVAL_MS })
    await releaseLock(writer, holder)

    // #then
    expect(beforeInterval).toEqual([path.basename(crashed)])
    expect(await readdir(locksDirectory)).toEqual([])
  })

  test("#given an unreadable lock before a crashed owner's lock #when the directory is swept #then the dead lock is still reclaimed and the failure is reported", async () => {
    // #given
    const locksDirectory = await createLocksDirectory()
    const unreadable = path.join(locksDirectory, "a-unreadable.lock")
    const crashed = path.join(locksDirectory, "b-crashed.lock")
    await writeRecord(unreadable, await deadOwnerRecord("unreadable"))
    await writeRecord(crashed, await deadOwnerRecord("crashed"))
    const realReadFile = resilientFs.readFile
    const readFailure = spyOn(resilientFs, "readFile").mockImplementation(((filePath: string, ...rest: unknown[]) => {
      if (String(filePath) === unreadable) return Promise.reject(Object.assign(new Error("permission denied"), { code: "EACCES" }))
      return (realReadFile as (...args: unknown[]) => unknown)(filePath, ...rest)
    }) as typeof resilientFs.readFile)
    const failures: string[] = []

    // #when
    let reclaimed: number
    try {
      reclaimed = await sweepDeadOwnerLocks(locksDirectory, { onFailure: (lockPath) => failures.push(path.basename(lockPath)) })
    } finally {
      readFailure.mockRestore()
    }

    // #then
    expect(reclaimed).toBe(1)
    expect(failures).toEqual([path.basename(unreadable)])
    expect(await readdir(locksDirectory)).toEqual([path.basename(unreadable)])
  })

  test("#given leaked candidates #when swept #then a dead process's candidate goes at once and a live one's young candidate stays", async () => {
    // #given
    const locksDirectory = await createLocksDirectory()
    const lockPath = receiptsLockPath(locksDirectory)
    const dead = `${lockPath}.candidate-${exitedPid()}-${randomUUID()}`
    const live = `${lockPath}.candidate-${process.pid}-${randomUUID()}`
    const legacy = `${lockPath}.candidate-${randomUUID()}`
    const legacyOld = `${lockPath}.candidate-${randomUUID()}`
    for (const candidate of [dead, live, legacy, legacyOld]) await writeFile(candidate, "{}\n")
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(legacyOld, twoHoursAgo, twoHoursAgo)

    // #when
    const swept = await sweepStaleLockCandidates(locksDirectory)

    // #then
    expect(swept).toBe(2)
    expect((await readdir(locksDirectory)).sort()).toEqual([path.basename(legacy), path.basename(live)].sort())
  })

  test("#given a publish #when it creates its candidate #then the candidate name carries this process's pid", async () => {
    // #given
    const lockPath = receiptsLockPath(await createLocksDirectory())
    const publishes = countPublishAttempts()
    const holder = await createLockRecord("receipts")

    // #when
    try {
      await acquireLock(lockPath, holder)
    } finally {
      publishes.restore()
    }

    // #then
    expect(publishes.names()).toHaveLength(1)
    expect(publishes.names()[0]).toStartWith(`${path.basename(lockPath)}.candidate-${process.pid}-`)
    await releaseLock(lockPath, holder)
  })
})
