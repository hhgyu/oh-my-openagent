// One wake as a tracked turn, its machine-wide lease and how the sidecar lets go of a child (V2 port
// of omo-senpi `sidecar-turn.ts`, `sidecar-admission.ts` and `sidecar-recovery.ts`). Starting and settling a turn is `sidecar-wake.ts`'s business; nothing
// here changes `state` except backoff entry and its timer.

import { validateNudges, type RecallCandidate, type RecallNudge } from "@oh-my-opencode/memory-core"
import { backoffDelayMs, type KibitzerWakeAdmission } from "@oh-my-opencode/memory-core/recall-sidecar"
import { KIBITZER_REJECTED_AFTER_WAKES, KIBITZER_WAKE_MAX_TOTAL_MS, type KibitzerOfferResult } from "./contract"
import {
  isDiagnosticWakeEnd,
  startFailureEnd,
  type KibitzerWakeAbort,
  type KibitzerWakeEnd,
  type KibitzerWakeOutcome,
} from "./outcome"
import { chargeBudget, createWakeBudget, describe, type Child, type SidecarCore, type Turn } from "./sidecar-core"

export type Admission = KibitzerWakeAdmission | { readonly status: "error"; readonly error: unknown }

export interface TurnLifecycle {
  newTurn(generation: number, maxItems: number, candidateCount: number): Turn
  offerPaths(candidates: readonly RecallCandidate[], wake: number): void
  observeTool(phase: "start" | "end", callId: string): void
  contextEstimate(current: Child): number
  armDeadline(turn: Turn, onExpire?: () => void): void
  clearDeadline(turn: Turn): void
  abortTurn(turn: Turn, cause: KibitzerWakeAbort): Promise<void>
  abortChild(current: Child, cause: string): Promise<void>
  validated(turn: Turn, current: Child): RecallNudge[]
  report(turn: Turn, end: KibitzerWakeEnd, nudges: readonly RecallNudge[], current: Child | undefined): void
  admit(): Promise<Admission>
  releaseLease(turn: Turn): Promise<void>
  refused(
    admission: Exclude<Admission, { status: "acquired" }>,
    generation: number,
    maxItems: number,
    candidateCount: number,
  ): KibitzerOfferResult
  prepareReseed(wake: number): void
  enterBackoff(): void
  clearBackoff(): void
  disposeChild(): void
  disposeHandle(handle: Child["handle"]): void
}

