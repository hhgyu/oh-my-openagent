import { existsSync } from "node:fs"

import {
  classifyLoopStatusRead,
  createLoopContinuationState,
  NO_PLAN_LOOP_STATUS,
  ULW_LOOP_CONTINUATION_PROMPT,
  ULW_LOOP_STEERING_REMINDER,
  UNSCOPED_LOOP_STATUS,
  type LoopStatus,
} from "../../../../omo-codex/plugin/components/ulw-loop/src/session-sdk/loop-continuation.js"
import { readAgentEndOutcome } from "../ulw-execute-continuation/agent-end-eligibility"
import { findContinuableBoulderWork } from "../ulw-execute-continuation/boulder-eligibility"
import { BUNSHIN_TS_CELL_HINT } from "../../extension/sdk-root-provisioning"
import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { createUlwLoopFooterStatus, type UlwLoopFooterStatusOptions } from "./footer-status"
import { readUlwLoopStatusInProcess } from "./status-source"
import { createRunCompletionTracker } from "./run-completion"
import { extractSessionId, resolveUlwLoopSessionScope, ulwLoopScopedGoalsPath } from "./session-scope"

export interface UlwLoopComponentOptions {
  readStatus?: (cwd: string, sessionId: string) => Promise<{ code: number; stdout: string }>
  planExists?: (cwd: string, sessionId: string) => boolean
  footerStatus?: UlwLoopFooterStatusOptions
}

interface InputEventLike {
  text: string
  source?: unknown
  images?: unknown
  streamingBehavior?: unknown
}

type ActiveStatus = LoopStatus

type ReadStatus = NonNullable<UlwLoopComponentOptions["readStatus"]>
type PlanLookup = NonNullable<UlwLoopComponentOptions["planExists"]>

