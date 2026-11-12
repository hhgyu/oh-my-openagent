// One bound session's memory status snapshot (Senpi `omo.memory.status` / `omo.memory.updated`, schema
// version 1), from lock-free reads only: the session journal's `state.json` and a snapshot read of its
// transcript, never `state.lock` or the reflection scheduler lock. V2 carries the journal, reflection
// and sync blocks; Senpi's `repo` block (git head, dirty paths, sizes) and the reflection `activeRun` /
// `lastOutcome` fields are not produced (parity row P-22).

import { join } from "node:path"
import { countCompletedSteps, TranscriptJournal } from "@oh-my-opencode/memory-core"
import { readFile } from "@oh-my-opencode/memory-core/fs"
import type { BoundMemorySession } from "./binding"
import type { MemoryRpcSync } from "./sync/ports"

export interface MemoryStatusSnapshot {
  readonly schemaVersion: 1
  readonly identity: string
  readonly sessionID: string
  readonly journal: {
    readonly sessionId: string
    /** Completed answers in the session's durable journal; not a journal fsync fence. */
    readonly totalSteps: number
    readonly reflectedSteps: number
  }
  readonly reflection: {
    readonly backlogSteps: number
    readonly pendingCompaction: boolean
    readonly consecutiveFailures: number
    /** The session's newest successful reflection; omitted when none succeeded. */
    readonly lastConsolidationAtISO?: string
  }
  /** This device's sync state for the bound repo; omitted while the device does not sync it. */
  readonly sync?: MemoryRpcSync
}

const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

async function readJournalState(journalDir: string): Promise<Record<string, unknown>> {
  let raw: string
  try {
    raw = await readFile(join(journalDir, "state.json"), "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {}
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : {}
  } catch (error) {
    // A torn state.json under a concurrent atomic replace reads as empty; the next refresh sees the new one.
    if (error instanceof SyntaxError) return {}
    throw error
  }
}

export async function buildMemoryStatusSnapshot(bound: BoundMemorySession, sync: MemoryRpcSync | undefined): Promise<MemoryStatusSnapshot> {
  const journalDir = join(bound.paths.transcripts, bound.sessionID)
  const [state, entries] = await Promise.all([readJournalState(journalDir), new TranscriptJournal({ journalDir }).readEntriesSnapshot()])
  const totalSteps = Math.max(count(state.total_completed_steps), countCompletedSteps(entries))
  const reflectedSteps = Math.min(count(state.reflected_completed_steps), totalSteps)
  const succeededAt = typeof state.last_reflection_succeeded_at === "string" ? Date.parse(state.last_reflection_succeeded_at) : Number.NaN
  return {
    schemaVersion: 1,
    identity: bound.identity,
    sessionID: bound.sessionID,
    journal: { sessionId: bound.sessionID, totalSteps, reflectedSteps },
    reflection: {
      backlogSteps: Math.max(0, totalSteps - reflectedSteps),
      pendingCompaction: state.pending_compaction === true,
      consecutiveFailures: count(state.consecutive_failures),
      ...(Number.isNaN(succeededAt) ? {} : { lastConsolidationAtISO: new Date(succeededAt).toISOString() }),
    },
    ...(sync === undefined ? {} : { sync }),
  }
}
