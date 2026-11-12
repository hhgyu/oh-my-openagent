// The V2 facts extractor run (omo-senpi `facts-runner.ts`, reduced to the in-process child path): one
// launch at a time per identity, recover stranded runs first, select launchable queue entries through
// the failure ledger (fail-closed on a corrupt ledger), claim them, cap the payload, reserve a run dir,
// run the owned `omo-facts` child, record how it settled, then finalize. Successful outcomes drain the
// next batch at once (Native `drainFactsLaunches`); a failure stops the drain and leaves pacing to the
// backoff ledger. Entries over the payload cap are recorded as preflight failures so they back off.
// Every reconcile (bind recovery included) and every finalize ends with the memory-core retention
// prune, as Native `facts-run-maintenance.ts` does; reconcile first sweeps `.prune-*` tombstones.

import { randomUUID } from "node:crypto"
import { join } from "node:path"
import {
  FactsFailureStore, FactsQueue, getProcessStartIdentity, GitMemoryRepo, readFactsPeoplePayload,
  selectCappedFactsBatch, selectLaunchable, serializeFactsPayload,
  type ConsentExchange, type FactsPayload, type FactsPeopleRouting, type FactsQueueEntry, type MemoryIdentityPaths,
} from "@oh-my-opencode/memory-core"
import { pruneTerminalFactsRuns, sweepFactsRunTombstones } from "@oh-my-opencode/memory-core/facts-run-prune"
import { writeFile } from "@oh-my-opencode/memory-core/fs"
import { describeError } from "./binding"
import type { MemoryLogger } from "./config"
import { finalizeFactsRun } from "./facts-finalize"
import type { FactsModelResolution } from "./facts-model"
import { payloadExchanges } from "./facts-record-tool"
import { recoverFactsRuns } from "./facts-recovery"
import { memoryWriterLock, openMemoryRepo } from "./memory-repo-open"
import {
  createFactsTerminal, FACTS_EXTRACTION_FILE, FACTS_PAYLOAD_FILE, outcomePath, queueTargets, readRunJson, reserveFactsRunDir, writeRunJson,
  ledgerPath, type FactsRunLedger, type FactsRunOutcome, type FactsRunTerminal,
} from "./facts-run-store"

type FactsLaunchResult =
  | { readonly status: "empty" | "active" | "skipped" }
  | { readonly status: FactsRunTerminal | "cancelled"; readonly runId: string }

export interface FactsChildLaunch {
  readonly runId: string
  readonly runDir: string
  readonly parentSessionId: string
  readonly prompt: string
  readonly model: string
  readonly extractionPath: string
  readonly exchanges: readonly ConsentExchange[]
  readonly deadlineMs: number
  /** Registers the in-flight child's cancel, so `cancelActive` can stop it. */
  readonly onCancel: (cancel: () => void) => void
}

export interface FactsChildResult {
  readonly status: FactsRunOutcome["status"]
  readonly detail?: string
}

interface FactsRunnerDeps {
  readonly identity: string
  readonly paths: MemoryIdentityPaths
  /** Unique per component instance; recorded in every ledger it launches. */
  readonly owner: string
  readonly now: () => Date
  readonly logger: MemoryLogger
  readonly people: () => FactsPeopleRouting
  readonly resolveModel: (sessionModel: string | undefined) => Promise<FactsModelResolution>
  readonly launchChild: (input: FactsChildLaunch) => Promise<FactsChildResult>
  /** Removes hidden children a dead host stranded; runs before stranded runs are settled. */
  readonly reclaimChildren?: () => Promise<void>
  readonly deadlineMs: number
  /** Whether a ledger's owner is a live component instance other than this one. */
  readonly ownerAlive: (ledger: FactsRunLedger) => boolean
  /** `memory-write` wait budget when this run seeds a brand-new repo; defaults to 5000ms. */
  readonly lockWaitTimeoutMs?: number
}

interface FactsLaunchRequest {
  readonly parentSessionId: string
  readonly sessionModel?: string
}

function factsPrompt(payloadText: string): string {
  return `Extract durable facts from this payload and record each accepted fact with record_fact.\n\n${payloadText}`
}

