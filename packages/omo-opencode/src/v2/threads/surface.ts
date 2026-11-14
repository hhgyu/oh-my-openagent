import type { GatewayDeliveryMode, GatewayDeliveryResult } from "@oh-my-opencode/thread-core/gateway/types"
import type { ReplyEvidence } from "@oh-my-opencode/thread-core/reply-allowance"
import type { V2AddressEntry } from "./address-book"
import type { ControlHost, ThreadV2Host } from "./host"

export type ThreadSendRequest = {
  readonly thread_id: string
  readonly all_scope?: boolean
  readonly text: string
  readonly mode: GatewayDeliveryMode
  readonly expected_turn_id?: string
  readonly idempotency_key: string
  readonly args: unknown
}

export type ThreadSurface = {
  readonly host: ThreadV2Host
  readonly entries: () => Promise<V2AddressEntry[]>
  readonly controlHost: (entry: V2AddressEntry) => ControlHost
  readonly createSession: (input: {
    readonly directory: string
    readonly title?: string
    readonly callerId: string
  }) => Promise<V2AddressEntry>
}

export type ThreadCall = {
  readonly callerId: string
  readonly callId: string
  readonly workspaceRoot: () => Promise<string>
  readonly replyEvidence: ReplyEvidence
  readonly send: (request: ThreadSendRequest) => Promise<GatewayDeliveryResult>
}
