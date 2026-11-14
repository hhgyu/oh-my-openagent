import { workspaceEntries } from "@oh-my-opencode/thread-core/addressing"
import type { ThreadReadInput, ThreadToolResult } from "@oh-my-opencode/thread-core/contracts"
import { locateControl } from "../control/locate"
import { controlIdentity } from "@oh-my-opencode/thread-core/control/port"
import { readTranscript } from "@oh-my-opencode/thread-core/reader"
import { liveReadResult, readWindow, transcriptRole } from "@oh-my-opencode/thread-core/read-result"
import { threadLink } from "@oh-my-opencode/thread-core/thread-link"
import { addressBook, degradedSummary, failure, resolveEntries, summary } from "./internals"
import type { ThreadHostSession, ThreadHostView, ThreadToolSurfaceOptions } from "./ports"

export { liveReadResult } from "@oh-my-opencode/thread-core/read-result"

/**
 * `thread_list` over one host view. Default scope is the caller's workspace, the same test
 * thread_send applies before it delivers; the address book itself spans every workspace the host
 * knows. A session whose endpoint stopped answering is still a thread: it is listed from its JSONL
 * as resumable, with the endpoint's failure in error_note, instead of silently vanishing.
 */
export function listThreads(
  options: ThreadToolSurfaceOptions,
  current: ThreadHostView,
  allScope: boolean | undefined,
): ThreadToolResult {
  const scoped = workspaceEntries(resolveEntries(options, current), options.callerWorkspaceRoot())
  const inScope = (threadId: string) => allScope === true || scoped.some((entry) => entry.thread_id === threadId)
  const visible = current.sessions.filter((session) => inScope(session.durableSessionId ?? session.sessionId))
  const book = addressBook(options, current)
  const entryOf = (session: ThreadHostSession) =>
    book.find(
      (entry) =>
        entry.thread_id === (session.durableSessionId ?? session.sessionId) &&
        entry.source_host === (session.socket ?? entry.source_host),
    )
  const degraded = book.filter(
    (entry) => entry.error_note !== undefined && entry.status !== "live" && inScope(entry.thread_id),
  )
  const order = new Map(book.map((entry, index) => [entry.thread_id, index]))
  const threads = [
    ...visible.map((session) => summary(session, entryOf(session))),
    ...degraded.map(degradedSummary),
  ].sort(
    (left, right) =>
      (order.get(left.thread_id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.thread_id) ?? Number.MAX_SAFE_INTEGER),
  )
  return { kind: "ok", threads, scope: allScope === true ? "all" : "workspace" }
}

/** `thread_read`: the live transcript through the thread's control, wherever it is held; else its JSONL when its endpoint here is dead. */
export async function readThread(
  options: ThreadToolSurfaceOptions,
  current: ThreadHostView,
  value: ThreadReadInput,
  callerId: string,
): Promise<ThreadToolResult> {
  const located = await locateControl(options, current, value.thread, value.all_scope, callerId)
  if (located.kind === "error") return located.result
  if (located.kind === "not_live") return readDegraded(options, current, located.thread_id, value)
  const { control } = located
  const result = liveReadResult(control.thread_id, control.title, await control.getMessages(), value)
  return result.kind === "ok" ? { ...result, ...controlIdentity(control) } : result
}

/**
 * A thread with no live owner is read from its JSONL only when its ENDPOINT is dead: the address
 * book then carries the durable path and the endpoint's failure. Any other non-live thread stays
 * `not_resumable`, as before endpoints were enumerated.
 */
function readDegraded(
  options: ThreadToolSurfaceOptions,
  current: ThreadHostView,
  threadId: string,
  value: ThreadReadInput,
): ThreadToolResult {
  const entry = addressBook(options, current).find((candidate) => candidate.thread_id === threadId)
  if (entry === undefined || entry.error_note === undefined || entry.session_path === null)
    return failure("not_resumable", "The thread has no live owner.", "Retry when the target is live.")
  const durable = readTranscript(
    { kind: "jsonl", path: entry.session_path, live_host_present: false },
    readWindow(value),
  )
  if (durable.kind === "error") return { kind: "error", error: durable.error }
  // A session file interleaves messages with bookkeeping (the session header, model and thinking
  // changes, names): only message entries are transcript, rendered with the live path's roles.
  const messages = durable.items.flatMap((item) => {
    const message = item.message
    if (item.type !== "message" || typeof message !== "object" || message === null || Array.isArray(message)) return []
    return message.role === "user" || message.role === "assistant" || message.role === "toolResult" ? [message] : []
  })
  const items = messages.map((message, index) => ({
    seq: index + 1,
    role: transcriptRole(message.role),
    content: JSON.stringify(message.content ?? message),
  }))
  return {
    kind: "ok",
    thread_id: threadId,
    link: threadLink(threadId, entry.title),
    items,
    truncated: durable.truncated,
    ...(durable.next_cursor === null ? {} : { next_cursor: durable.next_cursor }),
    source: durable.source,
    source_incomplete: durable.source_incomplete,
    error_note: entry.error_note,
  }
}
