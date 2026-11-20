import type { Static } from "typebox"

import { UNKNOWN_CALLER } from "./caller"
import type {
  ThreadAnswerInput,
  ThreadOutboxAckInput,
  ThreadOutboxInput,
  ThreadReportInput,
  ThreadToolResult,
  threadToolParamSchemas,
} from "./contracts"
import type { GatewayRelay } from "./gateway/relay"
import { failure } from "./tool-result"

export type RelayToolName = "thread_report" | "thread_outbox" | "thread_outbox_ack" | "thread_answer"

export const RELAY_TOOL_NAMES: readonly RelayToolName[] = [
  "thread_report",
  "thread_outbox",
  "thread_outbox_ack",
  "thread_answer",
]

export type RelayToolCall<T extends RelayToolName> = {
  readonly value: Static<(typeof threadToolParamSchemas)[T]>
  readonly callerId: string
  readonly key: string
}

export type RelayToolBodies = {
  readonly [T in RelayToolName]: (call: RelayToolCall<T>) => Promise<ThreadToolResult>
}

export type RelayToolBodiesContext = {
  readonly relay: GatewayRelay
  readonly latestCompletionArm: (durableId: string) => Promise<number | null>
  readonly callerRunDeliveries?: () => readonly string[]
  readonly callerRunHasLocalInput?: () => boolean
  readonly onCompletionArmed?: (durableId: string, armSeq: number) => void
}

/**
 * The four relay tools' bodies, shared by every host. They run over the gateway store alone and take no host listing.
 * Binding a chat thread is not a session tool: the gateway writes, moves and expires bindings through the relay SDK as
 * its own principal. Mutations are idempotent per `(caller, tool, key)` inside the store transaction that performs them.
 */
export function createRelayToolBodies(context: RelayToolBodiesContext): RelayToolBodies {
  const { relay } = context

  const principal = (callerId: string) => `session:${callerId}`

  return {
    thread_report: async ({ value, callerId, key }) => {
      const input = value as ThreadReportInput
      if (callerId === UNKNOWN_CALLER)
        return failure(
          "caller_context_missing",
          "A report comes from the calling session, whose durable id is unknown.",
          "Retry from a session that passes its execution context.",
        )
      const origins = input.binding_id === undefined ? context.callerRunDeliveries?.() : undefined
      const localInput = input.binding_id === undefined && context.callerRunHasLocalInput?.() === true
      const reported = await relay.report({
        principal: principal(callerId),
        idempotency_key: key,
        session_durable_id: callerId,
        ...(input.binding_id === undefined ? {} : { binding_id: input.binding_id }),
        ...(origins === undefined ? {} : { origin_delivery_ids: origins }),
        ...(localInput ? { origin_local_input: true } : {}),
        event: input.kind,
        text: input.text,
        ...(input.request_id === undefined ? {} : { request_id: input.request_id }),
        ...(input.request_kind === undefined ? {} : { request_kind: input.request_kind }),
      })
      if (reported.kind !== "ok") return reported as ThreadToolResult
      // The arm's sequence number is the settle watermark, internal to the host; the result stays as documented.
      const { arm_seq: reportedArmSeq, ...result } = reported
      if (typeof reportedArmSeq === "number" && Number.isInteger(reportedArmSeq))
        context.onCompletionArmed?.(callerId, reportedArmSeq)
      else if (result.armed) {
        // A replayed receipt written before arm_seq existed carries none: the session's newest durable arm is the watermark.
        const durableArmSeq = await context.latestCompletionArm(callerId)
        if (durableArmSeq === null)
          return failure(
            "idempotency_uncertain",
            "An earlier completion report under this key was recorded without its arm sequence, and the session has no completion armed now: its completion was already written, or the arm is gone.",
            "Read the binding's outbox with thread_outbox (tool.thread_outbox() in an eval cell) to see whether the completion was sent; to arm another, report again under a new idempotency_key.",
          )
        context.onCompletionArmed?.(callerId, durableArmSeq)
      }
      return result as ThreadToolResult
    },
    thread_outbox: async ({ value }) => {
      const input = value as ThreadOutboxInput
      return (await relay.outbox({
        binding_id: input.binding_id,
        ...(input.after_cursor === undefined ? {} : { after_cursor: input.after_cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })) as ThreadToolResult
    },
    thread_outbox_ack: async ({ value }) => {
      const input = value as ThreadOutboxAckInput
      return (await relay.ack({
        binding_id: input.binding_id,
        cursor: input.cursor,
        ...(input.provider_message_id === undefined ? {} : { provider_message_id: input.provider_message_id }),
      })) as ThreadToolResult
    },
    thread_answer: async ({ value }) => {
      const input = value as ThreadAnswerInput
      return (await relay.answer({
        binding_id: input.binding_id,
        reply_token: input.reply_token,
        answer: input.answer,
      })) as ThreadToolResult
    },
  }
}
