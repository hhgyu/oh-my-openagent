// Focus matching for dream selection, ported from omo-senpi `components/memory/dream-selector.ts`
// (`countSearchMatches` / `searchDocuments`): a conversation's journal entries are grouped per source
// message into memory-core search documents and the focus text is searched over them (at most 10 hits).

import { searchTranscripts, type SearchDocument, type TranscriptEntry } from "@oh-my-opencode/memory-core"

interface FocusConversation {
  readonly conversationId: string
  readonly entries: readonly TranscriptEntry[]
}

export function countFocusMatches(conversation: FocusConversation, focus: string | undefined): number {
  if (focus === undefined || focus.trim().length === 0) return 0
  return searchTranscripts(
    { listConversations: () => [{ id: conversation.conversationId, messages: searchDocuments(conversation) }] },
    focus,
    { conversationId: conversation.conversationId, limit: 10 },
  ).length
}

function searchDocuments(conversation: FocusConversation): SearchDocument[] {
  const grouped = new Map<string, TranscriptEntry[]>()
  for (const entry of conversation.entries) {
    const group = grouped.get(entry.source_message_id) ?? []
    group.push(entry)
    grouped.set(entry.source_message_id, group)
  }
  return [...grouped].map(([messageId, entries]) => {
    const textEntries = entries.filter(entry => entry.kind !== "tool_call")
    const tools = entries.filter(entry => entry.kind === "tool_call")
    return {
      id: messageId,
      conversationId: conversation.conversationId,
      date: entries.at(-1)?.captured_at,
      messageType: entries[0]?.kind,
      content: textEntries.filter(entry => entry.kind !== "reasoning").map(entry => entry.text).join("\n"),
      reasoning: textEntries.filter(entry => entry.kind === "reasoning").map(entry => entry.text).join("\n"),
      toolCalls: tools.map(entry => ({ name: entry.name, arguments: entry.argsText })),
      toolReturn: tools.map(entry => entry.resultText).filter(text => text !== undefined).join("\n"),
    }
  })
}
