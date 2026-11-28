import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { acquireLock, createLockRecord, memoryWriterLockPath, releaseLock } from "./index"
import { sweepDeadOwnerLocks } from "./dead-owner-sweep"
import type { LockRecord } from "./lock-record"
import { reapWaitTickets, registerWaitTicket, ticketsAhead } from "./wait-tickets"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function lockPathInFreshDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "acquire-fair-handoff-"))
  temporaryDirectories.push(directory)
  return memoryWriterLockPath(directory)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe("a waiting contender and a holder that releases and re-acquires (fair handoff)", () => {
  test("#given a contender already waiting #when the holder releases and re-acquires at once #then the contender gets the lock first", async () => {
    // given: A holds; B waits and sleeps between polls (125-250 ms at this base delay)
    const lockPath = await lockPathInFreshDirectory()
    const holder = await createLockRecord("memory-write", { runId: "holder" })
    await acquireLock(lockPath, holder)
    const order: string[] = []
    const contender = await createLockRecord("memory-write", { runId: "contender" })
    const contended = acquireLock(lockPath, contender, { waitTimeoutMs: 10_000, retryDelayMs: 1_000 }).then(() => {
      order.push("contender acquired")
    })
    await sleep(80)

    // when: A releases and immediately asks for the lock again, while B is between polls
    await releaseLock(lockPath, holder)
    const reacquired = acquireLock(lockPath, holder, { waitTimeoutMs: 10_000, retryDelayMs: 5 }).then(() => {
      order.push("holder re-acquired")
    })
    await contended
    await releaseLock(lockPath, contender)
    await reacquired
    await releaseLock(lockPath, holder)

    // then
    expect(order).toEqual(["contender acquired", "holder re-acquired"])
    expect(await tickets(lockPath)).toEqual([])
  })

  test("#given a ticket whose waiter died #when a free lock is asked for #then it is taken at once and the ticket is removed", async () => {
    // given
    const lockPath = await lockPathInFreshDirectory()
    const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" })
    const dead = { ...(await createLockRecord("memory-write")), pid: exited.pid ?? 0, process_start: "unavailable" }
    await writeTicket(lockPath, dead, Date.now() + 60_000)

    // when
    const startedAt = Date.now()
    const record = await createLockRecord("memory-write")
    await acquireLock(lockPath, record, { waitTimeoutMs: 10_000, retryDelayMs: 5 })

    // then
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(await tickets(lockPath)).toEqual([])
    await releaseLock(lockPath, record)
  })

  test("#given a live waiter's ticket past its own deadline #when a free lock is asked for #then it is taken at once and the ticket is removed", async () => {
    // given
    const lockPath = await lockPathInFreshDirectory()
    await writeTicket(lockPath, await createLockRecord("memory-write"), Date.now() - 1)

    // when
    const record = await createLockRecord("memory-write")
    await acquireLock(lockPath, record, { waitTimeoutMs: 10_000, retryDelayMs: 5 })

    // then
    expect(await tickets(lockPath)).toEqual([])
    await releaseLock(lockPath, record)
  })

  test("#given a live waiter's ticket #when a no-wait attempt finds the lock free #then it still takes it, as a try-lock always has", async () => {
    // given
    const lockPath = await lockPathInFreshDirectory()
    await writeTicket(lockPath, await createLockRecord("memory-write"), Date.now() + 60_000)

    // when
    const record = await createLockRecord("memory-write")
    await acquireLock(lockPath, record)

    // then
    expect(await releaseLock(lockPath, record)).toBe(true)
  })

  test("#given a live waiter's ticket ahead #when a waiting acquisition finds the lock free #then it yields until that ticket is gone", async () => {
    // given
    const lockPath = await lockPathInFreshDirectory()
    const queued = await createLockRecord("memory-write")
    const ticketFile = await writeTicket(lockPath, queued, Date.now() + 60_000)
    let acquired = false
    const record = await createLockRecord("memory-write")
    const acquisition = acquireLock(lockPath, record, { waitTimeoutMs: 10_000, retryDelayMs: 5 }).then(() => {
      acquired = true
    })

    // when
    await sleep(300)
    const whileQueued = acquired
    await rm(ticketFile)
    await acquisition

    // then
    expect(whileQueued).toBe(false)
    expect(acquired).toBe(true)
    await releaseLock(lockPath, record)
  })
})

describe("wait tickets", () => {
  test("#given an unbounded wait #when its ticket is written #then the deadline is an explicit null and the ticket keeps counting", async () => {
    // given
    const lockPath = await lockPathInFreshDirectory()
    const record = await createLockRecord("memory-write")

    // when
    const ticket = await registerWaitTicket(lockPath, record, Number.POSITIVE_INFINITY, 0)
    await reapWaitTickets(path.dirname(lockPath), Date.now() + 24 * 60 * 60 * 1000)

    // then
    expect(JSON.parse(await readFile(ticket.path, "utf8")).expires_at_ms).toBeNull()
    expect((await ticketsAhead(lockPath, undefined, Date.now())).ahead).toBe(true)
    expect(await tickets(lockPath)).toEqual([path.basename(ticket.path)])
  })

  test("#given live, expired and dead waiters' tickets beside a lock #when the dead-owner sweep runs #then only the live ticket and the lock stay", async () => {
    // given
    const lockPath = await lockPathInFreshDirectory()
    const holder = await createLockRecord("memory-write")
    await acquireLock(lockPath, holder)
    const live = await writeTicket(lockPath, await createLockRecord("memory-write"), Date.now() + 60_000)
    await writeTicket(lockPath, await createLockRecord("memory-write"), Date.now() - 1)
    const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" })
    await writeTicket(
      lockPath,
      { ...(await createLockRecord("memory-write")), pid: exited.pid ?? 0, process_start: "unavailable" },
      Date.now() + 60_000,
    )

    // when
    await sweepDeadOwnerLocks(path.dirname(lockPath))

    // then
    expect((await readdir(path.dirname(lockPath))).sort()).toEqual(
      [path.basename(lockPath), path.basename(live)].sort(),
    )
    await releaseLock(lockPath, holder)
  })

  test("#given a newer live ticket than the clock #when the next ticket is registered after it #then it orders strictly behind", async () => {
    // given
    const lockPath = await lockPathInFreshDirectory()
    const ahead = await writeTicket(
      lockPath,
      await createLockRecord("memory-write"),
      Date.now() + 60_000,
      Date.now() + 10_000,
    )
    const seen = await ticketsAhead(lockPath, undefined, Date.now())

    // when
    const next = await registerWaitTicket(
      lockPath,
      await createLockRecord("memory-write"),
      Date.now() + 60_000,
      seen.latestCreatedAtMs + 1,
    )

    // then
    expect(next.createdAtMs).toBe(seen.latestCreatedAtMs + 1)
    expect((await ticketsAhead(lockPath, next, Date.now())).ahead).toBe(true)
    await rm(ahead)
    expect((await ticketsAhead(lockPath, next, Date.now())).ahead).toBe(false)
  })
})

async function tickets(lockPath: string): Promise<string[]> {
  return (await readdir(path.dirname(lockPath))).filter((name) => name.includes(".wait-"))
}

async function writeTicket(
  lockPath: string,
  record: LockRecord,
  expiresAtMs: number,
  createdAtMs = Date.now() - 1_000,
): Promise<string> {
  const ticketFile = `${lockPath}.wait-${record.nonce}`
  await writeFile(ticketFile, JSON.stringify({ record, created_at_ms: createdAtMs, expires_at_ms: expiresAtMs }))
  return ticketFile
}
