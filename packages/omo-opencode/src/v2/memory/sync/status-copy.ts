// The snapshot of a failing or frozen engine (Senpi `sync-status-copy.ts`): both statuses exist only while
// the engine runs, so this ships in the engine chunk (`./engine-runtime.ts`), never the memory chunk.

import type { MemoryRpcSync } from "./ports"
import type { FailingStatus } from "./status-field"

type Frozen = Extract<FailingStatus, { readonly kind: "frozen" }>

const ACTION: Partial<Record<Frozen["reason"], string>> = {
  waiting_recovery: "Run recovery again on this device.",
  waiting_unsupported_freeze: "Update OmO on this device.",
  self_revoked: "Sign in again on this device.",
  no_epoch_key: "Approve this device again from a device that syncs.",
}

/** The snapshot schema accepts only the current failure literals, so a freeze is a failure of the "unknown" kind. */
export function failureRpcSync(status: FailingStatus): MemoryRpcSync {
  if (status.kind === "frozen") {
    return {
      state: "failing",
      failure: {
        kind: "unknown",
        reason: `Memory sync is paused until the memory key changes after a device was removed (${status.reason}).`,
        action: ACTION[status.reason] ?? "Sync resumes on its own.",
        sinceISO: new Date(status.since).toISOString(),
        attempts: 1,
      },
    }
  }
  const { failure } = status
  return {
    state: "failing",
    failure: {
      kind: failure.kind === "oversized_item" ? "unknown" : failure.kind,
      reason: failure.reason,
      action: failure.action,
      sinceISO: new Date(status.since).toISOString(),
      attempts: status.attempts,
      ...(failure.kind === "stranded_lock" ? { paths: failure.paths } : {}),
    },
  }
}
