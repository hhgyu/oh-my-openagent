// Finalize state machine for one facts run (omo-senpi `facts-run-finalize.ts` + `facts-batch-apply.ts`):
// decide the terminal outcome from the run's own artifacts and route it through the ordered terminal
// writes. A batch receipt in the memory repo wins (the commit already landed); otherwise the child's
// outcome, then the extraction, then the apply under the cross-process `memory-write` lock. A planned
// recovery is published into the ledger before the commit, so a crash mid-apply resumes the same plan
// at the next reconcile instead of re-planning.

import { join } from "node:path"
import {
  applyFactsBatch,
  applyFactsRecovery,
  createLockRecord,
  findFactsBatchReceipt,
  LockContentionError,
  memoryWriterLockPath,
  MemorySecretError,
  parseFactsExtractionJsonl,
  validateFactsRecovery,
  withLock,
  type ApplyFactsBatchResult,
  type FactsBatch,
  type FactsPayload,
  type FactsPeopleRouting,
  type GitMemoryRepo,
} from "@oh-my-opencode/memory-core"
import { existsSync, readFile } from "@oh-my-opencode/memory-core/fs"
import { describeError } from "./binding"
import {
  FACTS_EXTRACTION_FILE,
  FACTS_PAYLOAD_FILE,
  ledgerPath,
  outcomePath,
  readRunJson,
  writeRunJson,
  type FactsRunLedger,
  type FactsRunOutcome,
  type FactsRunTerminal,
  type FactsTerminal,
} from "./facts-run-store"

const WRITER_ATTEMPTS = 3

interface FactsFinalizeDeps {
  readonly repo: GitMemoryRepo
  readonly identity: string
  readonly locksDir: string
  readonly terminal: FactsTerminal
  readonly people: FactsPeopleRouting
  readonly retryDelay?: (attempt: number) => Promise<void>
}

/** `undefined` means the child has not settled (no outcome) and nothing was decided. */
export async function finalizeFactsRun(deps: FactsFinalizeDeps, runDir: string): Promise<FactsRunTerminal | undefined> {
  const ledger = await readRunJson<FactsRunLedger>(ledgerPath(runDir))
  const payload = await readRunJson<FactsPayload>(join(runDir, FACTS_PAYLOAD_FILE)).catch(() => undefined)
  const entries = payload?.entries ?? []
  const receipt = await findFactsBatchReceipt(deps.repo, ledger.batchId)
  if (receipt !== undefined) {
    await deps.terminal.succeed(runDir, ledger, entries, "committed", receipt.sha)
    return "committed"
  }
  if (!existsSync(outcomePath(runDir))) return undefined
  const outcome = await readRunJson<FactsRunOutcome>(outcomePath(runDir))
  if (outcome.status !== "completed") {
    await deps.terminal.fail(
      runDir,
      ledger,
      outcome.status === "deadline" ? "deadline_exceeded" : "child_exit",
      outcome.detail ?? "facts child did not settle successfully",
    )
    return "failed"
  }
  if (payload === undefined) {
    await deps.terminal.fail(runDir, ledger, "invalid_extraction", "facts payload is missing")
    return "failed"
  }
  let batch: FactsBatch
  try {
    batch = {
      batchId: ledger.batchId,
      records: parseFactsExtractionJsonl(await readFile(join(runDir, FACTS_EXTRACTION_FILE), "utf8")),
    }
  } catch (error) {
    await deps.terminal.fail(runDir, ledger, "invalid_extraction", describeError(error))
    return "failed"
  }
  if (batch.records.length === 0) {
    await deps.terminal.succeed(runDir, ledger, entries, "no_facts")
    return "no_facts"
  }
  let applied: ApplyFactsBatchResult | undefined
  try {
    applied = await applyWithRetries(deps, runDir, batch)
  } catch (error) {
    await deps.terminal.fail(
      runDir,
      ledger,
      error instanceof MemorySecretError ? "secret_like_content" : "invalid_extraction",
      describeError(error),
    )
    return "failed"
  }
  if (applied === undefined) {
    await deps.terminal.fail(runDir, ledger, "memory_write_lock_exhausted", "memory-write lock exhausted")
    return "failed"
  }
  if (applied.outcome === "parent_dirty") {
    await deps.terminal.fail(runDir, ledger, "parent_dirty", "memory repository contains foreign state", "parent_dirty")
    return "parent_dirty"
  }
  if (applied.outcome === "no_facts") {
    await deps.terminal.succeed(runDir, ledger, entries, "no_facts")
    return "no_facts"
  }
  await deps.terminal.succeed(runDir, ledger, entries, "committed", applied.sha)
  return "committed"
}

async function applyWithRetries(
  deps: FactsFinalizeDeps,
  runDir: string,
  batch: FactsBatch,
): Promise<ApplyFactsBatchResult | undefined> {
  for (let attempt = 1; attempt <= WRITER_ATTEMPTS; attempt += 1) {
    try {
      const record = await createLockRecord("memory-write", { runId: batch.batchId })
      return await withLock(memoryWriterLockPath(deps.locksDir), record, () => applyClaimed(deps, runDir, batch), {
        waitTimeoutMs: 2_000,
      })
    } catch (error) {
      if (!(error instanceof LockContentionError)) throw error
      if (attempt < WRITER_ATTEMPTS) await (deps.retryDelay ?? jitterDelay)(attempt)
    }
  }
  return undefined
}

async function applyClaimed(
  deps: FactsFinalizeDeps,
  runDir: string,
  batch: FactsBatch,
): Promise<ApplyFactsBatchResult> {
  const receipt = await findFactsBatchReceipt(deps.repo, batch.batchId)
  if (receipt !== undefined) return { outcome: "committed", sha: receipt.sha, affectedPaths: [] }
  const ledger = await readRunJson<FactsRunLedger>(ledgerPath(runDir))
  const author = { agentId: deps.identity, authorName: "Facts Extractor" }
  const publishRecovery = async (recovery: NonNullable<FactsRunLedger["applyRecovery"]>): Promise<void> => {
    const current = await readRunJson<FactsRunLedger>(ledgerPath(runDir))
    await writeRunJson(ledgerPath(runDir), { ...current, applyRecovery: recovery })
  }
  if (ledger.applyRecovery !== undefined) {
    validateFactsRecovery(ledger.applyRecovery, batch)
    return applyFactsRecovery(deps.repo, ledger.applyRecovery, batch.records.length, author, { batch, publishRecovery })
  }
  return applyFactsBatch(deps.repo, batch, author, { people: deps.people, publishRecovery })
}

function jitterDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25 + Math.floor(Math.random() * 76)))
}
