import type { Registration } from "@opencode/plugin/promise/registration"
import type { RpcHandlers, RpcRegistration } from "@opencode/plugin/promise/rpc"
import { ulwLoopStatusRpc, type UlwLoopStatus } from "../rpc/ulw-loop"

export interface UlwLoopStatusRpcPort {
  register(
    definition: typeof ulwLoopStatusRpc,
    handlers: RpcHandlers<typeof ulwLoopStatusRpc>,
  ): Promise<RpcRegistration<typeof ulwLoopStatusRpc>>
}

type GoalSource = (sessionID: string) => Promise<string | undefined>

// Native's footer carries two statuses, the ulw-loop frames and the goal UI text; V2 serves both on one RPC.
export function createUlwLoopStatusRpc() {
  const states = new Map<string, { active: boolean; goal?: string; goalKnown: boolean }>()
  let events: RpcRegistration<typeof ulwLoopStatusRpc>["events"] | undefined
  let goalSource: GoalSource | undefined
  const stateOf = (sessionID: string) => {
    let state = states.get(sessionID)
    if (!state) states.set(sessionID, (state = { active: false, goalKnown: false }))
    return state
  }
  const snapshot = (sessionID: string): UlwLoopStatus => {
    const state = states.get(sessionID)
    return {
      sessionID,
      active: state?.active ?? false,
      ...(state?.goal !== undefined && { goal: state.goal }),
    }
  }
  const emit = (sessionID: string) => {
    void events?.emit("updated", snapshot(sessionID)).catch((error: unknown) => {
      console.warn("[oh-my-openagent/v2] footer status update skipped", sessionID, String(error))
    })
  }
  return {
    async register(rpc: UlwLoopStatusRpcPort): Promise<Registration> {
      const registration = await rpc.register(ulwLoopStatusRpc, {
        status: async ({ sessionID }) => {
          const state = stateOf(sessionID)
          if (!state.goalKnown && goalSource) {
            const goal = await goalSource(sessionID).catch(() => undefined)
            if (!state.goalKnown) {
              state.goalKnown = true
              if (goal === undefined) delete state.goal
              else state.goal = goal
            }
          }
          return snapshot(sessionID)
        },
      })
      events = registration.events
      return registration
    },
    readGoalsFrom(source: GoalSource): void {
      goalSource = source
    },
    publish(sessionID: string, isActive: boolean): void {
      const state = stateOf(sessionID)
      if (state.active === isActive) return
      state.active = isActive
      emit(sessionID)
    },
    publishGoal(sessionID: string, goal: string | undefined): void {
      const state = stateOf(sessionID)
      const changed = state.goal !== goal
      state.goalKnown = true
      if (goal === undefined) delete state.goal
      else state.goal = goal
      if (changed) emit(sessionID)
    },
    forget(sessionID: string): void {
      states.delete(sessionID)
    },
    close(): void {
      events = undefined
      goalSource = undefined
      states.clear()
    },
  }
}

export type UlwLoopStatusRpc = ReturnType<typeof createUlwLoopStatusRpc>
