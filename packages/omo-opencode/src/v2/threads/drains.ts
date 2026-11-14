import {
  toSessionControlDrainResult,
  type GatewayEndpointPort,
  type GatewayWakeReply,
  type UiAnswer,
  type UiAnswerReply,
  type WakeReason,
} from "@oh-my-opencode/thread-core/gateway/adapter"
import { createInboxDrain, type InboxDrain } from "@oh-my-opencode/thread-core/gateway/drain"
import type { GatewayStore } from "@oh-my-opencode/thread-core/gateway/store"
import type { ThreadV2Host, V2SessionSnapshot } from "./host"
import type { PeerClient } from "./peer"
import { createV2SessionRuntime, type V2SessionRuntime } from "./runtime-port"

export type ThreadDrains = {
  readonly endpoints: GatewayEndpointPort
  readonly respondLocal: (sessionID: string, answer: UiAnswer) => Promise<UiAnswerReply>
  readonly wake: (sessionID: string, deliveryIds: readonly string[], reason: WakeReason) => Promise<GatewayWakeReply>
  readonly release: (sessionID: string) => void
  readonly close: () => void
}

type Entry = { readonly runtime: V2SessionRuntime; readonly drain: InboxDrain; chain: Promise<unknown> }

const CONFIRM_WORDS: ReadonlyMap<string, "once" | "always" | "reject"> = new Map([
  ["yes", "once"],
  ["y", "once"],
  ["true", "once"],
  ["allow", "once"],
  ["once", "once"],
  ["always", "always"],
  ["no", "reject"],
  ["n", "reject"],
  ["false", "reject"],
  ["reject", "reject"],
])

function permissionDecision(answer: UiAnswer): {
  readonly decision: "once" | "always" | "reject"
  readonly message?: string
} {
  const fields = answer.fields as { readonly confirmed?: boolean; readonly value?: string; readonly comment?: string }
  if (typeof fields.confirmed === "boolean" && fields.value === undefined)
    return { decision: fields.confirmed ? "once" : "reject" }
  const text = (fields.value ?? fields.comment ?? "").trim()
  const word = CONFIRM_WORDS.get(text.toLowerCase())
  return word === undefined ? { decision: "reject", message: text } : { decision: word }
}

export function createThreadDrains(input: {
  readonly store: GatewayStore
  readonly host: Pick<ThreadV2Host, "session" | "permission">
  readonly snapshot: (sessionID: string) => Promise<V2SessionSnapshot>
  readonly socket: string
  readonly log: (line: string) => void
  /** Another OpenCode 2 server of the agent dir that publishes this socket (the endpoint registry), if any. */
  readonly peerOf?: (socket: string) => PeerClient | undefined
}): ThreadDrains {
  const entries = new Map<string, Entry>()
  let closed = false

  function entry(sessionID: string): Entry {
    let current = entries.get(sessionID)
    if (current === undefined) {
      const runtime = createV2SessionRuntime({
        sessionID,
        session: input.host.session,
        snapshot: () => input.snapshot(sessionID),
        hopOf: async (deliveryId) => (await input.store.deliveryView(deliveryId))?.row.hop ?? 0,
      })
      const drain = createInboxDrain({
        store: input.store,
        runtime,
        durableId: sessionID,
        sessionPath: () => null,
        log: input.log,
      })
      current = { runtime, drain, chain: Promise.resolve() }
      entries.set(sessionID, current)
    }
    return current
  }

  function wake(sessionID: string, deliveryIds: readonly string[], reason: WakeReason): Promise<GatewayWakeReply> {
    if (closed) return Promise.reject(Error(`host_unavailable:${input.socket}`))
    const target = entry(sessionID)
    const pass = target.chain.then(async () => {
      await target.runtime.refresh()
      return toSessionControlDrainResult(
        await target.drain.drain({ reason, ...(deliveryIds.length > 0 ? { delivery_ids: deliveryIds } : {}) }),
      )
    })
    target.chain = pass.catch(() => undefined)
    return pass
  }

  async function respondUi(
    endpoint: { readonly durable_session_id: string },
    answer: UiAnswer,
  ): Promise<UiAnswerReply> {
    const sessionID = endpoint.durable_session_id
    const pending = await input.host.permission.list({ sessionID })
    if (!pending.some((request) => request.id === answer.ui_request_id))
      return { delivered: false, error: "unknown_request" }
    const { decision, message } = permissionDecision(answer)
    await input.host.permission.reply({
      sessionID,
      requestID: answer.ui_request_id,
      decision,
      ...(message === undefined || message === "" ? {} : { message }),
    })
    return { delivered: true }
  }

  return {
    endpoints: {
      wake: (endpoint, deliveryIds) => {
        if (endpoint.socket === input.socket) return wake(endpoint.durable_session_id, deliveryIds, "inbox")
        const peer = input.peerOf?.(endpoint.socket)
        if (peer === undefined) return Promise.reject(Error(`host_unavailable:${endpoint.socket}`))
        return peer.wake(endpoint.durable_session_id, deliveryIds)
      },
      classifyLiveness: async (endpoint) =>
        !closed && (endpoint.socket === input.socket || input.peerOf?.(endpoint.socket) !== undefined)
          ? "routable"
          : "dead",
      respondUi: (endpoint, answer) => {
        if (endpoint.socket === input.socket) return respondUi(endpoint, answer)
        const peer = input.peerOf?.(endpoint.socket)
        if (peer === undefined) return Promise.reject(Error(`host_unavailable:${endpoint.socket}`))
        return peer.respondUi(endpoint.durable_session_id, answer)
      },
    },
    respondLocal: (sessionID: string, answer: UiAnswer) => respondUi({ durable_session_id: sessionID }, answer),
    wake,
    release(sessionID) {
      if (closed || !entries.has(sessionID)) return
      void wake(sessionID, [], "idle").catch((error: unknown) =>
        input.log(`thread drain for ${sessionID} failed: ${error instanceof Error ? error.message : String(error)}`),
      )
    },
    close() {
      closed = true
      for (const current of entries.values()) current.drain.stop()
      entries.clear()
    },
  }
}
