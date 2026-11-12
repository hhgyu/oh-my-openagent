// Reclaims hidden memory children (facts, reflection) a dead host left behind. Every launch stages its
// child under a fresh custody key in a per-identity `children.sqlite`, so a host killed mid-run leaves a
// row under its dead owner that no later launch ever asks for, and the hidden child session stays in the
// host's session table. This pass lists the open rows of one backend and, per parent root session, uses
// the same takeover the owned session backend uses for task recovery: `recover` claims the row only when
// `probeJournalOwner` reports its owner dead (or released), then `close` interrupts, joins and removes the
// host child and writes the durable CLOSED row. A row whose host child is already gone is taken over
// through the same journal claim and closed in place. A live (or unverifiable) owner's row is left alone,
// as is anything this pass cannot prove.
//
// Scope generations are a per-instance counter, so a fresh scope's parent lease starts below the
// generation a dead host recorded, and `recover` may only move a locator's generation UP (the journal
// refuses a decrease). The reclaim scope therefore re-opens the parent until its lease generation
// reaches the highest stranded generation under that parent; each re-open replaces the lease.
//
// A reclaim that took custody and still failed is recorded once in `children-reclaim.json` (next to the
// journal) against the row's revision and is not retried until the row changes (a newer revision), so a
// child that cannot be reclaimed does not repeat the work on every reconcile.

import type { Context } from "@opencode/plugin/promise/plugin"
import { openChildJournal, type probeJournalOwner } from "../host/child-journal"
import { createSessionBackend, type ChildRecord, type SessionBackendApi } from "../host/session-backend"
import { createSessionScopes, type SessionLease, type SessionToolPolicy } from "../host/session-state"
import { describeError } from "./binding"
import { existsSync, readFile, rename, writeFile } from "@oh-my-opencode/memory-core/fs"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"

export interface MemoryChildReclaimReport {
  /** Host children interrupted, removed and closed. */
  readonly removed: readonly string[]
  /** Rows closed because their host child was already gone. */
  readonly closed: readonly string[]
  /** Rows left alone (live or unverifiable owner, or a failed step). */
  readonly left: readonly string[]
  /** Rows skipped because an earlier reclaim of the same revision already failed. */
  readonly skipped: readonly string[]
}

type ReclaimMemo = Record<string, { readonly revision: number; readonly reason: string; readonly at: string }>

const MEMO_FILE = "children-reclaim.json"

async function readMemo(path: string): Promise<ReclaimMemo> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ReclaimMemo) : {}
  } catch {
    return {}
  }
}

async function writeMemo(path: string, memo: ReclaimMemo): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(
    temp,
    `${JSON.stringify(memo, null, 2)}
`,
    { encoding: "utf8", mode: 0o600 },
  )
  await rename(temp, path)
}

const PARENT_POLICY: SessionToolPolicy = {
  tools: [],
  authorize: () => {
    throw new Error("The memory child reclaim parent scope grants no tools")
  },
}

/** Re-opens the parent until its lease generation is at least `minimum` (never lowers a locator). */
function openParentAtLeast(
  scopes: ReturnType<typeof createSessionScopes>,
  parentID: string,
  minimum: number,
): SessionLease {
  let lease = scopes.open(parentID as SessionLease["sessionID"], PARENT_POLICY)
  while (lease.generation < minimum) lease = scopes.open(parentID as SessionLease["sessionID"], PARENT_POLICY)
  return lease
}

export interface MemoryChildReclaimInput {
  readonly host: { readonly app: Context["app"]; readonly session: SessionBackendApi }
  readonly journalPath: string
  readonly warn: (message: string, details?: Record<string, unknown>) => void
  /** Trusted OS-probe port; production uses the journal's own process-identity probe. */
  readonly probeOwner?: typeof probeJournalOwner
}

interface MemoryChildBackend {
  readonly backendID: string
  /** The child's private tools (the reclaim scope's tool policy). */
  readonly toolNames: readonly string[]
  /** `facts`, `reflection`: used in warnings. */
  readonly label: string
}