export function createTurnLifecycle(core: SidecarCore): TurnLifecycle {
  function newTurn(generation: number, maxItems: number, candidateCount: number): Turn {
    core.wakeSeq += 1
    core.accepted = []
    core.budget = createWakeBudget(core.toolBudget)
    const startedAt = core.now()
    return {
      wake: core.wakeSeq,
      generation,
      maxItems,
      startedAt,
      totalDeadlineAt: startedAt + KIBITZER_WAKE_MAX_TOTAL_MS,
      accepted: core.accepted,
      budget: core.budget,
      envelopes: [],
      lease: undefined,
      slotWaitMs: 0,
      candidateCount,
      toolStarts: 0,
      toolEnds: 0,
      abort: undefined,
      deadline: undefined,
      report: undefined,
      settled: Promise.resolve(),
    }
  }

  function offerPaths(candidates: readonly RecallCandidate[], wake: number): void {
    for (const candidate of candidates) {
      core.offered.add(candidate.path)
      core.offeredAtWake.set(candidate.path, wake)
    }
  }

  /** The child's tool calls against the budget: a parallel batch past the budget aborts at its start. */
  function observeTool(phase: "start" | "end", callId: string): void {
    const turn = core.activeTurn
    if (turn === undefined) return
    if (phase === "start") {
      turn.toolStarts += 1
      chargeBudget(turn.budget, callId)
      if (turn.toolStarts > core.toolBudget) void abortTurn(turn, "tool_budget")
      return
    }
    turn.toolEnds += 1
    if (turn.toolEnds >= core.toolBudget) void abortTurn(turn, "tool_budget")
  }

  function contextEstimate(current: Child): number {
    return current.usageTokens ?? Math.ceil(current.charsSent / 4)
  }

  /** Arms at `min(now + wakeDeadlineMs, turn.totalDeadlineAt)`; `onExpire` bounds child I/O before a turn exists. */
  function armDeadline(turn: Turn, onExpire?: () => void): void {
    clearDeadline(turn)
    const quietMs = Math.min(core.wakeDeadlineMs, Math.max(0, turn.totalDeadlineAt - core.now()))
    turn.deadline = core.timers.set(
      onExpire ??
        (() => {
          void abortTurn(turn, "deadline")
        }),
      quietMs,
    )
  }

  function clearDeadline(turn: Turn): void {
    if (turn.deadline === undefined) return
    core.timers.clear(turn.deadline)
    turn.deadline = undefined
  }

  function abortTurn(turn: Turn, cause: KibitzerWakeAbort): Promise<void> {
    return core.serialized(async () => {
      if (core.activeTurn !== turn || turn.abort !== undefined || core.child === undefined) return
      turn.abort = cause
      clearDeadline(turn)
      await abortChild(core.child, cause)
    })
  }

  async function abortChild(current: Child, cause: string): Promise<void> {
    try {
      await current.handle.abort()
    } catch (error) {
      core.warn("kibitzer sidecar abort failed", { cause, error: describe(error) })
    }
  }

  /** Defence in depth over the nudge tool's call-time checks: offered ∪ searched − surfaced. */
  function validated(turn: Turn, current: Child): RecallNudge[] {
    const allowed = new Set<string>([...core.offered, ...current.searched])
    return validateNudges(turn.accepted, { candidates: allowed, surfaced: core.surfaced, maxItems: turn.maxItems })
  }

  function report(turn: Turn, end: KibitzerWakeEnd, nudges: readonly RecallNudge[], current: Child | undefined): void {
    const cursors = turn.envelopes.reduce<{ first: number; last: number } | undefined>((span, envelope) => {
      const range = envelope.payload.cursors
      if (range === undefined) return span
      return span === undefined
        ? { ...range }
        : { first: Math.min(span.first, range.first), last: Math.max(span.last, range.last) }
    }, undefined)
    const child = turn.report
    const outcome: KibitzerWakeOutcome = {
      sessionId: core.sessionId,
      wake: turn.wake,
      generation: turn.generation,
      status: end.status,
      ...("cause" in end ? { cause: end.cause } : {}),
      ...("reason" in end && end.reason !== undefined ? { reason: end.reason } : {}),
      ...(child?.model === undefined || end.status === "cancelled" ? {} : { model: child.model }),
      nudges,
      candidateCount: turn.candidateCount,
      steered: turn.envelopes.filter((envelope) => envelope.steered).length,
      toolCalls: turn.toolStarts,
      durationMs: Math.max(0, core.now() - turn.startedAt),
      slotWaitMs: turn.slotWaitMs,
      ...(cursors === undefined ? {} : { cursors }),
      ...(current === undefined ? {} : { contextTokens: contextEstimate(current) }),
      ...(child?.usage === undefined ? {} : { usage: child.usage }),
      diagnostic: isDiagnosticWakeEnd(end),
    }
    try {
      core.options.onWake?.(outcome)
    } catch (error) {
      core.warn("kibitzer sidecar wake report failed", { wake: turn.wake, error: describe(error) })
    }
  }

  // ---- the machine-wide lease ------------------------------------------------------------------

  async function admit(): Promise<Admission> {
    if (core.closing) return { status: "aborted" }
    const controller = new AbortController()
    core.admission = controller
    try {
      return await core.options.wakeSlot.acquire(controller.signal)
    } catch (error) {
      return { status: "error", error }
    } finally {
      core.admission = undefined
    }
  }

  /** Idempotent: the first exit hands the slot back, later ones find nothing to do. */
  async function releaseLease(turn: Turn): Promise<void> {
    const lease = turn.lease
    if (lease === undefined) return
    turn.lease = undefined
    try {
      if (!(await lease.release()))
        core.warn("kibitzer sidecar wake lease was already gone", { wake: turn.wake, slot: lease.slot })
    } catch (error) {
      core.warn("kibitzer sidecar wake lease release failed", {
        wake: turn.wake,
        slot: lease.slot,
        error: describe(error),
      })
    }
  }

  function refused(
    admission: Exclude<Admission, { status: "acquired" }>,
    generation: number,
    maxItems: number,
    candidateCount: number,
  ): KibitzerOfferResult {
    switch (admission.status) {
      case "busy":
        return { action: "buffered", reason: "slot_busy" }
      case "aborted":
        return { action: "buffered", reason: "disposed" }
      case "error": {
        const turn = newTurn(generation, maxItems, candidateCount)
        report(turn, startFailureEnd(new Error(`wake admission failed: ${describe(admission.error)}`)), [], undefined)
        enterBackoff()
        return { action: "buffered", reason: "backoff" }
      }
      default:
        return admission satisfies never
    }
  }

  // ---- letting go of a child -------------------------------------------------------------------

  function prepareReseed(wake: number): void {
    const rejected = [...core.offeredAtWake]
      .filter(([path, at]) => !core.delivered.has(path) && wake - at + 1 >= KIBITZER_REJECTED_AFTER_WAKES)
      .map(([path]) => path)
    core.pendingReseed = {
      sessionId: core.sessionId,
      lastCursor: core.stream.lastCursor() ?? 0,
      taskSummary: core.taskSummary ?? "",
      rejectedPaths: rejected,
      deliveredPaths: [...core.delivered],
    }
    core.offered.clear()
    for (const path of rejected) core.offered.add(path)
    for (const path of core.delivered) core.offered.add(path)
    for (const path of [...core.offeredAtWake.keys()]) if (!core.offered.has(path)) core.offeredAtWake.delete(path)
  }

  function enterBackoff(): void {
    const delay = backoffDelayMs(core.consecutiveFailures, core.random)
    core.consecutiveFailures += 1
    core.state = "backoff"
    clearBackoff()
    core.backoffTimer = core.timers.set(() => {
      core.backoffTimer = undefined
      if (core.state === "backoff") core.state = "idle"
    }, delay)
  }

  function clearBackoff(): void {
    if (core.backoffTimer === undefined) return
    core.timers.clear(core.backoffTimer)
    core.backoffTimer = undefined
  }

  /** Closes the current child (host I/O tracked in `core.disposals`); a failure is logged, never thrown. */
  function disposeChild(): void {
    const current = core.child
    if (current === undefined) return
    core.child = undefined
    disposeHandle(current.handle)
  }

  function disposeHandle(handle: Child["handle"]): void {
    const work = handle.dispose().catch((error: unknown) => {
      core.warn("kibitzer sidecar dispose failed", { generation: handle.generation, error: describe(error) })
    })
    core.disposals.add(work)
    void work.finally(() => core.disposals.delete(work))
  }

  return {
    newTurn,
    offerPaths,
    observeTool,
    contextEstimate,
    armDeadline,
    clearDeadline,
    abortTurn,
    abortChild,
    validated,
    report,
    admit,
    releaseLease,
    refused,
    prepareReseed,
    enterBackoff,
    clearBackoff,
    disposeChild,
    disposeHandle,
  }
}
