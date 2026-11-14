import type { ThreadToolResult } from "@oh-my-opencode/thread-core/contracts"
import { controlRefusalOf } from "@oh-my-opencode/thread-core/control/port"
import { hashArgs } from "@oh-my-opencode/thread-core/gateway/bindings"
import { isLockWaitExceeded } from "@oh-my-opencode/thread-core/gateway/lock-wait"
import type { GatewayStore, ReceiptScope } from "@oh-my-opencode/thread-core/gateway/store"
import { failure } from "@oh-my-opencode/thread-core/tool-result"

/**
 * A non-send tool's idempotency, as the Native surface keeps it: a `prepared` receipt before the side effect and its
 * result after, so a retry under the same key replays the answer, different arguments conflict, and a call whose
 * process died mid-way answers `idempotency_uncertain` instead of running twice.
 */
export async function withToolReceipt(
  store: Pick<GatewayStore, "now" | "toolReceiptBegin" | "toolReceiptSettle">,
  scope: ReceiptScope,
  args: unknown,
  body: () => Promise<ThreadToolResult>,
): Promise<ThreadToolResult> {
  let admission: Awaited<ReturnType<GatewayStore["toolReceiptBegin"]>>
  try {
    admission = await store.toolReceiptBegin({ ...scope, now: store.now(), args_hash: hashArgs(args) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return isLockWaitExceeded(error)
      ? failure(
          "overloaded",
          `The gateway store is locked by another process; nothing ran: ${message}`,
          "Wait a few seconds, then retry the call.",
        )
      : failure(
          "internal_error",
          `The gateway store could not record the call; nothing ran: ${message}`,
          "Retry the call; if it keeps failing, check the gateway store.",
        )
  }
  if (admission.kind === "replay") return admission.result as ThreadToolResult
  if (admission.kind === "conflict")
    return failure(
      "idempotency_conflict",
      "The idempotency key was already used with different arguments.",
      "Retry with a new idempotency_key.",
    )
  if (admission.kind === "in_progress")
    return failure(
      "idempotency_in_progress",
      "The same operation is already in progress.",
      "Wait for the earlier call to settle, then retry.",
    )
  if (admission.kind === "uncertain")
    return failure(
      "idempotency_uncertain",
      "The earlier operation may have been delivered.",
      "Read the target transcript before deciding whether to retry.",
      admission.error_note === null ? undefined : { error_note: admission.error_note },
    )
  let result: ThreadToolResult
  try {
    result = await body()
  } catch (error) {
    const refusal = controlRefusalOf(error)
    if (refusal === undefined) {
      const message = error instanceof Error ? error.message : String(error)
      await store.toolReceiptSettle({ ...scope, now: store.now(), error_note: message }).catch(() => false)
      throw error
    }
    result = { kind: "error", error: refusal }
  }
  await store.toolReceiptSettle({ ...scope, now: store.now(), result }).catch(() => false)
  return result
}
