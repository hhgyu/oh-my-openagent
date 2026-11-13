import { normalizeThreadName } from "./addressing"

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
