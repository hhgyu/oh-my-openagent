// Parent-side reflection runner (plan S7f). One call reserves a run and drives it to a settled
// reservation, porting the algorithm of omo-senpi `worker/runner-execution.ts` + `run-finalization*.ts`
// through memory-core calls:
//   1. `ReflectionReservationStore.tryReserve(request)`: parked or pending stops here (another run holds
//      `active.lock`; the pending request is promoted when that run completes);
//   2. the seeded parent repo, then `createReflectionWorktree` behind a `prelaunch.json` record;
//   3. the transcript payload `{schemaVersion: 1, runId, request}`;
//   4. the owned `omo-reflection` child (`launch`), bounded by the reflection `timeout_minutes`;
//   5. `validateCompletion` -> `integrateValidatedReflection` (see `reflection-finalize.ts`);
//   6. worktree + branch removal on every path, then `store.complete(runId, outcome, {failure})` with the
//      Senpi failure classification, so the park streak and backoff match;
//   7. a pending run the completion promoted to active is executed next, as Senpi's `launch` callback does.
// A failure before the child starts settles as `failed`/`spawn_failed` (Senpi's pre-ledger path); any
// later throw settles as `failed`/`runner_failed`. A dream run (S7h) launches the `omo-dream` agent with
// the dream inputs as its task prompt and records the dream system-token budget check once it merged.

import type { ReflectionRequest, ReflectionWorktree, ReservedRun } from "@oh-my-opencode/memory-core"
import type { BoundMemorySession } from "./binding"
import { applyDreamTokenBudget } from "./dream-budget"
import { buildDreamLaunchPrompt } from "./dream-inputs"
import type { ReflectionChildHosting, ReflectionChildLaunch } from "./reflection-child"
import { classifyReflectionFailure, type ReflectionDecision } from "./reflection-failure"
import { cleanupRunWorktree, decideReflection } from "./reflection-finalize"
import { reflectionModelUnavailableDetail, type ReflectionModelResolution } from "./reflection-model"
import {
  createRunWorktree, memoryWriterLock, openMemoryRepo, reflectionSettings, reflectionStore, writeRunTerminal, writeTranscriptPayload,
  type ReflectionStoreSeams,
} from "./reflection-run-store"

export interface ReflectionRunInput {
  /** The root session the child is parented to. */
  readonly parentSessionId: string
  readonly request: ReflectionRequest
  /** `provider/model` for the child; absent uses `resolveModel`, else the agent's own model. */
  readonly model?: string
  onCancel?(cancel: () => void): void
}

interface ReflectionRunResult extends ReflectionDecision {
  readonly runId: string
  readonly cleanedUp: boolean
}

export type ReflectionRunReport =
  | { readonly status: "parked"; readonly nextProbeAt: string }
  | { readonly status: "pending"; readonly runId: string }
  | { readonly status: "finished"; readonly runs: readonly ReflectionRunResult[] }

