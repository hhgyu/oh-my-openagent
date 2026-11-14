// The snapshot of a failing or frozen engine, or a pause carrying held files (#12284) (Senpi
// `sync-status-copy.ts`): all three exist only while the engine runs, so this ships in the engine chunk
// (`./engine-runtime.ts`), never the memory chunk.

import { rewriteCommandMentions } from "../../commands/namespace"
import type { MemoryRpcSync } from "./ports"
import type { EngineOnlyStatus } from "./status-field"

type Frozen = Extract<EngineOnlyStatus, { readonly kind: "frozen" }>
type Failing = Extract<EngineOnlyStatus, { readonly kind: "failing" }>

const ACTION: Partial<Record<Frozen["reason"], string>> = {
  waiting_recovery: "Run recovery again on this device.",
  waiting_unsupported_freeze: "Update OmO on this device.",
  self_revoked: "Sign in again on this device.",
  no_epoch_key: "Approve this device again from a device that syncs.",
}

/**
 * The snapshot schema accepts only the current failure literals, so a freeze, and a held file (#12284), is a
 * failure of the "unknown" kind; a hold keeps its reason, action, keys and size limit.
 */
export function failureRpcSync(status: EngineOnlyStatus): MemoryRpcSync {
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
  if (status.kind === "paused")
    return status.held === undefined ? { state: "paused" } : { state: "paused", failure: rpcFailure(status.held) }
  return { state: "failing", failure: rpcFailure(status) }
}

function rpcFailure({ failure, since, attempts }: Omit<Failing, "kind">): NonNullable<MemoryRpcSync["failure"]> {
  return {
    kind: failure.kind === "oversized_item" ? "unknown" : failure.kind,
    reason: rewriteCommandMentions(failure.reason),
    action: rewriteCommandMentions(failure.action),
    sinceISO: new Date(since).toISOString(),
    attempts,
    ...(failure.kind === "stranded_lock" ? { paths: failure.paths } : {}),
    ...(failure.kind === "oversized_item"
      ? { keys: failure.keys, stuckKeys: failure.stuck, limitBytes: failure.limitBytes }
      : {}),
  }
}