export function createUlwLoopComponent(options: UlwLoopComponentOptions = {}): OmoSenpiComponent {
  return {
    name: "ulw-loop",
    async register(pi: SenpiExtensionAPI, ctx: ComponentContext): Promise<void> {
      const readStatus = options.readStatus ?? readUlwLoopStatusInProcess
      const planExists = options.planExists ?? ulwLoopPlanExists
      const footerStatus = createUlwLoopFooterStatus(options.footerStatus)
      const runCompletion = createRunCompletionTracker((runId) => {
        try {
          pi.lifecycle?.markRunCompleted({ runId })
        } catch (error) {
          ctx.logger.warn("omo-senpi ulw-loop run completion not recorded", {
            runId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
      // Every session-scoped status read also feeds run completion, so a plan's stop condition is seen wherever it is read.
      const readSessionStatus = async (eventCtx: unknown): Promise<ActiveStatus | null> => {
        const status = await readActiveStatus(readStatus, planExists, eventCtx, ctx)
        if (status !== null && status.sessionScoped !== false) {
          if (status.plan !== undefined) runCompletion.observe(status.plan)
          else if (status.noPlan === true) runCompletion.observe(undefined)
        }
        return status
      }
      const continuation = createLoopContinuationState()
      const state = {
        // This run's agent_end payload plus the status snapshot taken for it. The continuation
        // decision runs on agent_settled, so nothing is recorded across a user turn.
        pendingRun: undefined as { payload: unknown; status: ActiveStatus } | undefined,
      }

      pi.registerRemovedToolHint?.(
        "omo_agent_toolkit",
        'omo_agent_toolkit was removed. Inside an eval js cell: const { agentToolkit } = await import(`${env("OMO_AGENT_TOOLKIT_SDK_ROOT")}/sdk.js`); print(await agentToolkit.status()). Never spawn the toolkit CLI.',
      )
      pi.registerRemovedToolHint?.("bunshin", BUNSHIN_TS_CELL_HINT)

      pi.on("session_start", async (_payload, eventCtx) => {
        const status = await readSessionStatus(eventCtx)
        footerStatus.sync(eventCtx, status?.active ?? false)
      })

      pi.on("input", async (payload, eventCtx) => {
        if (!isInputEvent(payload)) return { action: "continue" }
        if (!isUserSourcedInput(payload)) return { action: "continue" }

        continuation.reset()
        state.pendingRun = undefined
        if (payload.streamingBehavior === undefined) return { action: "continue" }
        const status = await readSessionStatus(eventCtx)
        footerStatus.sync(eventCtx, status?.active ?? false)
        if (status === null || !status.active) return { action: "continue" }
        return {
          action: "transform",
          text: `${payload.text}\n\n${ULW_LOOP_STEERING_REMINDER}`,
          ...(Array.isArray(payload.images) ? { images: payload.images } : {}),
        }
      })

      // agent_end only records this run: it refreshes the footer for EVERY ended run (a blocked
      // outcome must never leave the `⚡ ultraworking` spinner on screen for a finished run) and
      // hands the outcome to agent_settled. No terminal-outcome gate runs here, because this handler
      // is awaited by the host across the status read during which a late Esc mutates
      // this very payload into a user abort, and because a turn the host is holding for required
      // auto-compaction still reports `willRetry: false` here.
      pi.on("agent_end", async (payload, eventCtx) => {
        state.pendingRun = undefined
        if (continuation.capReached()) {
          ctx.logger.info("omo-senpi ulw-loop continuation skipped", {
            reason: "continuation-cap-reached",
            count: continuation.count,
          })
          return
        }

        const cwd = cwdFromContext(eventCtx)
        const sessionId = extractSessionId(eventCtx)
        if (sessionId && findContinuableBoulderWork(cwd, sessionId) !== null) {
          ctx.logger.info("omo-senpi ulw-loop continuation skipped", { reason: "boulder-continuation-active" })
          return
        }

        const status = await readSessionStatus(eventCtx)
        footerStatus.sync(eventCtx, status?.active ?? false)
        if (status === null) {
          return
        }
        state.pendingRun = { payload, status }
      })

      // The host emits agent_settled only once no automatic retry, compaction or queued continuation
      // will run (`dist/core/extensions/types.d.ts` AgentSettledEvent), and it keeps mutating the
      // recorded agent_end event until this boundary closes. Deciding here is what makes a mid-probe
      // abort and a compaction-owned turn observable, and no continuation budget or dedupe signature
      // is consumed before the decision is made.
      pi.on("agent_settled", () => {
        const run = state.pendingRun
        state.pendingRun = undefined
        if (run === undefined) return

        const outcome = readAgentEndOutcome(run.payload)
        if (outcome.blockedBy !== null) {
          ctx.logger.info("omo-senpi ulw-loop continuation skipped", {
            reason: "terminal-outcome",
            blockedBy: outcome.blockedBy,
            stopReason: outcome.stopReason,
            aborted: outcome.aborted,
            willRetry: outcome.willRetry,
          })
          return
        }
        const decision = continuation.decide(run.status)
        if (!decision.continue) {
          ctx.logger.info("omo-senpi ulw-loop continuation skipped", { reason: decision.reason })
          return
        }
        deliverContinuation(pi, ctx)
      })

      pi.on("tool_result", async (payload, eventCtx) => {
        if (!shouldRefreshFooterAfterToolResult(payload)) return
        const status = await readSessionStatus(eventCtx)
        footerStatus.sync(eventCtx, status?.active ?? false)
      })

      pi.on("session_before_switch", () => footerStatus.dispose())
      pi.on("session_shutdown", () => footerStatus.dispose())
    },
  }
}

const ULW_CONTINUATION_INJECTION_KEY = "omo-senpi-ulw-loop-continuation"

// Route the continuation through the idle-injection coordinator when the composition provides one, so
// a task completion and this continuation on the same idle edge collapse to a single wake. The
// continuation only enqueues then requests a DEFERRED flush: a synchronous completion wake on the same
// idle edge drains the shared queue first and carries the continuation with it, so the deferred pass
// no-ops. Falls back to a direct followUp when no coordinator is wired (isolated unit context).
function deliverContinuation(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
  if (ctx.idleCoordinator !== undefined) {
    const accepted = ctx.idleCoordinator.enqueue({
      key: ULW_CONTINUATION_INJECTION_KEY,
      source: "ulw-continuation",
      customType: "omo-senpi:ulw-continuation",
      content: ULW_LOOP_CONTINUATION_PROMPT,
      display: false,
    })
    // Refused = the coordinator retired with the session. The continuation is derived state, not a
    // durable notification: the next turn's agent_end re-derives it. Log rather than drop in silence.
    if (accepted === false) {
      ctx.logger.warn("omo-senpi ulw continuation skipped: idle-injection coordinator retired")
      return
    }
    ctx.idleCoordinator.scheduleFlush()
    return
  }
  pi.sendMessage(
    {
      customType: "omo-senpi:ulw-continuation",
      content: ULW_LOOP_CONTINUATION_PROMPT,
      display: false,
    },
    { triggerTurn: true, deliverAs: "followUp" },
  )
}

function ulwLoopPlanExists(cwd: string, sessionId: string): boolean {
  return existsSync(ulwLoopScopedGoalsPath(cwd, sessionId))
}

async function readActiveStatus(
  readStatus: ReadStatus,
  planExists: PlanLookup,
  eventCtx: unknown,
  ctx: ComponentContext,
): Promise<ActiveStatus | null> {
  const cwd = cwdFromContext(eventCtx)
  // Fail closed: without a session identity the toolkit would answer from the unscoped repo-global
  // `.omo/ulw-loop/goals.json`, which every session sharing this cwd can see. Never auto-continue a run
  // this host cannot prove it owns.
  const sessionId = resolveUlwLoopSessionScope(eventCtx)
  if (sessionId === null) return UNSCOPED_LOOP_STATUS

  if (!planExists(cwd, sessionId)) return NO_PLAN_LOOP_STATUS

  let result: { code: number; stdout: string }
  try {
    result = await readStatus(cwd, sessionId)
  } catch (error) {
    ctx.logger.warn("omo-senpi ulw-loop status ignored", {
      reason: "read-status-failed",
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
  const { status, ignored } = classifyLoopStatusRead(result)
  if (ignored?.reason === "non-zero-exit" && ignored.errorCode === "ULW_LOOP_PLAN_MISSING")
    ctx.logger.debug?.("omo-senpi ulw-loop status ignored", ignored)
  else if (ignored !== undefined) ctx.logger.warn("omo-senpi ulw-loop status ignored", ignored)
  return status
}

function isInputEvent(value: unknown): value is InputEventLike {
  return isRecord(value) && typeof value["text"] === "string"
}

function isUserSourcedInput(value: InputEventLike): boolean {
  return value.source !== "extension"
}

function shouldRefreshFooterAfterToolResult(value: unknown): boolean {
  if (!isRecord(value)) return false
  const toolName = value["toolName"]
  return (
    toolName === "create_goal" ||
    toolName === "update_goal" ||
    toolName === "bash" ||
    toolName === "interactive_bash" ||
    toolName === "eval"
  )
}

function cwdFromContext(value: unknown): string {
  if (isRecord(value) && typeof value["cwd"] === "string") return value["cwd"]
  return process.cwd()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
