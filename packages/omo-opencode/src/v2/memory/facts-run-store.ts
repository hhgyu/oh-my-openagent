// Durable facts run directories, the Native layout (`<identity facts>/runs/facts-<digest>-<attempt>/`):
// `ledger.json` (batch id, claim, owner, queued endpoints, apply recovery), `facts-payload.json`,
// `extraction.jsonl` (the child's `record_fact` lines), `outcome.json` (how the child settled) and a
// terminal sentinel (`final.json` or `abandoned.json`). Reservation runs under `facts-runs.lock`.
//
// THE TERMINAL ORDERING IS THE CONTRACT (omo-senpi `facts-terminal-writes.ts`): the failure record
// lands BEFORE the sentinel, keyed on the ledger's per-launch `batchId`, so a crash in between replays
// idempotently instead of losing the streak increment. Success consumes the batch, then clears its
// failure history, then writes the sentinel. The conversation-bearing payload and extraction are
// removed only once the run is durably terminal.

import { createHash, randomUUID } from "node:crypto"
import { basename, join } from "node:path"
import {
  createLockRecord, factsRunsLockPath, withLock,
  type FactsApplyRecovery, type FactsFailureReason, type FactsFailureStore, type FactsFailureTarget, type FactsQueue, type FactsQueueEntry,
} from "@oh-my-opencode/memory-core"
import { existsSync, mkdir, readdir, readFile, rename, rm, writeFile } from "@oh-my-opencode/memory-core/fs"

export const FACTS_PAYLOAD_FILE = "facts-payload.json"
export const FACTS_EXTRACTION_FILE = "extraction.jsonl"
const LEDGER_FILE = "ledger.json"
const OUTCOME_FILE = "outcome.json"
const FINAL_FILE = "final.json"
const ABANDONED_FILE = "abandoned.json"

interface FactsQueuedKey {
  readonly conversationId: string
  readonly end_message_id: string
  readonly end_snapshot_line: number
}

export interface FactsRunLedger {
  readonly version: 1
  readonly runId: string
  readonly kind: "facts"
  readonly startedAt: string
  /** After this instant a run whose owner is still alive is treated as stranded. */
  readonly hardDeadlineAt: number
  readonly batchId: string
  readonly claimId: string
  /** The component instance that launched it; a different live instance never finalizes it early. */
  readonly owner: string
  readonly pid: number
  readonly processStart: string | null
  readonly queued: readonly FactsQueuedKey[]
  readonly model?: string
  readonly applyRecovery?: FactsApplyRecovery
}

export interface FactsRunOutcome {
  readonly version: 1
  readonly runId: string
  readonly status: "completed" | "failed" | "deadline" | "cancelled"
  readonly detail?: string
  readonly finishedAt: string
}

export type FactsRunTerminal = "committed" | "no_facts" | "failed" | "parent_dirty"

function queueKeys(entries: readonly FactsQueueEntry[]): FactsQueuedKey[] {
  return entries.map(entry => ({ conversationId: entry.conversationId, end_message_id: entry.range.end_message_id, end_snapshot_line: entry.range.end_snapshot_line }))
}

export function queueTargets(entries: readonly FactsQueueEntry[]): FactsFailureTarget[] {
  return entries.map(entry => ({ conversationId: entry.conversationId, endMessageId: entry.range.end_message_id, endSnapshotLine: entry.range.end_snapshot_line }))
}

function ledgerTargets(queued: readonly FactsQueuedKey[]): FactsFailureTarget[] {
  return queued.map(key => ({ conversationId: key.conversationId, endMessageId: key.end_message_id, endSnapshotLine: key.end_snapshot_line }))
}

export async function readRunJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T
}

export async function writeRunJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  await rename(temp, path)
}

export const ledgerPath = (runDir: string): string => join(runDir, LEDGER_FILE)
export const outcomePath = (runDir: string): string => join(runDir, OUTCOME_FILE)

function isTerminalRun(runDir: string): boolean {
  return existsSync(join(runDir, FINAL_FILE)) || existsSync(join(runDir, ABANDONED_FILE))
}

/** Run directories that hold a ledger and no terminal sentinel, oldest name first. */
export async function openFactsRuns(factsDir: string): Promise<string[]> {
  const runsDir = join(factsDir, "runs")
  const names = await readdir(runsDir).catch(() => [] as string[])
  return names.filter(name => name.startsWith("facts-")).sort().map(name => join(runsDir, name))
    .filter(runDir => existsSync(ledgerPath(runDir)) && !isTerminalRun(runDir))
}