export function createFactsRunner(deps: FactsRunnerDeps) {
  const queue = new FactsQueue({ identityPaths: deps.paths, now: deps.now })
  const failures = new FactsFailureStore({ identityPaths: deps.paths, now: deps.now })
  const warn = (message: string, details?: Record<string, unknown>): void => { deps.logger.warn(message, { identity: deps.identity, ...details }) }
  const terminal = createFactsTerminal({ queue, failures, now: deps.now, warn })
  let active: Promise<FactsLaunchResult> | undefined
  let activeRunId: string | undefined
  let cancel: (() => void) | undefined
  let cancelled = false

  function repo(): GitMemoryRepo {
    return new GitMemoryRepo({ dir: deps.paths.repo, agentId: deps.identity })
  }

  const finalizeDeps = () => ({ repo: repo(), identity: deps.identity, locksDir: deps.paths.locks, terminal, people: deps.people() })

  /** Native retention (P-15): keep the last 20 terminal runs under 128 MiB; a failure only warns. */
  async function prune(): Promise<void> {
    try {
      await pruneTerminalFactsRuns({ factsDir: deps.paths.facts, locksDir: deps.paths.locks, warn: (message, fields) => { warn(message, fields) } })
    } catch (error) {
      warn("facts run retention pruning failed", { error: describeError(error) })
    }
  }

  async function reconcile(): Promise<boolean> {
    await deps.reclaimChildren?.().catch((error: unknown) => { warn("stranded facts children were not reclaimed", { error: describeError(error) }) })
    await sweepFactsRunTombstones({ factsDir: deps.paths.facts, warn: (message, fields) => { warn(message, fields) } })
    const active = await recoverFactsRuns({
      factsDir: deps.paths.facts, queue, terminal, warn,
      isOwnRun: runId => runId === activeRunId,
      isForeignLive: ledger => ledger.owner !== deps.owner && deps.ownerAlive(ledger),
      finalize: runDir => finalizeFactsRun(finalizeDeps(), runDir),
    })
    await prune()
    return active
  }

  async function releaseAll(entries: readonly FactsQueueEntry[], claimId: string): Promise<void> {
    await queue.releaseClaim(entries, claimId).catch((error: unknown) => { warn("facts claim release failed", { error: describeError(error) }) })
  }

  async function launchOnce(request: FactsLaunchRequest): Promise<FactsLaunchResult> {
    if (cancelled) return { status: "skipped" }
    if (await reconcile()) return { status: "active" }
    const pending = await queue.listPending()
    if (pending.length === 0) return { status: "empty" }
    let ledgerFile
    try {
      ledgerFile = await failures.readFailures()
    } catch (error) {
      warn("facts failure ledger is unreadable; refusing to launch", { error: describeError(error) })
      return { status: "skipped" }
    }
    const selection = selectLaunchable(pending, ledgerFile, deps.now())
    if (selection.selected.length === 0) return { status: "empty" }
    const claimId = randomUUID()
    const entries = await queue.claim(selection.selected, claimId)
    if (entries.length === 0) return { status: "active" }
    const resolution = await deps.resolveModel(request.sessionModel).catch((error: unknown): FactsModelResolution => {
      warn("facts model resolution failed", { error: describeError(error) })
      return { kind: "unavailable", cause: "no_catalog" }
    })
    if (resolution.kind !== "resolved") {
      warn("facts extraction skipped: no usable user-selected model", { cause: resolution.cause })
      await releaseAll(entries, claimId)
      return { status: "skipped" }
    }
    let batch: readonly FactsQueueEntry[] = []
    let payload: FactsPayload
    try {
      // A brand-new identity is seeded only under the `memory-write` lock, like reflection and the memory tool.
      const writerLock = memoryWriterLock(deps, `memory facts (${deps.identity})`, deps.lockWaitTimeoutMs === undefined ? {} : { waitTimeoutMs: deps.lockWaitTimeoutMs })
      const memoryRepo = await openMemoryRepo(deps, writerLock)
      const people = await readFactsPeoplePayload(memoryRepo.dir)
      const envelope = { version: 1, identity: deps.identity, today: deps.now().toISOString().slice(0, 10), ...people } as const
      const capped = selectCappedFactsBatch({ entries, envelope, now: deps.now() })
      const refused = capped.envelopeOversized ? entries : capped.oversized
      if (refused.length > 0) {
        await failures.recordFailure({
          targets: queueTargets(refused), failureId: `preflight-${randomUUID()}`,
          reason: capped.envelopeOversized ? "payload_envelope_oversize" : "payload_entry_oversize", detail: "facts payload exceeds the extractor input cap",
        })
      }
      batch = capped.envelopeOversized ? [] : capped.selected
      payload = { ...envelope, entries: batch }
    } catch (error) {
      await releaseAll(entries, claimId)
      throw error
    }
    await releaseAll(entries.filter(entry => !batch.includes(entry)), claimId)
    if (batch.length === 0) return { status: "empty" }
    try {
      return await runBatch(request, resolution, batch, payload, claimId)
    } finally {
      await releaseAll(batch, claimId)
    }
  }

  async function runBatch(request: FactsLaunchRequest, resolution: Extract<FactsModelResolution, { kind: "resolved" }>, batch: readonly FactsQueueEntry[], payload: FactsPayload, claimId: string): Promise<FactsLaunchResult> {
    const startedAt = deps.now()
    const runDir = await reserveFactsRunDir({
      factsDir: deps.paths.facts, locksDir: deps.paths.locks, entries: batch,
      ledger: {
        startedAt: startedAt.toISOString(), hardDeadlineAt: startedAt.getTime() + deps.deadlineMs * 2, batchId: randomUUID(), claimId,
        owner: deps.owner, pid: process.pid, processStart: await getProcessStartIdentity(process.pid), model: resolution.model,
      },
    })
    if (runDir === undefined) return { status: "active" }
    const ledger = await readRunJson<FactsRunLedger>(ledgerPath(runDir))
    activeRunId = ledger.runId
    try {
      const payloadText = serializeFactsPayload(payload)
      const extractionPath = join(runDir, FACTS_EXTRACTION_FILE)
      await writeFile(join(runDir, FACTS_PAYLOAD_FILE), payloadText, { encoding: "utf8", mode: 0o600 })
      await writeFile(extractionPath, "", { encoding: "utf8", mode: 0o600 })
      let result: FactsChildResult = { status: "failed", detail: "no facts model candidate launched" }
      for (const model of [resolution.model, ...resolution.fallbacks]) {
        if (cancelled) { result = { status: "cancelled" }; break }
        try {
          result = await deps.launchChild({
            runId: ledger.runId, runDir, parentSessionId: request.parentSessionId, prompt: factsPrompt(payloadText), model, extractionPath,
            exchanges: payloadExchanges(payload), deadlineMs: deps.deadlineMs, onCancel: stop => { cancel = stop },
          })
          break
        } catch (error) {
          // Only a launch that never admitted the first input falls through to the next candidate.
          result = { status: "failed", detail: describeError(error) }
          warn("facts model candidate did not launch", { model, error: describeError(error) })
        }
      }
      if (result.status === "cancelled" || cancelled) {
        await terminal.abandon(runDir, ledger, "session_shutdown")
        return { status: "cancelled", runId: ledger.runId }
      }
      const outcome: FactsRunOutcome = { version: 1, runId: ledger.runId, status: result.status, ...(result.detail === undefined ? {} : { detail: result.detail }), finishedAt: deps.now().toISOString() }
      await writeRunJson(outcomePath(runDir), outcome)
      const decided = await finalizeFactsRun(finalizeDeps(), runDir)
      await prune()
      return { status: decided ?? "failed", runId: ledger.runId }
    } finally {
      activeRunId = undefined
      cancel = undefined
    }
  }

  async function drain(request: FactsLaunchRequest): Promise<FactsLaunchResult> {
    const first = await launchOnce(request)
    let latest = first
    while ((latest.status === "committed" || latest.status === "no_facts") && !cancelled) latest = await launchOnce(request)
    return first
  }

  return {
    queue,
    async launchPending(request: FactsLaunchRequest): Promise<FactsLaunchResult> {
      if (cancelled) return { status: "skipped" }
      if (active !== undefined) return { status: "active" }
      const operation = drain(request)
      active = operation
      try {
        return await operation
      } finally {
        if (active === operation) active = undefined
      }
    },
    /** Recovers stranded runs only; never launches a child. */
    async reconcilePending(): Promise<void> {
      if (cancelled || active !== undefined) return
      const operation = reconcile().then((): FactsLaunchResult => ({ status: "empty" }))
      active = operation
      try {
        await operation
      } finally {
        if (active === operation) active = undefined
      }
    },
    async cancelActive(): Promise<void> {
      cancelled = true
      cancel?.()
      await active?.catch(() => undefined)
    },
  }
}

export type FactsRunner = ReturnType<typeof createFactsRunner>
