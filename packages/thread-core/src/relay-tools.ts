import type { Static } from "typebox"

import { UNKNOWN_CALLER } from "./caller"
import type {
  ThreadAnswerInput,
  ThreadBindingsInput,
  ThreadBindInput,
  ThreadOutboxAckInput,
  ThreadOutboxInput,
  ThreadRebindInput,
  ThreadReportInput,
  ThreadToolResult,
  ThreadUnbindInput,
  threadToolParamSchemas,
} from "./contracts"
import type { GatewayRelay } from "./gateway/relay"
import { failure } from "./tool-result"

export type RelayToolName =
  | "thread_bind"
  | "thread_unbind"
  | "thread_rebind"
  | "thread_bindings"
  | "thread_report"
  | "thread_outbox"
  | "thread_outbox_ack"
  | "thread_answer"

export const RELAY_TOOL_NAMES: readonly RelayToolName[] = [
  "thread_bind",
  "thread_unbind",
  "thread_rebind",
  "thread_bindings",
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
  /** Resolves a session address other than the caller itself to its durable id, or answers the failure. */
  readonly resolveSession: (
    address: string,
    callerId: string,
    allScope: boolean | undefined,
  ) => Promise<{ readonly id: string } | ThreadToolResult>
  readonly latestCompletionArm: (durableId: string) => Promise<number | null>
  readonly callerRunDeliveries?: () => readonly string[]
  readonly callerRunHasLocalInput?: () => boolean
  readonly onCompletionArmed?: (durableId: string, armSeq: number) => void
}

/**
 * The eight relay tools' bodies, shared by every host. They run over the gateway store alone: no host listing is taken
 * unless a session address other than the caller has to be resolved. Mutations are idempotent per `(caller, tool, key)`
 * inside the store transaction that performs them.
 */
export function createRelayToolBodies(context: RelayToolBodiesContext): RelayToolBodies {
  const { relay } = context

  async function sessionOf(
    address: string | undefined,
    callerId: string,
    allScope: boolean | undefined,
  ): Promise<{ readonly id: string } | ThreadToolResult> {
    if (address === undefined || address === "self" || (address === callerId && callerId !== UNKNOWN_CALLER)) {
      if (callerId === UNKNOWN_CALLER)
        return failure(
          "caller_context_missing",
          "The calling session's durable id is unknown.",
          "Name the session explicitly, or retry from a session that passes its execution context.",
        )
      return { id: callerId }
    }
    return await context.resolveSession(address, callerId, allScope)
  }

  const principal = (callerId: string) => `session:${callerId}`

  return {
    thread_bind: async ({ value, callerId, key }) => {
      const input = value as ThreadBindInput
      const session = await sessionOf(input.session, callerId, input.all_scope)
      if ("kind" in session) return session
      return (await relay.bind({
        principal: principal(callerId),
        idempotency_key: key,
        binding: {
          platform: input.platform,
          account_id: input.account_id,
          chat_id: input.chat_id,
          ...(input.thread_id === undefined ? {} : { thread_id: input.thread_id }),
          ...(input.root_message_id === undefined ? {} : { root_message_id: input.root_message_id }),
          ...(input.progress_message_id === undefined ? {} : { progress_message_id: input.progress_message_id }),
          session_durable_id: session.id,
          ...(input.direction === undefined ? {} : { direction: input.direction }),
          ...(input.inbound_mode === undefined ? {} : { inbound_mode: input.inbound_mode }),
          ...(input.outbound_events === undefined ? {} : { outbound_events: input.outbound_events }),
          ...(input.policy_id === undefined ? {} : { policy_id: input.policy_id }),
          ...(input.ttl_seconds === undefined ? {} : { ttl_seconds: input.ttl_seconds }),
        },
      })) as ThreadToolResult
    },
    thread_unbind: async ({ value, callerId, key }) => {
      const input = value as ThreadUnbindInput
      return (await relay.unbind({
        principal: principal(callerId),
        idempotency_key: key,
        binding_id: input.binding_id,
        expected_revision: input.expected_revision,
      })) as ThreadToolResult
    },
    thread_rebind: async ({ value, callerId, key }) => {
      const input = value as ThreadRebindInput
      const session = await sessionOf(input.session, callerId, input.all_scope)
      if ("kind" in session) return session
      return (await relay.rebind({
        principal: principal(callerId),
        idempotency_key: key,
        binding_id: input.binding_id,
        expected_revision: input.expected_revision,
        session_durable_id: session.id,
      })) as ThreadToolResult
    },
    thread_bindings: async ({ value, callerId }) => {
      const input = value as ThreadBindingsInput
      let sessionFilter: string | undefined
      if (input.session !== undefined) {
        const session = await sessionOf(input.session, callerId, input.all_scope)
        if ("kind" in session) return session
        sessionFilter = session.id
      }
      return (await relay.bindings({
        filter: {
          ...(sessionFilter === undefined ? {} : { session_durable_id: sessionFilter }),
          ...(input.platform === undefined ? {} : { platform: input.platform }),
          ...(input.account_id === undefined ? {} : { account_id: input.account_id }),
          ...(input.chat_id === undefined ? {} : { chat_id: input.chat_id }),
          ...(input.thread_id === undefined ? {} : { thread_id: input.thread_id }),
          ...(input.status === undefined ? {} : { status: input.status }),
        },
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })) as ThreadToolResult
    },
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
            "Read the binding's outbox with thread_outbox to see whether the completion was sent; to arm another, report again under a new idempotency_key.",
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
