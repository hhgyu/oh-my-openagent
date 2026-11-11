// Dream conversation selection, ported from omo-senpi `components/memory/dream-selector.ts` (host-neutral;
// a later move-to-memory-core candidate). Every journal under the identity's transcripts directory is read
// lock-free (`readEntriesSnapshot`) and reduced to its unreflected window; the candidates are scored,
// ranked and packed by `dream-scoring.ts` under `auto_select_max` conversations and
// `auto_select_max_chars` bytes. `computeUnreflectedVolumeFast` is the idle gate's volume probe: the
// transcript bytes past `reflected_through_byte_offset`, falling back to one parse of a legacy journal.

import {
  captureCursorSnapshot, deriveState, initialReflectionState, isCanonicalEntry, TranscriptJournal,
  type ReflectionTranscriptState, type TranscriptEntry,
} from "@oh-my-opencode/memory-core"
import { readdir, readFile, stat } from "@oh-my-opencode/memory-core/fs"
import { join } from "node:path"
import { countFocusMatches } from "./dream-focus"
import { compareConversationIds, packDreamCandidates, rankDreamCandidates, scoreDreamCandidate, type DreamScoredConversation, type DreamSelection } from "./dream-scoring"

interface DreamSelectorOptions {
  readonly transcriptsDir: string
  readonly currentConversationId?: string
  readonly autoSelectMax: number
  readonly autoSelectMaxBytes: number
  readonly now: () => Date
}

interface LoadedConversation {
  readonly conversationId: string
  readonly entries: readonly TranscriptEntry[]
  readonly stepsSinceLastSuccessfulReflection: number
  readonly reflectedThroughMessageId?: string
  readonly newestMessageId: string
  readonly lastActivity: string
  readonly totalBytes: number
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined
  return typeof error.code === "string" ? error.code : undefined
}

async function journalNames(transcriptsDir: string): Promise<string[]> {
  const entries = await readdir(transcriptsDir, { withFileTypes: true }).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return []
    throw error
  })
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
}

export async function computeUnreflectedVolumeFast(transcriptsDir: string): Promise<number> {
  const sizes = await Promise.all((await journalNames(transcriptsDir)).map(async name => {
    const journalDir = join(transcriptsDir, name)
    const transcriptSize = await stat(join(journalDir, "transcript.jsonl"))
      .then(value => value.size)
      .catch((error: unknown) => errorCode(error) === "ENOENT" ? 0 : Promise.reject(error))
    const state = await readReflectionState(join(journalDir, "state.json"), [])
    if (state.reflected_through_byte_offset !== undefined) return Math.max(0, transcriptSize - state.reflected_through_byte_offset)
    // A legacy journal is parsed once; its offset is published for every later probe.
    const journal = new TranscriptJournal({ journalDir })
    const journalEntries = await journal.readEntriesSnapshot()
    const snapshot = captureCursorSnapshot(journalEntries, await journal.backfillReflectionByteOffset(journalEntries))
    return snapshot === null ? 0 : conversationByteLength(snapshot.entries)
  }))
  return sizes.reduce((total, size) => total + size, 0)
}

export async function selectRecentDreamConversations(options: DreamSelectorOptions, recentN: number, focus?: string): Promise<DreamSelection> {
  const recent = (await loadConversations(options.transcriptsDir))
    .sort((left, right) => {
      const activity = Date.parse(right.lastActivity) - Date.parse(left.lastActivity)
      return activity === 0 ? compareConversationIds(left.conversationId, right.conversationId) : activity
    })
    .slice(0, recentN)
  return selectLoadedConversations(recent, options, focus)
}

