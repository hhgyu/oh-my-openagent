// Bounded event stream for one main session's resident Kibitzer (V2 port of omo-senpi
// `kibitzer/events.ts`). The OpenCode 2 hooks have no branch snapshot, so the cursor is the
// stream's own monotonic entry index; `session_entries` pages the same bounded history by that
// cursor, which keeps the envelope cursors and `session_entries(since)` aligned. Bodies are redacted
// BEFORE truncation (memory-core `redactKibitzerEventText`), the newest 20 events stay verbatim and
// older ones fold into the shared one-line digest.

import {
  DIGEST_TAIL_FRAGMENTS, digestLine, fragmentOf, redactKibitzerEventText, truncateHead, type FoldState,
} from "@oh-my-opencode/memory-core/recall-sidecar"

export type KibitzerEventKind = "prompt" | "assistant" | "tool_call" | "tool_result"

export interface KibitzerEventCaps {
  readonly toolArgs: number
  readonly resultHead: number
  readonly assistant: number
  readonly prompt: number
}

export const DEFAULT_KIBITZER_EVENT_CAPS: KibitzerEventCaps = { toolArgs: 400, resultHead: 600, assistant: 1500, prompt: 4000 }
export const KIBITZER_EVENT_BUFFER_SIZE = 20
/** Entries `session_entries` can page back through; older ones are gone. */
export const KIBITZER_HISTORY_SIZE = 500

export interface KibitzerEvent {
  readonly seq: number
  readonly cursor: number
  readonly at: number
  readonly kind: KibitzerEventKind
  readonly body: string
  readonly truncated: boolean
  readonly tool?: string
  readonly callId?: string
  readonly isError?: boolean
}

export interface KibitzerEventDigest {
  readonly count: number
  readonly firstSeq: number
  readonly lastSeq: number
  readonly firstCursor: number
  readonly lastCursor: number
  readonly line: string
}

export interface KibitzerEventBatch {
  readonly events: readonly KibitzerEvent[]
  readonly digest?: KibitzerEventDigest
  readonly cursors?: { readonly first: number; readonly last: number }
}

export interface KibitzerEventStream {
  onPrompt(text: string): boolean
  onAssistant(text: string): boolean
  onToolCall(tool: string, callId: string | undefined, input: unknown): boolean
  onToolResult(tool: string, callId: string | undefined, isError: boolean, output: unknown): boolean
  size(): number
  lastCursor(): number | undefined
  drain(): KibitzerEventBatch
  /** Recorded entries strictly after `since`, oldest first, from the bounded history. */
  history(since: number): readonly KibitzerEvent[]
}

const ID_CAP = 64

export function createKibitzerEventStream(options: { readonly caps?: Partial<KibitzerEventCaps>; readonly now?: () => number } = {}): KibitzerEventStream {
  const caps: KibitzerEventCaps = { ...DEFAULT_KIBITZER_EVENT_CAPS, ...options.caps }
  const now = options.now ?? Date.now
  const events: KibitzerEvent[] = []
  const recorded: KibitzerEvent[] = []
  let fold: FoldState | undefined
  let seq = 0
  let lastAssistant: string | undefined

  function bounded(text: string, cap: number): { body: string; truncated: boolean } {
    const clean = redactKibitzerEventText(text)
    return clean.length <= cap ? { body: clean, truncated: false } : { body: truncateHead(clean, cap), truncated: true }
  }

  function push(pending: Omit<KibitzerEvent, "seq" | "at" | "cursor">): true {
    seq += 1
    const event: KibitzerEvent = { seq, cursor: seq, at: now(), ...pending }
    events.push(event)
    recorded.push(event)
    if (recorded.length > KIBITZER_HISTORY_SIZE) recorded.shift()
    if (events.length > KIBITZER_EVENT_BUFFER_SIZE) {
      const oldest = events.shift()
      if (oldest !== undefined) foldInto(oldest)
    }
    return true
  }

  function foldInto(event: KibitzerEvent): void {
    const fragment = fragmentOf(event)
    if (fold === undefined) {
      fold = { count: 1, firstSeq: event.seq, lastSeq: event.seq, firstCursor: event.cursor, lastCursor: event.cursor, head: fragment, tail: [] }
      return
    }
    fold.count += 1
    fold.lastSeq = event.seq
    fold.lastCursor = event.cursor
    fold.tail.push(fragment)
    if (fold.tail.length > DIGEST_TAIL_FRAGMENTS) fold.tail.shift()
  }

  function batch(): KibitzerEventBatch {
    const digest = fold === undefined ? undefined : {
      count: fold.count, firstSeq: fold.firstSeq, lastSeq: fold.lastSeq, firstCursor: fold.firstCursor, lastCursor: fold.lastCursor, line: digestLine(fold),
    }
    const first = digest?.firstCursor ?? events[0]?.cursor
    const last = events.at(-1)?.cursor ?? digest?.lastCursor
    return { events: [...events], ...(digest === undefined ? {} : { digest }), ...(first === undefined || last === undefined ? {} : { cursors: { first, last } }) }
  }

  return {
    onPrompt(text) {
      if (text.trim() === "") return false
      return push({ kind: "prompt", ...bounded(text, caps.prompt) })
    },
    onAssistant(text) {
      // The newest assistant text is emitted once, however many requests carry it.
      if (text.trim() === "" || text === lastAssistant) return false
      lastAssistant = text
      return push({ kind: "assistant", ...bounded(text, caps.assistant) })
    },
    onToolCall(tool, callId, input) {
      return push({ kind: "tool_call", tool: tool.slice(0, ID_CAP), ...(callId === undefined ? {} : { callId: callId.slice(0, ID_CAP) }), ...bounded(argsText(input), caps.toolArgs) })
    },
    onToolResult(tool, callId, isError, output) {
      return push({
        kind: "tool_result", tool: tool.slice(0, ID_CAP), ...(callId === undefined ? {} : { callId: callId.slice(0, ID_CAP) }), isError,
        ...bounded(contentText(output), caps.resultHead),
      })
    },
    size: () => events.length,
    lastCursor: () => (seq === 0 ? undefined : seq),
    drain() {
      const pending = batch()
      events.length = 0
      fold = undefined
      return pending
    },
    history: since => recorded.filter(event => event.cursor > since),
  }
}

/** `eval.summary` wins over `eval.code`; everything else is compact JSON. */
function argsText(input: unknown): string {
  if (typeof input === "string") return input
  if (isRecord(input) && typeof input.summary === "string" && typeof input.code === "string") return input.summary
  try {
    return JSON.stringify(input) ?? ""
  } catch {
    return String(input)
  }
}

export function contentText(output: unknown): string {
  if (typeof output === "string") return output
  if (Array.isArray(output)) return output.map(part => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("")
  if (isRecord(output)) {
    if ("content" in output) return contentText(output.content)
    if (typeof output.message === "string") return output.message
  }
  return ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
