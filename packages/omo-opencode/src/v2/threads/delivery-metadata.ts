import { createHash } from "node:crypto"
import type { AdmitExternalMessageInput } from "@oh-my-opencode/thread-core/gateway/adapter"
import type { RunInput } from "@oh-my-opencode/thread-core/run-context"

export const THREAD_DELIVERY_METADATA_KEY = "omoThreadDelivery"

export type ThreadDeliveryMetadata = {
  readonly delivery_id: string
  readonly hop: number
  readonly sender_session?: string
  readonly sender_name?: string
}

/** Deterministic host message id of one gateway delivery: every attempt posts the SAME id and the host dedups it. */
export function threadDeliveryInputId(deliveryId: string): string {
  return "msg_omo_thread_" + createHash("sha256").update(`thread:${deliveryId}`).digest("hex").slice(0, 40)
}

export function deliveryMetadata(input: AdmitExternalMessageInput, hop: number): ThreadDeliveryMetadata {
  const sender = input.sender?.kind === "agent" ? input.sender : undefined
  return {
    delivery_id: input.delivery_id,
    hop,
    ...(sender === undefined ? {} : { sender_session: sender.session_id }),
    ...(sender?.name === undefined ? {} : { sender_name: sender.name }),
  }
}

export function deliveryRunInput(value: unknown): RunInput | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record["delivery_id"] !== "string") return undefined
  const hop = record["hop"]
  const sender = record["sender_session"]
  const name = record["sender_name"]
  return {
    kind: "delivery",
    id: record["delivery_id"],
    chainCount: typeof hop === "number" && Number.isSafeInteger(hop) && hop >= 0 ? hop : 0,
    ...(typeof sender === "string" && sender.length > 0 ? { agentSender: sender } : {}),
    ...(typeof name === "string" && name.trim().length > 0 ? { senderName: name.trim() } : {}),
  }
}
