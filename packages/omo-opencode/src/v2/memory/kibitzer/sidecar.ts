// The V2 resident Kibitzer: ONE owned child per bound main session, created lazily on the first
// wake-eligible batch, closed on unload and never recreated after it. Same state machine as the
// Senpi sidecar (omo-senpi `kibitzer/sidecar.ts`):
//
//   idle ──wake──▶ turn_running ──settle──▶ idle
//                       │   ▲                  │  context budget reached
//                       │   └─ late steers replay through ONE followUp
//                       │                      ▼
//              child failed / no child      reseeding ──wake──▶ turn_running (replacement child)
//                       ▼
//                    backoff ──timer──▶ idle (recreated lazily by the next wake)
//   any ──shutdown──▶ disposed
//
// Hook events only buffer; a provider turn happens when `offer` brings a candidate path the child
// has not seen and the session has not surfaced. Every seed / followUp holds one machine-wide
// `recall-wake` lease until the turn settles; a steer joins the turn under it. The lease is released
// on every exit.

import { decideWake } from "@oh-my-opencode/memory-core/recall-sidecar"
import type { KibitzerOfferInput, KibitzerOfferResult, KibitzerSidecarOptions, KibitzerSidecarState, KibitzerToolBinding } from "./contract"
import type { KibitzerEvent } from "./events"
import { chargeBudget, createSidecarCore } from "./sidecar-core"
import { createTurnLifecycle } from "./sidecar-turn"
import { createWakeTransitions } from "./sidecar-wake"

const TASK_SUMMARY_HEAD_CHARS = 200

export interface KibitzerSidecar {
  readonly sessionId: string
  state(): KibitzerSidecarState
  readonly events: {
    onPrompt(text: string): boolean
    onAssistant(text: string): boolean
    onToolCall(tool: string, callId: string | undefined, input: unknown): boolean
    onToolResult(tool: string, callId: string | undefined, isError: boolean, output: unknown): boolean
    lastCursor(): number | undefined
  }
  offer(input: KibitzerOfferInput): Promise<KibitzerOfferResult>
  /** A tool call of the given child session started or ended (budget accounting). */
  observeChildTool(childSessionId: string, phase: "start" | "end", callId: string): void
  /** The live binding for a tool call from this sidecar's CURRENT child; undefined otherwise. */
  toolBinding(childSessionId: string): KibitzerToolBinding | undefined
  /** `session_entries` page source: recorded parent events after a cursor. */
  history(since: number): readonly KibitzerEvent[]
  shutdown(): Promise<void>
  whenIdle(): Promise<void>
}

export function createKibitzerSidecar(options: KibitzerSidecarOptions): KibitzerSidecar {
  const core = createSidecarCore(options)
  const turns = createTurnLifecycle(core)
  const wake = createWakeTransitions(core, turns)

  function offer(input: KibitzerOfferInput): Promise<KibitzerOfferResult> {
    return core.serialized(async () => {
      if (core.closing || core.state === "disposed") return { action: "buffered", reason: "disposed" }
      for (const path of input.surfaced) core.surfaced.add(path)
      if (core.state === "backoff") return { action: "buffered", reason: "backoff" }
      const decision = decideWake({ candidates: input.candidates, offered: core.offered, surfaced: core.surfaced, maxItems: input.maxItems, cooldown: core.cooldown })
      if (!decision.wake) return { action: "buffered", reason: decision.reason }
      if (input.taskSummary !== undefined) core.taskSummary = input.taskSummary
      const current = core.child
      switch (core.state) {
        case "turn_running": {
          const turn = core.activeTurn
          if (turn === undefined || current === undefined) throw new Error("kibitzer sidecar invariant broken: turn_running without a live turn")
          return wake.steer(current, turn, decision.candidates, input.maxItems)
        }
        case "idle":
          return current === undefined ? wake.seed(decision.candidates, input.maxItems) : wake.followUp(current, decision.candidates, input.maxItems)
        case "reseeding":
          return wake.seed(decision.candidates, input.maxItems)
        default:
          return core.state satisfies never
      }
    })
  }

  async function shutdown(): Promise<void> {
    // Before the mutex: an offer parked on the wake lease lets go now, not after its bounded wait.
    core.closing = true
    core.admission?.abort()
    await core.serialized(async () => {
      if (core.state === "disposed") return
      turns.clearBackoff()
      const turn = core.activeTurn
      const current = core.child
      if (turn !== undefined && current !== undefined) {
        turn.abort = "shutdown"
        turns.clearDeadline(turn)
        await turns.abortChild(current, "shutdown")
        // Settle inline: shutdown never depends on the interrupted turn reporting back.
        await wake.settle(turn, { status: "cancelled", userTexts: [] })
      }
      turns.disposeChild()
      core.activeTurn = undefined
      core.pendingReseed = undefined
      core.carry = []
      core.state = "disposed"
    })
    await Promise.allSettled([...core.disposals])
    await options.port.close()
  }

  function rememberTask(text: string): void {
    if (core.taskSummary !== undefined) return
    const line = text.replace(/\s+/g, " ").trim()
    if (line.length === 0) return
    core.taskSummary = line.length > TASK_SUMMARY_HEAD_CHARS ? line.slice(0, TASK_SUMMARY_HEAD_CHARS) : line
  }

  const live = () => core.state !== "disposed" && !core.closing

  return {
    sessionId: core.sessionId,
    state: () => core.state,
    events: {
      onPrompt(text) {
        if (!live()) return false
        rememberTask(text)
        return core.stream.onPrompt(text)
      },
      onAssistant: text => live() && core.stream.onAssistant(text),
      onToolCall: (tool, callId, input) => live() && core.stream.onToolCall(tool, callId, input),
      onToolResult: (tool, callId, isError, output) => live() && core.stream.onToolResult(tool, callId, isError, output),
      lastCursor: () => core.stream.lastCursor(),
    },
    offer,
    observeChildTool(childSessionId, phase, callId) {
      if (core.child?.handle.sessionID === childSessionId) turns.observeTool(phase, callId)
    },
    toolBinding(childSessionId) {
      const current = core.child
      if (!live() || current === undefined || current.handle.sessionID !== childSessionId) return undefined
      const budget = core.budget
      return {
        parentSessionId: core.sessionId,
        offered: core.offered,
        searched: current.searched,
        surfaced: core.surfaced,
        maxItems: core.activeTurn?.maxItems ?? 0,
        accepted: core.accepted,
        charge: callId => chargeBudget(budget, callId),
        budgetLimit: budget.limit,
      }
    },
    history: since => core.stream.history(since),
    shutdown,
    whenIdle: core.whenIdle,
  }
}
