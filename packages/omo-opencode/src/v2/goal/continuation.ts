// OpenCode 2 port of the senpi goal extension's continuation monitor (`monitor-continuation.js` afterAgentEnd and its
// timers, `lifecycle-helpers.js` admitAndQueueGoalContinuation / handleDeniedContinuation, `direct-input-lifecycle.js`,
// `index.js` pauseOrBlockOnUserAbort). Every verdict, signature, progress test, prompt and store write is the
// engine's; this file only maps the host surfaces:
// - agent_end -> the shared `experimental.idle` chain, first in Native's precedence; the run comes from run-record.ts;
// - live wake sources -> the idle input's `background` (the host re-runs the hook when that work finishes), under the
//   engine's backstop timer on path `monitorDelayed`;
// - a user turn's grace timer and the backstop fire only once the execution has ended (Native: idle, nothing pending);
// - direct input -> the `prompt` hook (host continuations excluded); a user abort -> `session.execution.interrupted`.
import type { EngineGoal, GoalContinuationInput, GoalContinuationPath, GoalEngine, GoalStoreRef } from "./engine"
import {
  buildVerdictInput,
  createContinuationState,
  recordEndedRun,
  resetContinuationState,
  type ContinuationState,
} from "./continuation-state"
import type { EndedRun } from "./run-record"

export interface GoalTimers {
  set(callback: () => Promise<void>, ms: number): unknown
  clear(handle: unknown): void
}

export interface GoalContinuationDeps {
  readonly engine: GoalEngine
  readonly timers: GoalTimers
  ref(sessionID: string): GoalStoreRef
  todoCounts(sessionID: string): { readonly open: number; readonly total: number }
  /** `queued`: a user command's continuation, which may repeat an earlier delivery's count and signature. */
  deliver(sessionID: string, text: string, count: number, signature: string, queued: boolean): Promise<void>
  modelId(sessionID: string): Promise<string | undefined>
  /** Closes the session's accounting window and returns its goal, as Native's agent_end accounting does. */
  account(sessionID: string): Promise<EngineGoal | null>
  changed(sessionID: string, goal: EngineGoal | null): void
}

const USER_ABORT_REASON = "user interrupted the turn"
// `session-start-continuation.js queueGoalContinuation`: a queued continuation carries no ended-run guard state.
const SESSION_START_INPUT = {
  lastStopReason: undefined,
  lastTurnWasMalformedToolUse: false,
  consecutiveLengthRecoveries: 0,
  recentNormalizedOutputHashes: [],
  toollessContinuationStreak: 0,
} satisfies Partial<GoalContinuationInput>

