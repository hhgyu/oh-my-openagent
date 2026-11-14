import type { AgentSessionEvent } from "@code-yeongyu/senpi"

import type { RunnerOutcome } from "../in-process/child-handle"
import { agentEndOutcome } from "./turn-outcome"
import { createHeldTurnSettlement, type HeldTurnSettlementInput } from "../turn-settlement-core"

export {
  sessionIsIdle,
  type SettlementTimerHandle,
  type TurnSettlementProbe,
  type TurnSettlementScheduler,
} from "../turn-settlement-core"

type AgentEndEvent = Extract<AgentSessionEvent, { readonly type: "agent_end" }>

// The held error confirmation (probe, settleConfirmMs, wake gate, scheduler) is the core's; absent
// probe keeps the historical behavior: the outcome waits for agent_idle forever.
export type TurnSettlementInput = HeldTurnSettlementInput<RunnerOutcome> & {
  readonly abortedByUser: () => boolean
  readonly baseline: () => string | undefined
  readonly finalText: () => string | undefined
}

export type TurnSettlement = {
  readonly observe: (event: AgentSessionEvent) => void
  readonly pending: () => RunnerOutcome | undefined
  readonly cancelConfirmation: () => void
  // A wake source the handle tracks just dropped: re-offer the held error a confirmation chance.
  // No-op when nothing is held, a confirmation is already armed, or no probe was wired.
  readonly reconfirmHeld: () => void
}

/**
 * A run's `agent_end` is not the child's last word (omo#9069). The session may continue on its own
 * after it: a stream rule's corrective nudge, a goal backstop or any other settle-time continuation
 * starts a NEW run in the same session. senpi says the session is really done with `agent_idle`,
 * which it emits only when no deferred continuation started and no session work is pending; a
 * continuation announces itself with `agent_start` instead. The held settlement itself is the
 * harness-neutral core (`../turn-settlement-core`); this maps senpi's events onto its edges.
 */
export function createTurnSettlement(input: TurnSettlementInput): TurnSettlement {
  const core = createHeldTurnSettlement<RunnerOutcome>(input)
  const endOutcome = (event: AgentEndEvent): RunnerOutcome =>
    agentEndOutcome(event, input.baseline(), input.finalText(), input.abortedByUser())

  return {
    observe: (event) => {
      switch (event.type) {
        case "agent_start":
          core.begin()
          return
        case "agent_end":
          if (event.willRetry !== false) return
          core.end(endOutcome(event))
          return
        case "agent_idle":
          core.idle()
          return
        default:
          return
      }
    },
    pending: core.pending,
    cancelConfirmation: core.cancelConfirmation,
    reconfirmHeld: core.reconfirmHeld,
  }
}
