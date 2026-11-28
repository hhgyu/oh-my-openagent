import path from "node:path"

import { readdir, readFile, stat, unlink, utimes, writeFile } from "../fs/resilient"
import { parseLockRecord, type LockRecord } from "./lock-record"
import { isLockOwnerProvenDead } from "./stale-owner"

// A waiting contender polls with backoff, so a holder that releases and asks again finds the lock free while the
// contender sleeps, and wins every time: the two-process writer test starved a writer for its whole 15 s budget.
// A contender that has to wait therefore leaves a ticket beside the lock (`<lock>.wait-<nonce>`), and a free lock
// is taken only by the contender with the oldest live ticket; an acquisition with no ticket yields to any. A
// ticket counts only while its owner is not proven dead and its own wait deadline (none for an unbounded wait)
// has not passed, so a crashed or abandoned waiter can delay nobody past the deadline it chose. Lock directories
// live under the identity runtime, outside the memory repository, and hold a handful of domain locks, so the scan
// is one small readdir. Tickets never end in `.lock` or carry `.candidate-`, so no sweep mistakes one for a lock;
// the dead-owner sweep reaps abandoned ones through `reapWaitTickets`.
//
// A ticket also counts only while its waiter keeps it fresh: every poll touches it, and one untouched for longer
// than TICKET_HEARTBEAT_STALE_MS is retired. Deleting a ticket can fail (Windows refuses while another handle on it
// denies delete sharing), and a ticket left behind by an acquisition that already finished, even one with no
// deadline and a live owner, must not block anyone: once its waiter stops touching it, it stops counting, and the
// next scan or sweep deletes it. In the process that failed to delete it, it stops counting at once.
const TICKET_MARKER = ".wait-"
const UNREADABLE_TICKET_GRACE_MS = 5_000
const TICKET_HEARTBEAT_STALE_MS = 3_000
const retiredTickets = new Set<string>()

export type WaitTicket = {
  readonly path: string
  readonly nonce: string
  readonly createdAtMs: number
}

type TicketFile = {
  readonly record: LockRecord
  readonly created_at_ms: number
  readonly expires_at_ms: number | null
}

type LiveTicket = { readonly nonce: string; readonly createdAtMs: number }

/** Registers a ticket that orders strictly after every live ticket seen so far (`notBeforeMs`). */
export async function registerWaitTicket(
  lockPath: string,
  record: LockRecord,
  deadlineMs: number,
  notBeforeMs: number,
): Promise<WaitTicket> {
  const createdAtMs = Math.max(Date.now(), notBeforeMs)
  // JSON has no Infinity: an unbounded wait is written as an explicit null deadline, never dropped.
  const file: TicketFile = {
    record,
    created_at_ms: createdAtMs,
    expires_at_ms: Number.isFinite(deadlineMs) ? deadlineMs : null,
  }
  const filePath = `${lockPath}${TICKET_MARKER}${record.nonce}`
  await writeFile(filePath, JSON.stringify(file), { flag: "w" })
  return { path: filePath, nonce: record.nonce, createdAtMs }
}

/** Deletes the ticket; one that cannot be deleted now is retired in this process and deleted by a later scan. */
export async function removeWaitTicket(ticket: WaitTicket): Promise<void> {
  try {
    await unlink(ticket.path)
  } catch (error) {
    if (errorCode(error) !== "ENOENT") retiredTickets.add(ticket.path)
  }
}

/** The waiter's heartbeat: a ticket it stops touching stops counting. */
export async function touchWaitTicket(ticket: WaitTicket): Promise<void> {
  const nowSeconds = Date.now() / 1000
  await utimes(ticket.path, nowSeconds, nowSeconds).catch(() => undefined)
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
}

async function deleteRetired(candidatePath: string): Promise<void> {
  try {
    await unlink(candidatePath)
    retiredTickets.delete(candidatePath)
  } catch (error) {
    if (errorCode(error) === "ENOENT") retiredTickets.delete(candidatePath)
  }
}

function parseTicket(raw: string): TicketFile | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    const record = parseLockRecord(JSON.stringify(value.record))
    const expires = value.expires_at_ms
    if (record === null || !Number.isFinite(value.created_at_ms)) return null
    if (expires !== null && !Number.isFinite(expires)) return null
    return {
      record,
      created_at_ms: Number(value.created_at_ms),
      expires_at_ms: expires === null ? null : Number(expires),
    }
  } catch {
    return null
  }
}

async function liveTickets(directory: string, now: number, lockName?: string): Promise<LiveTicket[]> {
  let names: readonly string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const live: LiveTicket[] = []
  for (const name of names) {
    const marker = name.lastIndexOf(TICKET_MARKER)
    if (marker <= 0) continue
    if (lockName !== undefined && name.slice(0, marker) !== lockName) continue
    const candidatePath = path.join(directory, name)
    if (retiredTickets.has(candidatePath)) {
      await deleteRetired(candidatePath)
      continue
    }
    const touchedAt = await stat(candidatePath).then(
      (status) => status.mtimeMs,
      () => undefined,
    )
    if (touchedAt === undefined) continue
    if (Date.now() - touchedAt > TICKET_HEARTBEAT_STALE_MS) {
      await unlink(candidatePath).catch(() => undefined)
      continue
    }
    const raw = await readFile(candidatePath, "utf8").catch(() => undefined)
    if (raw === undefined) continue
    const ticket = parseTicket(raw)
    if (ticket === null) {
      // A ticket still being written reads as partial JSON; only one that stays unreadable is removed.
      if (Date.now() - touchedAt > UNREADABLE_TICKET_GRACE_MS) await unlink(candidatePath).catch(() => undefined)
      continue
    }
    const expired = ticket.expires_at_ms !== null && ticket.expires_at_ms <= now
    if (expired || (await isLockOwnerProvenDead(ticket.record))) {
      await unlink(candidatePath).catch(() => undefined)
      continue
    }
    live.push({ nonce: name.slice(marker + TICKET_MARKER.length), createdAtMs: ticket.created_at_ms })
  }
  return live
}

function precedes(left: LiveTicket, right: LiveTicket): boolean {
  return left.createdAtMs < right.createdAtMs || (left.createdAtMs === right.createdAtMs && left.nonce < right.nonce)
}

/**
 * Whether another contender's live ticket is ahead of `own` (any live ticket when `own` is undefined), and the
 * newest live ticket's time, so a ticket registered next can order after it.
 */
export async function ticketsAhead(
  lockPath: string,
  own: WaitTicket | undefined,
  now: number,
): Promise<{ readonly ahead: boolean; readonly latestCreatedAtMs: number }> {
  const others = (await liveTickets(path.dirname(lockPath), now, path.basename(lockPath))).filter(
    (ticket) => ticket.nonce !== own?.nonce,
  )
  const latestCreatedAtMs = Math.max(0, ...others.map((ticket) => ticket.createdAtMs))
  const ahead = others.some((ticket) => own === undefined || precedes(ticket, own))
  return { ahead, latestCreatedAtMs }
}

/** Reaps the tickets in `lockDirectory` whose waiter is proven dead, past its deadline, or unreadable for good. */
export async function reapWaitTickets(lockDirectory: string, now: number = Date.now()): Promise<void> {
  await liveTickets(lockDirectory, now)
}
