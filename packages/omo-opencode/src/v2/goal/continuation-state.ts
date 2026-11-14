// The monitor's per-session guard state (senpi `monitor-continuation.js`): recent output hashes, tool-effect
// fingerprints, the toolless streak and length recoveries, updated from each ended run exactly as Native does.
import type { EngineGoal, GoalContinuationEngine, GoalContinuationInput, GoalContinuationPath } from "./engine"
import { EMPTY_RUN, type EndedRun } from "./run-record"

export interface ContinuationState {
  goalId?: string
  recentHashes: string[]
  recentToolEffects: string[]
  toollessStreak: number
  toollessGoalId?: string
  lengthRecoveries: Map<string, number>
  userInitiated: boolean
  pending: boolean
  busy: boolean
  timer?: unknown
  lastRun: EndedRun
}

export function createContinuationState(): ContinuationState {
  return {
    recentHashes: [],
    recentToolEffects: [],
    toollessStreak: 0,
    lengthRecoveries: new Map(),
    userInitiated: false,
    pending: false,
    busy: false,
    lastRun: EMPTY_RUN,
  }
}

export function resetContinuationState(state: ContinuationState): void {
  state.lengthRecoveries.clear()
  state.recentHashes = []
  state.recentToolEffects = []
  state.toollessStreak = 0
}

/** Records the ended run; true when its tool effects differ from every recent tool turn (progress). */
export function recordEndedRun(
  engine: GoalContinuationEngine,
  state: ContinuationState,
  goal: EngineGoal,
  run: EndedRun,
  usedTools: boolean,
): boolean {
  if (usedTools) state.recentHashes = []
  else if (engine.normalizeAssistantText(run.lastAssistantText).length > 0)
    state.recentHashes = [...state.recentHashes, engine.hashAssistantText(run.lastAssistantText)].slice(-3)
  if (run.lastStopReason !== "error") {
    if (goal.id !== state.toollessGoalId) {
      state.toollessGoalId = goal.id
      state.toollessStreak = 0
    }
    if (!state.userInitiated) state.toollessStreak = usedTools ? 0 : state.toollessStreak + 1
  }
  const fingerprint = engine.toolEffectFingerprint(run.messages)
  if (fingerprint === undefined) return false
  const repeated = state.recentToolEffects.length === 0 || state.recentToolEffects.includes(fingerprint)
  state.recentToolEffects = [...state.recentToolEffects, fingerprint].slice(-engine.GOAL_TOOL_EFFECT_WINDOW)
  return !repeated
}

export function buildVerdictInput(
  engine: GoalContinuationEngine,
  state: ContinuationState,
  goal: EngineGoal,
  path: GoalContinuationPath,
  run: EndedRun,
  todos: { readonly open: number; readonly total: number },
): GoalContinuationInput {
  return {
    isIdle: path === "immediate" || !state.busy,
    hasPendingMessages: false,
    path,
    lastStopReason: run.lastStopReason,
    lastTurnWasMalformedToolUse: run.lastTurnWasMalformedToolUse,
    consecutiveContinuations: goal.consecutiveContinuations ?? 0,
    lastContinuationSignature: goal.lastContinuationSignature,
    currentSignature: engine.buildGoalContinuationSignature(
      goal,
      todos.open,
      todos.total,
      engine.hashAssistantText(run.lastAssistantText),
    ),
    consecutiveLengthRecoveries: state.lengthRecoveries.get(goal.id) ?? 0,
    recentNormalizedOutputHashes: state.recentHashes,
    toollessContinuationStreak: state.toollessStreak,
    continuationPending: state.pending,
    lastTurnStuckOnContextOverflow: false,
  }
}