interface ReflectionRunnerDeps extends ReflectionStoreSeams {
  readonly launch: ReflectionChildHosting["launch"]
  readonly warn: (message: string, details?: Record<string, unknown>) => void
  /** Overrides the per-identity `timeout_minutes` deadline. */
  readonly deadlineMs?: number
  readonly lockWaitTimeoutMs?: number
  /** Native reflection model selection for the run (see `reflection-model.ts`); unavailable settles without launching. */
  readonly resolveModel?: (bound: BoundMemorySession, parentSessionId: string) => Promise<ReflectionModelResolution>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

interface ExecutedRun {
  readonly result: ReflectionRunResult
  /** The pending run the completion promoted to active (this launcher owns it now). */
  readonly promoted?: ReservedRun
}

export function createReflectionRunner(deps: ReflectionRunnerDeps) {
  async function execute(bound: BoundMemorySession, run: ReservedRun, input: Omit<ReflectionRunInput, "request">): Promise<ExecutedRun> {
    let model = input.model
    let selection: Pick<ReflectionChildLaunch, "variant" | "fallbacks"> = {}
    if (model === undefined && deps.resolveModel !== undefined) {
      let resolution: ReflectionModelResolution
      try {
        resolution = await deps.resolveModel(bound, input.parentSessionId)
      } catch (error) {
        return settle(bound, run, { outcome: "failed", reason: "spawn_failed", detail: `reflection model resolution failed: ${errorMessage(error)}` }, true)
      }
      if (resolution.kind === "unavailable") {
        // Native settles before any worktree or ledger exists: `failed`/`category_unavailable`.
        const detail = reflectionModelUnavailableDetail(resolution)
        deps.warn("memory reflection not launched: no usable model for the reflection category", { runId: run.runId, category: resolution.category, cause: resolution.cause })
        return settle(bound, run, { outcome: "failed", reason: "category_unavailable", detail }, true)
      }
      model = resolution.model
      selection = { variant: resolution.variant, fallbacks: resolution.fallbacks }
    }
    const withWriterLock = memoryWriterLock(bound, deps.lockWaitTimeoutMs)
    let worktree: ReflectionWorktree | undefined
    let transcriptPath: string
    let prompt: string | undefined
    try {
      worktree = await createRunWorktree(bound, await openMemoryRepo(bound, withWriterLock), run.runId)
      transcriptPath = await writeTranscriptPayload(bound, run)
      if (run.request.trigger === "dream") prompt = await buildDreamLaunchPrompt(bound, run, worktree.dir)
    } catch (error) {
      const cleanedUp = worktree === undefined || await cleanupRunWorktree(worktree, run.runId, deps.warn)
      deps.warn("memory reflection not launched: run setup failed", { runId: run.runId, error: errorMessage(error) })
      return settle(bound, run, { outcome: "failed", reason: "spawn_failed", detail: errorMessage(error) }, cleanedUp)
    }
    let decision: ReflectionDecision
    try {
      const launch: ReflectionChildLaunch = {
        runId: run.runId, parentSessionId: input.parentSessionId, worktreeDir: worktree.dir, transcriptPath,
        request: { trigger: run.request.trigger, ...(run.request.focus === undefined ? {} : { focus: run.request.focus }) },
        ...(prompt === undefined ? {} : { prompt }),
        deadlineMs: deps.deadlineMs ?? reflectionSettings(bound).timeout_minutes * 60_000,
        ...(model === undefined ? {} : { model }),
        ...selection,
        ...(input.onCancel === undefined ? {} : { onCancel: input.onCancel }),
      }
      const child = await deps.launch(bound, launch)
      decision = await decideReflection({ run, worktree, child, withWriterLock, warn: deps.warn })
      if (child.attemptedModels?.length) decision = { ...decision, detail: [decision.detail, `attempted models: ${child.attemptedModels.join(" -> ")}`].filter(Boolean).join("; ") }
    } catch (error) {
      decision = { outcome: "failed", reason: "runner_failed", detail: errorMessage(error) }
    }
    const decided = decision
    decision = await applyDreamTokenBudget(bound, run, decided).catch((error: unknown) => {
      deps.warn("dream token budget not checked", { runId: run.runId, error: errorMessage(error) })
      return decided
    })
    return settle(bound, run, decision, await cleanupRunWorktree(worktree, run.runId, deps.warn))
  }

  async function settle(bound: BoundMemorySession, run: ReservedRun, decision: ReflectionDecision, cleanedUp: boolean): Promise<ExecutedRun> {
    const failure = classifyReflectionFailure(decision)
    const completion = await reflectionStore(bound, deps).complete(run.runId, decision.outcome, failure === undefined ? undefined : { failure })
    const at = (deps.now?.() ?? new Date()).toISOString()
    await writeRunTerminal(bound, run, {
      kind: "final", outcome: decision.outcome, at,
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      ...(decision.detail === undefined ? {} : { detail: decision.detail }),
      ...(decision.integrationSha === undefined ? {} : { integrationSha: decision.integrationSha }),
    }).catch((error: unknown) => { deps.warn("reflection final sentinel not written", { runId: run.runId, error: errorMessage(error) }) })
    return { result: { runId: run.runId, cleanedUp, ...decision }, ...(completion.launch === undefined ? {} : { promoted: completion.launch }) }
  }

  /** Executes an active run this launcher owns, then every run its completion promotes. */
  async function drive(bound: BoundMemorySession, first: ReservedRun, input: Omit<ReflectionRunInput, "request">): Promise<readonly ReflectionRunResult[]> {
    const runs: ReflectionRunResult[] = []
    let next: ReservedRun | undefined = first
    while (next !== undefined) {
      const executed: ExecutedRun = await execute(bound, next, input)
      runs.push(executed.result)
      next = executed.promoted
    }
    return runs
  }

  /** Reserves and runs one reflection, then any run its completion promotes; see the module header. */
  async function runReflection(bound: BoundMemorySession, input: ReflectionRunInput): Promise<ReflectionRunReport> {
    const reserved = await reflectionStore(bound, deps).tryReserve(input.request)
    if (reserved.status === "parked") return { status: "parked", nextProbeAt: reserved.nextProbeAt }
    if (reserved.status === "pending") return { status: "pending", runId: reserved.run.runId }
    return { status: "finished", runs: await drive(bound, reserved.run, input) }
  }

  return {
    runReflection,
    /** Runs a reservation recovery promoted to active (its launcher is this process now). */
    runPromoted: (bound: BoundMemorySession, run: ReservedRun, input: Omit<ReflectionRunInput, "request">) => drive(bound, run, input),
  }
}
