import { normalizeThreadName, type ThreadAddressEntry } from "./addressing"
import { threadToolFailure, type ThreadToolFailure } from "./errors"

/** What the caller's current run took in: the agent sessions whose deliveries it consumed, and their senders as stated. */
export type ReplyEvidence = {
  readonly callerReplyTargets?: () => readonly string[]
  readonly callerReplySenders?: () => readonly { readonly session_id: string; readonly name?: string }[]
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
  const wanted = normalizeThreadName(target)
  return (evidence.callerReplySenders?.() ?? []).some(
    (sender) =>
      sender.session_id === target ||
      (sender.name !== undefined && wanted !== "" && normalizeThreadName(sender.name) === wanted),
  )
}

/**
 * The allowance approved a send as a reply to a consumed delivery's sender (by id or stated name): it is delivered only
 * when the address resolves to that sender, else refused by name without sending (decision 0027 section 6).
 */
export function replyTargetMismatch(
  evidence: ReplyEvidence,
  address: string,
  entry: ThreadAddressEntry,
): ThreadToolFailure | undefined {
  if (!isReplyToConsumedSender(evidence, address)) return undefined
  const senders = evidence.callerReplySenders?.() ?? []
  if (
    senders.some((sender) => sender.session_id === entry.thread_id) ||
    (evidence.callerReplyTargets?.() ?? []).includes(entry.thread_id)
  )
    return undefined
  return threadToolFailure(
    "reply_target_mismatch",
    `"${address}" was approved as a reply to a sender of this run's deliveries, but it resolves to ${entry.name} (${entry.thread_id}${entry.device === undefined ? "" : " on " + entry.device}), which is not that sender.`,
    "Reply with the sender's durable id from the delivery header, or send to the other thread by its id as a normal send.",
    { resolved_thread_id: entry.thread_id, ...(entry.device === undefined ? {} : { device: entry.device }) },
  )
}
