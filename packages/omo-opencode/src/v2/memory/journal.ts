import { join } from "node:path"
import {
  JournalLockTimeoutError, TranscriptJournal,
  type AppendResult, type ProjectedReasoning, type ProjectedToolCall, type TranscriptProjection,
} from "@oh-my-opencode/memory-core"
import type * as Plugin from "@opencode/plugin/promise/plugin"
import { describeError, type BoundMemorySession, type MemoryBinder } from "./binding"
import type { MemoryLogger } from "./config"

type SessionContextPort = Pick<Plugin.Context["session"], "context">
type SessionMessage = Awaited<ReturnType<SessionContextPort["context"]>>[number]
type AssistantMessage = Extract<SessionMessage, { type: "assistant" }>
type AssistantPart = AssistantMessage["content"][number]
type ToolPart = Extract<AssistantPart, { type: "tool" }>

const NOOP: AppendResult = { appended: 0, skipped: 0 }

export interface MemoryJournalDeps {
  readonly binder: MemoryBinder
  readonly session: SessionContextPort
  readonly logger: MemoryLogger
  /** Sessions the component owns for itself (the Kibitzer judge); never journaled. */
  readonly isOwnedSession?: (sessionID: string) => boolean
  readonly createJournal?: (journalDir: string) => TranscriptJournal
}

export interface MemoryJournal {
  /** Settlement (`experimental.idle`): reconciles the session's transcript into its journal. */
  onIdle(sessionID: string): Promise<AppendResult>
  /** First bind of a root session: catches up rows missed while the host was down (Senpi `session_start`). */
  onBound(bound: BoundMemorySession, signal?: AbortSignal): Promise<AppendResult>
  /** Resolves once every reconcile started so far has finished. */
  settled(): Promise<void>
  clear(): void
}

/**
 * OpenCode 2 transcript journal (Senpi `journal-wiring.ts`). Senpi reconciles its persisted branch on
 * `session_start` and `agent_settled`; here the bind of a root session and `experimental.idle` read the
 * session's messages through `session.context` and map them onto memory-core's `TranscriptProjection`.
 * Rows are keyed by `source_line_id` in `TranscriptJournal`, so a repeated reconcile appends nothing.
 * Journals live at `<identity runtime>/transcripts/<sessionID>/`. Children never bind, so never journal.
 */
export function createMemoryJournal(deps: MemoryJournalDeps): MemoryJournal {
  const createJournal = deps.createJournal ?? ((journalDir: string) => new TranscriptJournal({ journalDir }))
  const journals = new Map<string, TranscriptJournal>()
  const chains = new Map<string, Promise<AppendResult>>()

  function journalFor(bound: BoundMemorySession): TranscriptJournal {
    const dir = join(bound.paths.transcripts, bound.sessionID)
    let journal = journals.get(dir)
    if (journal === undefined) {
      journal = createJournal(dir)
      journals.set(dir, journal)
    }
    return journal
  }

  async function reconcile(bound: BoundMemorySession, signal?: AbortSignal): Promise<AppendResult> {
    try {
      signal?.throwIfAborted()
      const messages = await deps.session.context({ sessionID: bound.sessionID })
      signal?.throwIfAborted()
      return await journalFor(bound).reconcile(projectSessionMessages(messages), signal)
    } catch (error) {
      // Best-effort bookkeeping: the next settlement or bind reconciles idempotently.
      const reason = error instanceof JournalLockTimeoutError ? "lock contention" : describeError(error)
      deps.logger.warn("memory transcript journal reconcile skipped", { sessionID: bound.sessionID, reason })
      return NOOP
    }
  }

  /** One reconcile at a time per session; a later request waits for the earlier one. */
  function serialized(sessionID: string, run: () => Promise<AppendResult>): Promise<AppendResult> {
    const previous = chains.get(sessionID) ?? Promise.resolve(NOOP)
    const next = previous.then(run, run)
    chains.set(sessionID, next)
    void next.finally(() => { if (chains.get(sessionID) === next) chains.delete(sessionID) }).catch(() => undefined)
    return next
  }

  return {
    onIdle(sessionID) {
      if (deps.isOwnedSession?.(sessionID) === true) return Promise.resolve(NOOP)
      return serialized(sessionID, async () => {
        const bound = await deps.binder.resolve(sessionID)
        return bound === undefined ? NOOP : reconcile(bound)
      })
    },
    onBound(bound, signal) {
      if (deps.isOwnedSession?.(bound.sessionID) === true) return Promise.resolve(NOOP)
      return serialized(bound.sessionID, () => reconcile(bound, signal))
    },
    async settled() {
      await Promise.allSettled([...chains.values()])
    },
    clear() {
      journals.clear()
    },
  }
}

/** OpenCode 2 session messages -> transcript projections; only user and assistant turns are conversation. */
function projectSessionMessages(messages: readonly SessionMessage[]): TranscriptProjection[] {
  const projections: TranscriptProjection[] = []
  for (const message of messages) {
    if (message.type === "user") {
      projections.push({ kind: "user", messageId: message.id, text: message.text })
      continue
    }
    if (message.type !== "assistant") continue
    const textBlocks: string[] = []
    const reasoningBlocks: ProjectedReasoning[] = []
    const toolCalls: ProjectedToolCall[] = []
    for (const part of message.content) {
      if (part.type === "text") textBlocks.push(part.text)
      else if (part.type === "reasoning") reasoningBlocks.push(part.text)
      else toolCalls.push(projectToolCall(part))
    }
    projections.push({ kind: "assistant", messageId: message.id, textBlocks, reasoningBlocks, toolCalls })
    const error = message.error?.message
    if (error !== undefined && error.trim().length > 0) projections.push({ kind: "error", messageId: message.id, text: error })
  }
  return projections
}

function projectToolCall(part: ToolPart): ProjectedToolCall {
  const state = part.state
  const argsText = "input" in state ? safeStringify(state.input) : undefined
  const base = { callId: part.id, name: part.name, ...(argsText === undefined ? {} : { argsText }) }
  if (state.status === "completed") return { ...base, resultText: toolText(state.content), resultOk: true }
  if (state.status === "error") {
    const output = toolText(state.content ?? [])
    return { ...base, resultText: output.length > 0 ? output : state.error.message, resultOk: false }
  }
  return base
}

function toolText(content: ReadonlyArray<{ readonly type: string }>): string {
  const texts: string[] = []
  for (const item of content) {
    if ("text" in item && typeof item.text === "string" && item.text.trim().length > 0) texts.push(item.text)
  }
  return texts.join("\n")
}

function safeStringify(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value)
  } catch (error) {
    return `[unserializable tool input: ${describeError(error)}]`
  }
}