/** Reserves the next free `facts-<digest>-<attempt>` dir and writes its ledger, under `facts-runs.lock`. */
export async function reserveFactsRunDir(input: {
  readonly factsDir: string
  readonly locksDir: string
  readonly entries: readonly FactsQueueEntry[]
  readonly ledger: Omit<FactsRunLedger, "version" | "runId" | "kind" | "queued">
}): Promise<string | undefined> {
  const record = await createLockRecord("facts-runs", { runId: input.ledger.batchId })
  return withLock(factsRunsLockPath(input.locksDir), record, async () => {
    const runsDir = join(input.factsDir, "runs")
    await mkdir(runsDir, { recursive: true, mode: 0o700 })
    const queued = queueKeys(input.entries)
    const digest = createHash("sha256").update(JSON.stringify(queued)).digest("hex").slice(0, 12)
    const pattern = new RegExp(`^(?:\\.prune-)?facts-${digest}-(\\d+)(?:-|$)`)
    const names = await readdir(runsDir).catch(() => [] as string[])
    let attempt = 1
    for (const name of names) {
      const found = Number(pattern.exec(name)?.[1] ?? Number.NaN)
      if (Number.isInteger(found) && found >= attempt) attempt = found + 1
    }
    for (const name of names) {
      const runDir = join(runsDir, name)
      if (pattern.test(name) && !isTerminalRun(runDir)) return undefined
    }
    const runDir = join(runsDir, `facts-${digest}-${attempt}`)
    await mkdir(runDir, { mode: 0o700 })
    const ledger: FactsRunLedger = { version: 1, runId: basename(runDir), kind: "facts", queued, ...input.ledger }
    await writeRunJson(ledgerPath(runDir), ledger)
    return runDir
  }, { waitTimeoutMs: 2_000 })
}

interface FactsTerminalDeps {
  readonly queue: FactsQueue
  readonly failures: Pick<FactsFailureStore, "recordFailure" | "clearOnSuccess">
  readonly now: () => Date
  readonly warn: (message: string, details?: Record<string, unknown>) => void
}

/** Ordered terminal writes for one run (see the header). Every write is a no-op on a terminal run. */
export function createFactsTerminal(deps: FactsTerminalDeps) {
  async function sentinel(runDir: string, file: string, value: Record<string, unknown>): Promise<void> {
    await writeRunJson(join(runDir, file), { version: 1, runId: basename(runDir), at: deps.now().toISOString(), ...value })
    for (const disposable of [FACTS_PAYLOAD_FILE, FACTS_EXTRACTION_FILE]) {
      await rm(join(runDir, disposable), { force: true }).catch((error: unknown) => {
        deps.warn("facts run artifact survived its terminal sentinel", { runDir, file: disposable, error: String(error) })
      })
    }
  }

  return {
    async fail(runDir: string, ledger: FactsRunLedger, reason: FactsFailureReason, detail: string, outcome: "failed" | "parent_dirty" = "failed"): Promise<void> {
      if (isTerminalRun(runDir)) return
      const targets = ledgerTargets(ledger.queued)
      if (targets.length > 0) await deps.failures.recordFailure({ targets, failureId: ledger.batchId, reason, detail })
      await sentinel(runDir, FINAL_FILE, { outcome, detail })
    },
    async succeed(runDir: string, ledger: FactsRunLedger, entries: readonly FactsQueueEntry[], outcome: "committed" | "no_facts", sha?: string): Promise<void> {
      if (isTerminalRun(runDir)) return
      await deps.queue.markConsumed(entries)
      try {
        await deps.failures.clearOnSuccess(ledgerTargets(ledger.queued))
      } catch (error) {
        // A stale record only delays the next launch; refusing a committed outcome over it is worse.
        deps.warn("facts failure records survived a successful run", { error: String(error) })
      }
      await sentinel(runDir, FINAL_FILE, { outcome, ...(sha === undefined ? {} : { sha }) })
    },
    /** `unknown_liveness` takes a failure (backoff); a shutdown cancel does not (Native `abandon`). */
    async abandon(runDir: string, ledger: FactsRunLedger, reason: "unknown_liveness" | "session_shutdown"): Promise<void> {
      if (isTerminalRun(runDir)) return
      const targets = ledgerTargets(ledger.queued)
      if (reason === "unknown_liveness" && targets.length > 0) {
        await deps.failures.recordFailure({ targets, failureId: ledger.batchId, reason, detail: "facts run liveness is unknown" })
      }
      await sentinel(runDir, ABANDONED_FILE, { reason })
    },
  }
}

export type FactsTerminal = ReturnType<typeof createFactsTerminal>