export async function reclaimStrandedMemoryChildren(
  input: MemoryChildReclaimInput,
  kind: MemoryChildBackend,
): Promise<MemoryChildReclaimReport> {
  const report = { removed: [] as string[], closed: [] as string[], left: [] as string[], skipped: [] as string[] }
  if (!existsSync(input.journalPath)) return report
  const childPolicy: SessionToolPolicy = { tools: [...kind.toolNames], authorize: () => undefined }
  const journal = await openChildJournal({
    path: input.journalPath,
    ...(input.probeOwner === undefined ? {} : { probeOwner: input.probeOwner }),
  })
  const memoPath = join(dirname(input.journalPath), MEMO_FILE)
  const memo = await readMemo(memoPath)
  let memoChanged = false
  try {
    const open = (await journal.list()).filter(
      (record) =>
        record.phase !== "closed" && record.locator.backendID === kind.backendID && record.owner !== journal.owner,
    )
    const byParent = new Map<string, ChildRecord[]>()
    for (const record of open) {
      if (memo[record.key]?.revision === record.revision) {
        report.skipped.push(record.locator.sessionID)
        continue
      }
      byParent.set(record.locator.parentID, [...(byParent.get(record.locator.parentID) ?? []), record])
    }
    for (const [parentID, records] of byParent) {
      const location = records[0]?.locator.location
      if (location === undefined) continue
      const scopes = createSessionScopes()
      const failed: { readonly record: ChildRecord; readonly reason: string }[] = []
      const parent = openParentAtLeast(
        scopes,
        parentID,
        Math.max(...records.map((record) => record.locator.generation)),
      )
      const backend = createSessionBackend(
        { app: input.host.app, location: { directory: location }, session: input.host.session },
        {
          backendID: kind.backendID,
          owner: journal.owner,
          parent,
          scopes,
          policy: childPolicy,
          journal,
          gate: { assertActive() {} },
        },
      )
      try {
        const listed = new Set((await backend.list()).data.map((session) => session.id))
        for (const record of records) {
          const sessionID = record.locator.sessionID
          try {
            if (listed.has(sessionID)) {
              await backend.close(await backend.recover(record.key))
              report.removed.push(sessionID)
            } else {
              const claimed = await journal.claim(record.key, journal.owner)
              await journal.write(claimed, { ...claimed, phase: "closed", revision: claimed.revision + 1 })
              report.closed.push(sessionID)
            }
          } catch (error) {
            report.left.push(sessionID)
            failed.push({ record, reason: describeError(error) })
          }
        }
      } catch (error) {
        for (const record of records) report.left.push(record.locator.sessionID)
        input.warn(`stranded ${kind.label} children of a parent could not be listed`, {
          parentID,
          error: describeError(error),
        })
      } finally {
        await backend.dispose().catch((error: unknown) => {
          input.warn(`${kind.label} reclaim backend cleanup incomplete`, { parentID, error: describeError(error) })
        })
        scopes.dispose()
      }
      // Read after disposal, which may still advance the row. Only a row this pass took custody of
      // is recorded; a live owner's refusal leaves the row unchanged and is simply retried later.
      for (const { record, reason } of failed) {
        const after = await journal.read(record.key).catch(() => undefined)
        if (after === undefined || after.owner !== journal.owner || after.phase === "closed") continue
        memo[record.key] = { revision: after.revision, reason, at: new Date().toISOString() }
        memoChanged = true
        input.warn(`stranded ${kind.label} child could not be reclaimed; not retried until its custody changes`, {
          sessionID: record.locator.sessionID,
          error: reason,
        })
      }
    }
    for (const key of Object.keys(memo)) {
      if (!open.some((record) => record.key === key)) {
        Reflect.deleteProperty(memo, key)
        memoChanged = true
      }
    }
    if (memoChanged) await writeMemo(memoPath, memo)
  } finally {
    journal.close()
  }
  return report
}