export function selectLoadedConversations(conversations: readonly LoadedConversation[], options: DreamSelectorOptions, focus?: string): DreamSelection {
  const targetBytes = options.autoSelectMaxBytes / options.autoSelectMax
  const now = options.now()
  const candidates = conversations.map((conversation): DreamScoredConversation => ({
    conversationId: conversation.conversationId,
    totalBytes: conversation.totalBytes,
    lastActivityMs: Date.parse(conversation.lastActivity),
    ...scoreDreamCandidate({
      searchMatchCount: countFocusMatches(conversation, focus),
      stepsSinceLastSuccessfulReflection: conversation.stepsSinceLastSuccessfulReflection,
      lastActivity: conversation.lastActivity,
      distinctSourceCount: new Set(conversation.entries.map(entry => entry.source_message_id)).size,
      totalBytes: conversation.totalBytes,
      targetBytes,
      isCurrent: conversation.conversationId === options.currentConversationId,
      newestMessageCovered: conversation.reflectedThroughMessageId === conversation.newestMessageId,
      now,
    }),
  }))
  return packDreamCandidates(rankDreamCandidates(candidates), { maxConversations: options.autoSelectMax, maxBytes: options.autoSelectMaxBytes })
}

/** Loads every journal with an unreflected window; `candidateLimit` keeps the most recently written ones. */
export async function loadConversations(transcriptsDir: string, candidateLimit?: number): Promise<LoadedConversation[]> {
  const names = (await journalNames(transcriptsDir)).sort(compareConversationIds)
  const rankedNames = candidateLimit === undefined
    ? names
    : (await Promise.all(names.map(async conversationId => ({
        conversationId,
        mtimeMs: await stat(join(transcriptsDir, conversationId, "transcript.jsonl")).then(value => value.mtimeMs).catch(() => 0),
      })))).sort((left, right) => right.mtimeMs - left.mtimeMs || compareConversationIds(left.conversationId, right.conversationId))
      .slice(0, candidateLimit)
      .map(entry => entry.conversationId)
  const conversations = await Promise.all(rankedNames.map(async (conversationId): Promise<LoadedConversation | null> => {
    const journalDir = join(transcriptsDir, conversationId)
    // Lock-free snapshot: taking every journal's state lock here would starve live sessions' reconciles.
    const journalEntries = await new TranscriptJournal({ journalDir }).readEntriesSnapshot()
    let state = await readReflectionState(join(journalDir, "state.json"), journalEntries)
    if (state.reflected_through_byte_offset === undefined) state = await new TranscriptJournal({ journalDir }).backfillReflectionByteOffset(journalEntries)
    const snapshot = captureCursorSnapshot(journalEntries, state)
    const newest = journalEntries.findLast(isCanonicalEntry)
    if (snapshot === null || newest === undefined) return null
    return {
      conversationId, entries: journalEntries,
      stepsSinceLastSuccessfulReflection: state.steps_since_last_successful_reflection,
      ...(state.reflected_through_message_id === undefined ? {} : { reflectedThroughMessageId: state.reflected_through_message_id }),
      newestMessageId: newest.source_message_id, lastActivity: newest.captured_at, totalBytes: conversationByteLength(snapshot.entries),
    }
  }))
  return conversations.filter((conversation): conversation is LoadedConversation => conversation !== null)
}

async function readReflectionState(statePath: string, entries: readonly TranscriptEntry[]): Promise<ReflectionTranscriptState> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(statePath, "utf8"))
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && !(error instanceof SyntaxError)) throw error
  }
  const value: Record<string, unknown> = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : {}
  const through = value.reflected_through_message_id
  const steps = value.reflected_completed_steps
  const offset = value.reflected_through_byte_offset
  return deriveState({
    ...initialReflectionState(),
    ...(typeof through === "string" && through.length > 0 ? { reflected_through_message_id: through } : {}),
    ...(typeof offset === "number" && Number.isInteger(offset) && offset >= 0 ? { reflected_through_byte_offset: offset } : {}),
    reflected_completed_steps: typeof steps === "number" && Number.isInteger(steps) && steps >= 0 ? steps : 0,
  }, entries)
}

function conversationByteLength(entries: readonly TranscriptEntry[]): number {
  const text = entries
    .map(entry => {
      const fields: string[] = []
      if ("text" in entry) fields.push(entry.text)
      if (entry.kind === "tool_call" && entry.argsText !== undefined) fields.push(entry.argsText)
      if (entry.kind === "tool_call" && entry.resultText !== undefined) fields.push(entry.resultText)
      return fields.join("\n")
    })
    .filter(entry => entry.length > 0)
    .join("\n")
  return Buffer.byteLength(text, "utf8")
}