export function createGoalContinuation(deps: GoalContinuationDeps) {
  const { engine } = deps
  const engineContinuation = engine.continuation
  const sessions = new Map<string, ContinuationState>()
  const stateOf = (sessionID: string) => {
    let state = sessions.get(sessionID)
    if (!state) sessions.set(sessionID, (state = createContinuationState()))
    return state
  }
  const cancelTimer = (state: ContinuationState) => {
    if (state.timer !== undefined) deps.timers.clear(state.timer)
    delete state.timer
  }
  const changed = (sessionID: string, goal: EngineGoal | null) => {
    deps.changed(sessionID, goal)
    if (goal?.status !== "active") {
      const state = stateOf(sessionID)
      cancelTimer(state)
      resetContinuationState(state)
    }
  }

  const verdictInput = (sessionID: string, goal: EngineGoal, path: GoalContinuationPath, run: EndedRun) =>
    buildVerdictInput(engineContinuation, stateOf(sessionID), goal, path, run, deps.todoCounts(sessionID))

  async function denied(sessionID: string, goal: EngineGoal, input: GoalContinuationInput, reason: string) {
    if (goal.status !== "active" || reason === "not-eligible" || reason === "single-flight") return
    const stoppedReason = reason as keyof GoalEngine["recovery"]["blockedReason"]
    const stopped = await engine.store.recordGoalContinuationStopped(
      deps.ref(sessionID),
      goal,
      Date.now(),
      engine.recovery.blockedReason[stoppedReason],
      {
        reason: stoppedReason,
        consecutiveContinuations: input.consecutiveContinuations,
        unattendedContinuations: goal.unattendedContinuations ?? 0,
        noProgressContinuations: goal.noProgressContinuations ?? 0,
      },
    )
    if (stopped.recorded) changed(sessionID, stopped.goal)
  }

  async function admit(sessionID: string, goal: EngineGoal, path: GoalContinuationPath, run: EndedRun) {
    const state = stateOf(sessionID)
    const input =
      path === "sessionStart"
        ? { ...verdictInput(sessionID, goal, path, run), ...SESSION_START_INPUT }
        : verdictInput(sessionID, goal, path, run)
    const verdict = engineContinuation.evaluateGoalContinuation({ goal, ...input })
    if (verdict.kind === "deny") {
      await denied(sessionID, goal, input, verdict.reason)
      return false
    }
    const recorded = await engine.store.recordContinuationDelivered(
      deps.ref(sessionID),
      input.currentSignature,
      goal.id,
      { countUnattended: path !== "monitorDelayed" },
    )
    if (recorded === null) return false
    if (verdict.prompt === "minimal") state.lengthRecoveries.set(goal.id, input.consecutiveLengthRecoveries + 1)
    let text =
      verdict.prompt === "minimal"
        ? engine.prompt.buildTruncationRecoveryPrompt()
        : engine.prompt.buildContinuationPrompt(goal, { modelId: await deps.modelId(sessionID) })
    if (verdict.stallNotice)
      text = `${engine.prompt.buildGoalStallNotice(state.toollessStreak, { liveSources: [] })}\n\n${text}`
    state.pending = true
    await deps.deliver(
      sessionID,
      text,
      recorded.consecutiveContinuations ?? 0,
      input.currentSignature,
      path === "sessionStart",
    )
    changed(sessionID, recorded)
    return true
  }

  function schedule(sessionID: string, kind: "userGrace" | "monitor") {
    const state = stateOf(sessionID)
    if (state.timer !== undefined) return
    const delay = kind === "userGrace" ? engineContinuation.GOAL_USER_GRACE_DELAY_MS : engine.backstopDelayMs
    state.timer = deps.timers.set(async () => {
      delete state.timer
      if (state.busy) return
      const goal = await engine.store.readGoal(deps.ref(sessionID))
      if (goal?.status !== "active") return
      await admit(sessionID, goal, kind === "monitor" ? "monitorDelayed" : "userGrace", state.lastRun)
    }, delay)
  }

  return {
    async afterIdle(sessionID: string, settled: EngineGoal | null, run: EndedRun, background: readonly unknown[]) {
      const state = stateOf(sessionID)
      if (settled?.id !== state.goalId) resetContinuationState(state)
      state.goalId = settled?.id
      state.lastRun = run
      if (settled !== null && run.lastStopReason === "stop") state.lengthRecoveries.delete(settled.id)
      if (settled?.status !== "active") {
        cancelTimer(state)
        resetContinuationState(state)
        return false
      }
      const usedTools = engineContinuation.continuationTurnUsedTools(run.messages)
      const toolProgress = recordEndedRun(engineContinuation, state, settled, run, usedTools)
      const immediate = verdictInput(sessionID, settled, "immediate", run)
      const madeProgress = toolProgress || engineContinuation.hasGoalTodoProgress(immediate)
      const goal =
        !state.userInitiated && (madeProgress || engineContinuation.hasGoalContinuationProgress(immediate))
          ? ((await engine.store.resetContinuationStreak(deps.ref(sessionID), { progress: madeProgress })) ?? settled)
          : settled
      const verdict = engineContinuation.evaluateGoalContinuation({
        goal,
        ...verdictInput(sessionID, goal, "immediate", run),
      })
      if (state.userInitiated) {
        state.userInitiated = false
        cancelTimer(state)
        if (verdict.kind === "continue") {
          schedule(sessionID, "userGrace")
          return false
        }
        if (verdict.reason === "not-eligible" || verdict.reason === "single-flight") return false
        return admit(sessionID, goal, "immediate", run)
      }
      if (verdict.kind === "deny" && verdict.reason === "not-eligible") return false
      if (background.length === 0) {
        cancelTimer(state)
        return admit(sessionID, goal, "immediate", run)
      }
      schedule(sessionID, "monitor")
      return false
    },
    /** Native `queueGoalContinuation` after `/goal <objective>` or `/goal resume`: continue now when idle. */
    async queue(sessionID: string, goal: EngineGoal): Promise<boolean> {
      const state = stateOf(sessionID)
      if (goal.status !== "active" || state.busy) return false
      if (goal.id !== state.goalId) {
        resetContinuationState(state)
        state.goalId = goal.id
      }
      return admit(sessionID, goal, "sessionStart", state.lastRun)
    },
    async userPrompt(sessionID: string): Promise<void> {
      const state = stateOf(sessionID)
      cancelTimer(state)
      state.userInitiated = true
      resetContinuationState(state)
      const ref = deps.ref(sessionID)
      const goal = await engine.store.readGoal(ref)
      if (goal?.status === "blocked" && engine.recovery.isMechanicalContinuationBlock(goal.blockedReason)) {
        await engine.store.resetContinuationStreak(ref, { unattended: true })
        changed(sessionID, await engine.store.updateGoal(ref, { status: "active" }, "user"))
        return
      }
      if (goal?.status !== "active") return
      const reset = await engine.store.resetContinuationStreak(ref, { unattended: true })
      if (reset !== null) changed(sessionID, reset)
    },
    async interrupted(sessionID: string, reason: string): Promise<void> {
      const state = stateOf(sessionID)
      state.busy = false
      state.pending = false
      cancelTimer(state)
      if (reason !== "user") return
      const goal = await deps.account(sessionID)
      if (goal?.status !== "active") return
      changed(
        sessionID,
        await engine.store.updateGoal(deps.ref(sessionID), { status: "blocked", reason: USER_ABORT_REASON }, "model"),
      )
    },
    executionStarted(sessionID: string): void {
      stateOf(sessionID).busy = true
    },
    executionEnded(sessionID: string): void {
      stateOf(sessionID).busy = false
    },
    stepStarted(sessionID: string): void {
      const state = stateOf(sessionID)
      state.busy = true
      if (!state.pending) return
      state.pending = false
      state.userInitiated = false
    },
    forget(sessionID: string): void {
      const state = sessions.get(sessionID)
      if (state) cancelTimer(state)
      sessions.delete(sessionID)
    },
    dispose(): void {
      for (const state of sessions.values()) cancelTimer(state)
      sessions.clear()
    },
  }
}

export type GoalContinuation = ReturnType<typeof createGoalContinuation>
