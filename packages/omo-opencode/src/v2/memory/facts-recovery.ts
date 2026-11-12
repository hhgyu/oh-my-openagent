// Reload/crash recovery for facts runs. OpenCode 2 has no `session_shutdown`, so a run a previous
// component instance (a reload, a crash, a killed process) left without a terminal sentinel is settled
// at the next bind or launch:
// - a run this instance is executing, or one a different live instance still owns before its hard
//   deadline, is left alone (and reported active, so no second launch starts);
// - otherwise the run is finalized from its own artifacts: a batch receipt or a recorded child outcome
//   applies or fails it exactly as the live path would (a planned apply recovery resumes the same plan);
// - a run whose child never recorded an outcome is abandoned with `unknown_liveness`, which takes a
//   failure (backoff) so a batch that keeps stranding parks instead of relaunching forever;
// - its queue claim is released either way, so the entries are launchable again at once.

import type { FactsQueue } from "@oh-my-opencode/memory-core"
import { describeError } from "./binding"
import {
  ledgerPath,
  openFactsRuns,
  readRunJson,
  type FactsRunLedger,
  type FactsRunTerminal,
  type FactsTerminal,
} from "./facts-run-store"

export interface FactsRecoveryDeps {
  readonly factsDir: string
  readonly queue: FactsQueue
  readonly terminal: FactsTerminal
  readonly warn: (message: string, details?: Record<string, unknown>) => void
  readonly isOwnRun: (runId: string) => boolean
  readonly isForeignLive: (ledger: FactsRunLedger) => boolean
  readonly finalize: (runDir: string) => Promise<FactsRunTerminal | undefined>
  readonly now?: () => number
}

/** Returns whether any open run is still owned by a live launch (this one or another instance). */
export async function recoverFactsRuns(deps: FactsRecoveryDeps): Promise<boolean> {
  let active = false
  for (const runDir of await openFactsRuns(deps.factsDir)) {
    let ledger: FactsRunLedger
    try {
      ledger = await readRunJson<FactsRunLedger>(ledgerPath(runDir))
    } catch (error) {
      deps.warn("facts run ledger unreadable; run left for inspection", { runDir, error: describeError(error) })
      continue
    }
    if (deps.isOwnRun(ledger.runId)) {
      active = true
      continue
    }
    if (deps.isForeignLive(ledger) && (deps.now ?? Date.now)() < ledger.hardDeadlineAt) {
      active = true
      continue
    }
    try {
      const decided = await deps.finalize(runDir)
      if (decided === undefined) await deps.terminal.abandon(runDir, ledger, "unknown_liveness")
    } catch (error) {
      deps.warn("facts run recovery failed; it is retried at the next reconcile", {
        runDir,
        error: describeError(error),
      })
      continue
    }
    await releaseLedgerClaim(deps.queue, ledger, deps.warn)
  }
  return active
}

async function releaseLedgerClaim(
  queue: FactsQueue,
  ledger: FactsRunLedger,
  warn: FactsRecoveryDeps["warn"],
): Promise<void> {
  try {
    const keys = new Set(ledger.queued.map((key) => `${key.conversationId}\u0000${key.end_message_id}`))
    const entries = (await queue.listPending()).filter((entry) =>
      keys.has(`${entry.conversationId}\u0000${entry.range.end_message_id}`),
    )
    await queue.releaseClaim(entries, ledger.claimId)
  } catch (error) {
    warn("facts claim release failed during recovery", { runId: ledger.runId, error: describeError(error) })
  }
}
