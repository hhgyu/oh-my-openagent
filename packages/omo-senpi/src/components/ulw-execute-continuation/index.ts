import {
  renderUlwExecuteContinuation,
  ULW_EXECUTE_CONTINUATION_LIMIT as CONTINUATION_LIMIT,
  ULW_EXECUTE_STEERING_REMINDER,
  ulwExecuteContinuationSignature,
} from "@oh-my-opencode/boulder-state"

import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { readAgentEndOutcome } from "./agent-end-eligibility"
import { findContinuableBoulderWork } from "./boulder-eligibility"
import { createRunCompletionTracker } from "./run-completion"

export interface UlwExecuteContinuationComponentOptions {
  // none yet; retained for future DI seams
}

interface InputEventLike {
  text: string
  source?: unknown
  images?: unknown
  streamingBehavior?: unknown
}

interface SessionManagerLike {
  getSessionId(): string | undefined
}

export function createUlwExecuteContinuationComponent(
  _options: UlwExecuteContinuationComponentOptions = {},
): OmoSenpiComponent {
  return {
    name: "ulw-execute-continuation",
    register(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      const state = {
        consecutiveContinuations: 0,
        lastSignature: undefined as string | undefined,
        // This run's agent_end payload and session identity. The decision runs on agent_settled.
        pendingRun: undefined as
          { payload: unknown; sessionId: string | undefined; cwd: string | undefined } | undefined,
      }
      const runCompletion = createRunCompletionTracker((runId) => {
        try {
          pi.lifecycle?.markRunCompleted({ runId })
        } catch (error) {
          ctx.logger.warn("omo-senpi ulw-execute run completion not recorded", {
            runId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })

      pi.on("input", async (payload, eventCtx) => {
        if (!isInputEvent(payload)) return { action: "continue" }
        if (!isUserSourcedInput(payload)) return { action: "continue" }

        state.consecutiveContinuations = 0
        state.lastSignature = undefined
        state.pendingRun = undefined
        const sessionId = extractSessionId(eventCtx)
        const cwd = extractCwd(eventCtx)
        // The baseline for run completion: what this session's work looked like before the turn this input starts.
        if (sessionId && cwd) runCompletion.observe(cwd, sessionId)
        if (payload.streamingBehavior === undefined) return { action: "continue" }
        if (!sessionId || !cwd) return { action: "continue" }

        const continuable = findContinuableBoulderWork(cwd, sessionId)
        if (!continuable) return { action: "continue" }

        return {
          action: "transform",
          text: `${payload.text}\n\n${ULW_EXECUTE_STEERING_REMINDER}`,
          ...(Array.isArray(payload.images) ? { images: payload.images } : {}),
        }
      })

      // Record only: the outcome is decided on agent_settled, the host edge that guarantees no
      // automatic retry, compaction or queued continuation will run, and the last point at which a
      // late user abort can still have mutated this payload.
      pi.on("agent_end", (payload, eventCtx) => {
        state.pendingRun = { payload, sessionId: extractSessionId(eventCtx), cwd: extractCwd(eventCtx) }
      })

      pi.on("agent_settled", () => {
        const run = state.pendingRun
        state.pendingRun = undefined
        if (run === undefined) return
        // A work this run completed is a completion whatever the run's own outcome, so this precedes every skip below.
        if (run.sessionId && run.cwd) runCompletion.observe(run.cwd, run.sessionId)

        const outcome = readAgentEndOutcome(run.payload)
        if (outcome.blockedBy !== null) {
          ctx.logger.info("omo-senpi ulw-execute-continuation skipped", {
            reason: "terminal-outcome",
            blockedBy: outcome.blockedBy,
            stopReason: outcome.stopReason,
            aborted: outcome.aborted,
            willRetry: outcome.willRetry,
          })
          return
        }
        if (state.consecutiveContinuations >= CONTINUATION_LIMIT) {
          ctx.logger.info("omo-senpi ulw-execute-continuation skipped", {
            reason: "continuation-cap-reached",
            count: state.consecutiveContinuations,
          })
          return
        }

        const { sessionId, cwd } = run
        if (!sessionId || !cwd) {
          ctx.logger.info("omo-senpi ulw-execute-continuation skipped", { reason: "missing-context" })
          return
        }

        const continuable = findContinuableBoulderWork(cwd, sessionId)
        if (!continuable) {
          state.lastSignature = undefined
          ctx.logger.info("omo-senpi ulw-execute-continuation skipped", { reason: "not-continuable" })
          return
        }

        const signature = ulwExecuteContinuationSignature(continuable)
        if (state.lastSignature === signature) {
          ctx.logger.info("omo-senpi ulw-execute-continuation skipped", { reason: "stale-signature" })
          return
        }

        state.lastSignature = signature
        state.consecutiveContinuations += 1

        const content = renderUlwExecuteContinuation(cwd, continuable, `senpi:${sessionId}`)

        deliverContinuation(pi, ctx, content)
      })
    },
  }
}

const ULW_EXECUTE_CONTINUATION_INJECTION_KEY = "omo-senpi-ulw-execute-continuation"

function deliverContinuation(pi: SenpiExtensionAPI, ctx: ComponentContext, content: string): void {
  if (ctx.idleCoordinator !== undefined) {
    const accepted = ctx.idleCoordinator.enqueue({
      key: ULW_EXECUTE_CONTINUATION_INJECTION_KEY,
      source: "boulder-continuation",
      customType: "omo-senpi:ulw-execute-continuation",
      content,
      display: false,
    })
    // Refused = the coordinator retired with the session. The continuation is derived state, not a
    // durable notification: the next boulder edge re-derives it. Log rather than drop in silence.
    if (accepted === false) {
      ctx.logger.warn("omo-senpi ulw execute continuation skipped: idle-injection coordinator retired")
      return
    }
    ctx.idleCoordinator.scheduleFlush()
    return
  }
  pi.sendMessage(
    {
      customType: "omo-senpi:ulw-execute-continuation",
      content,
      display: false,
    },
    { triggerTurn: true, deliverAs: "followUp" },
  )
}

function extractCwd(eventCtx: unknown): string | undefined {
  if (isRecord(eventCtx) && typeof eventCtx["cwd"] === "string") {
    return eventCtx["cwd"]
  }
  return undefined
}

function extractSessionId(eventCtx: unknown): string | undefined {
  const sessionManager = extractSessionManager(eventCtx)
  if (sessionManager === undefined) return undefined
  const id = sessionManager.getSessionId()
  return typeof id === "string" ? id : undefined
}

function extractSessionManager(eventCtx: unknown): SessionManagerLike | undefined {
  if (!isRecord(eventCtx)) return undefined
  const value = eventCtx["sessionManager"]
  if (!isRecord(value)) return undefined
  if (typeof value["getSessionId"] !== "function") return undefined
  return value as unknown as SessionManagerLike
}

function isInputEvent(value: unknown): value is InputEventLike {
  return isRecord(value) && typeof value["text"] === "string"
}

function isUserSourcedInput(value: InputEventLike): boolean {
  return value.source !== "extension"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
