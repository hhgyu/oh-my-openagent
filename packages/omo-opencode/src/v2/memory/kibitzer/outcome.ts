// How one resident wake ended (V2 port of omo-senpi `sidecar-outcome.ts` + `judge-outcome.ts`). A
// sidecar abort (tool budget, deadline, shutdown) wins over whatever the child reports for the
// interrupted turn and is never a failure; only a child turn that settled with an error, or a child
// that could not start, is diagnostic.

import { containsSecretLikeMaterial, type RecallNudge } from "@oh-my-opencode/memory-core"
import type { KibitzerChildTurnReport } from "./contract"

const GATE_REASON_MAX_CHARS = 160

export type KibitzerWakeAbort = "tool_budget" | "deadline" | "shutdown"
export type KibitzerWakeFailureCause = "child_failed" | "child_failed_upstream" | "start_failed"

export type KibitzerWakeEnd =
  | { readonly status: "completed" }
  | { readonly status: "tool_budget_exceeded" }
  | { readonly status: "deadline" }
  | { readonly status: "failed"; readonly cause: KibitzerWakeFailureCause; readonly reason?: string }
  | { readonly status: "cancelled"; readonly cause: "shutdown" }

export interface KibitzerWakeOutcome {
  readonly sessionId: string
  readonly wake: number
  readonly generation: number
  readonly status: KibitzerWakeEnd["status"]
  readonly cause?: KibitzerWakeFailureCause | "shutdown"
  readonly reason?: string
  readonly model?: string
  readonly nudges: readonly RecallNudge[]
  readonly candidateCount: number
  readonly steered: number
  readonly toolCalls: number
  readonly durationMs: number
  readonly slotWaitMs: number
  readonly cursors?: { readonly first: number; readonly last: number }
  readonly contextTokens?: number
  readonly usage?: KibitzerChildTurnReport["usage"]
  readonly diagnostic: boolean
}

/** Senpi's empty-assistant recovery message: a silent judge is a completed turn, not a failure. */
const EMPTY_RESPONSE_TWICE = "Model returned an empty response twice"
const UPSTREAM_FAILURE_PATTERN = /\b503\b|auth[_ -]?unavailable|overloaded/iu

export function classifyWakeEnd(
  report: KibitzerChildTurnReport,
  abort: KibitzerWakeAbort | undefined,
): KibitzerWakeEnd {
  switch (abort) {
    case "tool_budget":
      return { status: "tool_budget_exceeded" }
    case "deadline":
      return { status: "deadline" }
    case "shutdown":
      return { status: "cancelled", cause: "shutdown" }
    case undefined:
      break
    default:
      return abort satisfies never
  }
  if (report.status === "completed") return { status: "completed" }
  // A turn cancelled outside the sidecar: the child is gone from under it.
  if (report.status === "cancelled")
    return { status: "failed", cause: "child_failed", reason: "child turn was cancelled outside the sidecar" }
  const reason = normalizeGateReason(report.message)
  if (reason === EMPTY_RESPONSE_TWICE) return { status: "completed" }
  if (reason === undefined) return { status: "failed", cause: "child_failed" }
  return {
    status: "failed",
    cause: UPSTREAM_FAILURE_PATTERN.test(reason) ? "child_failed_upstream" : "child_failed",
    reason,
  }
}

export function startFailureEnd(error: unknown): Extract<KibitzerWakeEnd, { readonly status: "failed" }> {
  const reason = normalizeGateReason(error instanceof Error ? error.message : String(error))
  return { status: "failed", cause: "start_failed", ...(reason === undefined ? {} : { reason }) }
}

export function isDiagnosticWakeEnd(end: KibitzerWakeEnd): boolean {
  return end.status === "failed"
}

/** Bounded, control-free, secret-safe one-line reason. */
function normalizeGateReason(message: string | undefined): string | undefined {
  if (message === undefined) return undefined
  const text = message
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
  if (text.length === 0) return undefined
  if (containsSecretLikeMaterial(text)) return "redacted"
  return text.length > GATE_REASON_MAX_CHARS ? `${text.slice(0, GATE_REASON_MAX_CHARS - 1)}…` : text
}
