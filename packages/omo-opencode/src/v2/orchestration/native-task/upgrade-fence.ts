/** Structural, so the on-disk discovery scan and the typed runtime record share one rule. */
export interface FenceFacts {
  readonly status: string
  readonly killed?: boolean
  readonly notify_on_terminal?: boolean
  readonly error_message?: string
  readonly notification: {
    readonly run_epoch: number
    readonly notified_epoch: number
    readonly notification_failed_epoch?: number
  }
  readonly owned_session?: { readonly hostVersion: string }
}

const ACTIVE = new Set(["running", "pending", "paused"])

export function upgradeLostReason(from: string, to: string): string {
  return `OpenCode was upgraded from ${from} to ${to}; this child session is fenced to its original host version and cannot be resumed`
}

/** What a host upgrade still owes the parent of this child, if anything:
 * - `active`: the child was still running, pending or paused under the old host; it ends as lost with one notice;
 * - `terminal`: it ended under the old host but its completion never reached the parent; one notice tells it;
 * - `noticed`: an earlier build already sent the upgrade notice and ended it as lost, so only the record is marked.
 * A parent-initiated cancel answered in its own tool result, and a child whose notice was delivered, owe nothing. */
export function upgradeNoticeDue(
  record: FenceFacts,
  hostVersion: string,
): "active" | "terminal" | "noticed" | undefined {
  const fencedTo = record.owned_session?.hostVersion
  if (fencedTo === undefined || fencedTo === hostVersion) return undefined
  if (ACTIVE.has(record.status)) return "active"
  const { run_epoch, notified_epoch, notification_failed_epoch } = record.notification
  if (notified_epoch >= run_epoch || record.status === "cancelled" || record.killed === true) return undefined
  if (record.notify_on_terminal !== true && notification_failed_epoch === undefined) return undefined
  if (record.status === "lost" && record.error_message?.startsWith(`OpenCode was upgraded from ${fencedTo} to `))
    return "noticed"
  return "terminal"
}
