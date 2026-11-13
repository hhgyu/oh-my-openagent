import type { ThreadReadInput, ThreadToolResult, ThreadTranscriptItem } from "./contracts"
import { readTranscript, type ThreadTranscriptEntry } from "./reader"
import { threadLink } from "./thread-link"

/** One role vocabulary for both read paths: engine `toolResult` is `tool`; every other non-chat kind is `system`. */
export function transcriptRole(role: unknown): ThreadTranscriptItem["role"] {
  if (role === "user" || role === "assistant") return role
  return role === "toolResult" ? "tool" : "system"
}

/**
 * A first read takes the trailing window; a read that carries a cursor continues forward from it.
 * Tail mode ignores the cursor, so following next_cursor in tail mode returned the same slice again.
 */
export function readWindow(value: ThreadReadInput): { mode: "tail" | "page"; max_bytes?: number; cursor?: string } {
  return { mode: value.cursor === undefined ? "tail" : "page", max_bytes: value.max_bytes, cursor: value.cursor }
}

/** A live session's transcript through the bounded reader; the same window rules on every host and device. */
export function liveReadResult(
  threadId: string,
  title: string | undefined,
  messages: readonly ThreadTranscriptEntry[],
  value: ThreadReadInput,
): ThreadToolResult {
  const live = readTranscript({ kind: "live", entries: () => messages }, readWindow(value))
  if (live.kind === "error") return { kind: "error", error: live.error }
  return {
    kind: "ok",
    thread_id: threadId,
    link: threadLink(threadId, title),
    items: live.items.map((item, index) => ({
      seq: index + 1,
      role: transcriptRole(item.role),
      content: JSON.stringify(item.content ?? item),
    })),
    truncated: live.truncated,
    ...(live.next_cursor === null ? {} : { next_cursor: live.next_cursor }),
    source: live.source,
  }
}
