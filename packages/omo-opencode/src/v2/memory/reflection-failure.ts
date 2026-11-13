// The failure signal a finished reflection run hands to `ReflectionReservationStore.complete`, so the
// park file keeps the same streak and backoff Senpi keeps (port of omo-senpi
// `worker/failure-policy.ts` `classifyReflectionFailure`). The fingerprint and the distilled cause
// come from memory-core. Not ported: the `definitive` flag Senpi derives from its model-attempt
// chain (`isModelUnreachableDetail`); the V2 child has one model per launch and no attempt chain.

import {
  REFLECTION_PARK_DETAIL_MAX_CHARS,
  type ReflectionFailureSignal,
  type ReflectionOutcome,
} from "@oh-my-opencode/memory-core"
import { childFailureCause, failureFingerprint } from "@oh-my-opencode/memory-core/commands/failure-detail"

export interface ReflectionDecision {
  readonly outcome: ReflectionOutcome
  readonly reason?: string
  readonly detail?: string
  readonly integrationSha?: string
}

// Reasons that cannot heal on their own: the child's environment or output is wrong, not busy.
const NON_RETRYABLE_REASONS = new Set([
  "invalid_target",
  "completion_validation",
  "missing_validated_tip",
  "missing_worktree",
  "secret_like_content",
])

// Outcomes the child did not cause: the parent repo was busy or drifted while the run merged.
const ENVIRONMENTAL_OUTCOMES = new Set<ReflectionOutcome>(["parent_dirty", "merge_conflict", "timed_out"])

const NON_RETRYABLE_DETAIL =
  /\bModel "[^"]+" not found\b|\bmodel_not_visible\b|\bexhausted\b|\bNo API key\b|\bauth_missing\b|\bENOENT\b|\bnot a git repository\b/i

const RETRYABLE_DETAIL =
  /\b(?:429|502|503|504|529)\b|\brate.?limit|\busage_limit|\bcooling down\b|\boverloaded\b|\bEAGAIN\b|\bECONNRESET\b|\bECONNREFUSED\b|\bETIMEDOUT\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\btemporarily unavailable\b|\bsocket hang up\b|\bprovider_unavailable\b|\bdeadline_exceeded\b/i

export function classifyReflectionFailure(decision: ReflectionDecision): ReflectionFailureSignal | undefined {
  if (decision.outcome === "merged" || decision.outcome === "no_changes") return undefined
  const detail = decision.detail?.slice(0, REFLECTION_PARK_DETAIL_MAX_CHARS)
  return {
    fingerprint: failureFingerprint(decision.reason, decision.detail),
    retryable: isRetryable(decision),
    ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    ...(detail === undefined ? {} : { detail }),
  }
}

function isRetryable(decision: ReflectionDecision): boolean {
  if (ENVIRONMENTAL_OUTCOMES.has(decision.outcome)) return true
  if (decision.outcome === "dirty_uncommitted") return false
  if (decision.reason !== undefined && NON_RETRYABLE_REASONS.has(decision.reason)) return false
  const cause = childFailureCause(decision.detail) ?? ""
  if (RETRYABLE_DETAIL.test(cause)) return true
  return !NON_RETRYABLE_DETAIL.test(`${cause}\n${decision.detail ?? ""}`)
}
