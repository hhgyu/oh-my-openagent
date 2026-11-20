import type { ThreadToolSurfaceOptions } from "./ports"
import { consumedSendersOf, isReplyToConsumedSender } from "@oh-my-opencode/thread-core/reply-allowance"

import { threadToolPermission, type ThreadPermissionRequest } from "./local-permission"

/**
 * `thread_send`'s permission request (#12886). A reply to an agent whose delivery the caller's current run took in, named
 * by its exact session id, is a request scoped to that session whose `ask` is approved without a prompt, so a run another
 * agent woke can always answer it while `allow` and `deny` rules still decide first. Every other send is decided like any
 * thread tool call (`threadToolPermission`): a send to a session this device holds asks for nothing, any other asks.
 */
export function threadSendPermission(
  options: Pick<ThreadToolSurfaceOptions, "callerReplyTargets" | "callerReplySenders" | "sessionsDirectory">,
) {
  const otherwise = threadToolPermission("thread_send", options)
  return (input: Record<string, unknown>): ThreadPermissionRequest[] => {
    const target = input["thread"]
    if (typeof target === "string" && isReplyToConsumedSender(options, target))
      return [{ permission: "thread_send", patterns: [target], always: [target], autoApproveAsk: true }]
    return otherwise(input)
  }
}

export { consumedSendersOf }
