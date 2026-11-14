// Senpi's per-session goal accounting window: opened for an active goal, closed out into the engine's store on each
// read and on settle, fed by `session.step.ended` tokens (input as input, output plus reasoning as output).
import type { EngineGoal, GoalAccountingMode, GoalEngine, GoalStoreRef, GoalUsage } from "./engine"

const emptyUsage = (): GoalUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 })

interface Accounting {
  window?: { readonly goalId: string; measuredFrom: number }
  pending: GoalUsage
}

export function createGoalAccounting(store: GoalEngine["store"]) {
  const sessions = new Map<string, Accounting>()
  const accountingOf = (sessionID: string) => {
    let state = sessions.get(sessionID)
    if (!state) sessions.set(sessionID, (state = { pending: emptyUsage() }))
    return state
  }
  const begin = (goal: EngineGoal) => {
    if (goal.status !== "active" || goal.continuationStoppedAt !== undefined) return
    const state = accountingOf(goal.threadId)
    if (state.window?.goalId === goal.id) return
    state.pending = emptyUsage()
    state.window = { goalId: goal.id, measuredFrom: Date.now() }
  }
  return {
    begin,
    async account(ref: GoalStoreRef, mode: GoalAccountingMode): Promise<EngineGoal | null> {
      const state = accountingOf(ref.threadId)
      const window = state.window
      if (window === undefined) {
        // A reload drops the in-memory window; Native reopens it at session start for an active goal.
        const goal = await store.readGoal(ref)
        if (goal) begin(goal)
        return goal
      }
      const usage = state.pending
      state.pending = emptyUsage()
      const now = Date.now()
      const elapsedSeconds = Math.max(0, Math.round((now - window.measuredFrom) / 1000))
      const goal = await store.accountGoalUsage(ref, usage, elapsedSeconds, mode, window.goalId)
      if (goal?.id === window.goalId) state.window = { goalId: window.goalId, measuredFrom: now }
      else delete state.window
      return goal
    },
    completed(goal: EngineGoal): void {
      accountingOf(goal.threadId).window = { goalId: goal.id, measuredFrom: Date.now() }
    },
    tokens(sessionID: string, tokens: { input?: number; output?: number; reasoning?: number }): void {
      const state = sessions.get(sessionID)
      if (!state?.window) return
      state.pending.input += Math.max(0, tokens.input ?? 0)
      state.pending.output += Math.max(0, (tokens.output ?? 0) + (tokens.reasoning ?? 0))
    },
    forget(sessionID: string): void {
      sessions.delete(sessionID)
    },
    clear(): void {
      sessions.clear()
    },
  }
}
