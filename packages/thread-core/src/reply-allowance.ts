import { normalizeThreadName, type ThreadAddressEntry } from "./addressing"
import { threadToolFailure, type ThreadToolFailure } from "./errors"

/** What the caller's current run took in: the agent sessions whose deliveries it consumed, and their senders as stated. */
export type ReplyEvidence = {
  readonly callerReplyTargets?: () => readonly string[]
  readonly callerReplySenders?: () => readonly {
    readonly session_id: string
    readonly name?: string
    readonly device?: string
  }[]
}

/** A durable session id: the only spelling of a reply target that resolves exactly, never through an alias or a name. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Decision 0027 section 6: the reply allowance is decided from the consumed delivery itself - its sender's durable id or
 * the name it stated - never from a listing. The send step then delivers only when the address resolves to that sender,
 * so a name that happens to match another session is never reached unapproved.
 */
export function isReplyToConsumedSender(evidence: ReplyEvidence, target: string): boolean {
  if (SESSION_ID.test(target) && (evidence.callerReplyTargets?.() ?? []).includes(target)) return true
  return sendersNamedBy(evidence, target).length > 0
}

type ReplySender = { readonly session_id: string; readonly name?: string; readonly device?: string }

function sendersNamedBy(evidence: Pick<ReplyEvidence, "callerReplySenders">, target: string): readonly ReplySender[] {
  const wanted = normalizeThreadName(target)
  return (evidence.callerReplySenders?.() ?? []).filter(
    (sender) =>
      sender.session_id === target ||
      (sender.name !== undefined && wanted !== "" && normalizeThreadName(sender.name) === wanted),
  )
}

/**
 * The consumed senders an approved reply addresses, each with the device its delivery came from (absent = this device):
 * empty when `target` is not a reply. A target approved by a consumed sender id alone is that sender on this device.
 */
export function consumedSendersOf(evidence: ReplyEvidence, target: string): readonly ReplySender[] {
  if (!isReplyToConsumedSender(evidence, target)) return []
  const named = sendersNamedBy(evidence, target)
  return named.length > 0 ? named : [{ session_id: target }]
}

export const otherDevice = (device: string | undefined, here: string | undefined): string | undefined =>
  device === here ? undefined : device

/**
 * The allowance approved a send as a reply to a consumed delivery's sender (by id or stated name): it is delivered only
 * when the address resolves to that sender on that sender's device (`here` is this device's id; absent = this device),
 * else refused by name without sending (decision 0027 section 6).
 */
export function replyTargetMismatch(
  evidence: ReplyEvidence,
  address: string,
  entry: ThreadAddressEntry,
  here?: string,
): ThreadToolFailure | undefined {
  const senders = consumedSendersOf(evidence, address)
  if (senders.length === 0) return undefined
  const entryDevice = otherDevice(entry.device, here)
  if (
    senders.some((sender) => sender.session_id === entry.thread_id && otherDevice(sender.device, here) === entryDevice)
  )
    return undefined
  return replyTargetFailure(address, entry)
}

/** The refusal of a reply whose address resolved to a session that is not the consumed sender. */
export function replyTargetFailure(address: string, entry: ThreadAddressEntry): ThreadToolFailure {
  return threadToolFailure(
    "reply_target_mismatch",
    `"${address}" was approved as a reply to a sender of this run's deliveries, but it resolves to ${entry.name} (${entry.thread_id}${entry.device === undefined ? "" : " on " + entry.device}), which is not that sender.`,
    "Reply with the sender's durable id from the delivery header, or send to the other thread by its id as a normal send.",
    { thread: entry.thread_id, ...(entry.device === undefined ? {} : { device: entry.device }) },
  )
}
