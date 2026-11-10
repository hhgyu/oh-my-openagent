// `/search` transcript source over one identity's transcript journals
// (<identity runtime>/transcripts/<sessionId>/transcript.jsonl). A host that does not keep senpi
// session JSONL searches the rows its journal wiring wrote instead. Read-only, lock-free and
// tolerant: a torn trailing line from a concurrent append is skipped, never repaired.

import { join } from "node:path"

import { existsSync, readdirSync, readFileSync } from "../fs/resilient"
import type { SearchDocument, TranscriptConversation, TranscriptProvider } from "../index"

import type { MemoryCommandIdentity, MemoryTranscriptSource } from "./types"

const TRANSCRIPT_FILE = "transcript.jsonl"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function documentOf(row: unknown, conversationId: string): SearchDocument | undefined {
  if (!isRecord(row)) return undefined
  const id = optionalString(row.source_line_id)
  const kind = optionalString(row.kind)
  if (id === undefined || kind === undefined) return undefined
  const date = optionalString(row.captured_at)
  const base = { id, conversationId, messageType: kind, ...(date === undefined ? {} : { date }) }
  if (kind === "tool_call") {
    const name = optionalString(row.name)
    const args = optionalString(row.argsText)
    const result = optionalString(row.resultText)
    return {
      ...base,
      toolCalls: [{ ...(name === undefined ? {} : { name }), ...(args === undefined ? {} : { arguments: args }) }],
      ...(result === undefined ? {} : { toolReturn: result }),
    }
  }
  const text = optionalString(row.text)
  if (text === undefined) return undefined
  return kind === "reasoning" ? { ...base, reasoning: text } : { ...base, content: text }
}

function readConversation(transcriptsDir: string, conversationId: string): TranscriptConversation | undefined {
  let raw: string
  try {
    raw = readFileSync(join(transcriptsDir, conversationId, TRANSCRIPT_FILE), "utf8")
  } catch {
    return undefined
  }
  const messages: SearchDocument[] = []
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const document = documentOf(parsed, conversationId)
    if (document !== undefined) messages.push(document)
  }
  return { id: conversationId, messages }
}

class JournalTranscriptProvider implements TranscriptProvider {
  constructor(private readonly transcriptsDir: string) {}

  listConversations(): readonly TranscriptConversation[] {
    let entries: string[]
    try {
      entries = readdirSync(this.transcriptsDir)
    } catch {
      return []
    }
    return [...entries]
      .sort()
      .map((entry) => readConversation(this.transcriptsDir, entry))
      .filter((conversation): conversation is TranscriptConversation => conversation !== undefined)
  }
}

/** The journal source for a bound identity, or the actionable reason there is nothing to search yet. */
export function journalTranscriptSource(identity: MemoryCommandIdentity | undefined): MemoryTranscriptSource {
  if (identity === undefined) {
    return { error: "memory is not bound to this session; start a session with memory enabled and retry" }
  }
  const transcriptsDir = identity.identityPaths.transcripts
  if (!existsSync(transcriptsDir)) {
    return { error: `no transcript journals for ${identity.identity} yet at ${transcriptsDir}; they are written when a session settles` }
  }
  return { provider: new JournalTranscriptProvider(transcriptsDir) }
}
