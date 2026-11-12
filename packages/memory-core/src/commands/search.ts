// /search <query> [--include-hidden] - FTS-lite scan over past session transcripts.
//
// The host picks the transcript source (deps.transcriptSource); without one the scan reads senpi
// session JSONL, which is identity-independent and works in unbound sessions. Output is read-only.

import { join } from "node:path"

import { existsSync } from "../fs/resilient"
import { SenpiSessionProvider, parseQuery, searchTranscripts, searchableText, type SearchResult } from "../index"

import { parseCommandArgs } from "./args"
import { respond, type MemoryCommandContext, type MemoryCommandDeps, type MemoryTranscriptSource } from "./types"

const SNIPPET_BEFORE = 60
const SNIPPET_AFTER = 120

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function highlight(snippet: string, needles: readonly string[]): string {
  let highlighted = snippet
  for (const needle of needles) {
    if (needle.length === 0) continue
    highlighted = highlighted.replace(new RegExp(escapeRegExp(needle), "gi"), (match) => `**${match}**`)
  }
  return highlighted
}

function buildSnippet(result: SearchResult, needles: readonly string[]): string {
  const haystack = searchableText(result.document).replace(/\s+/g, " ").trim()
  const lowered = haystack.toLowerCase()
  let index = -1
  for (const needle of needles) {
    const found = lowered.indexOf(needle.toLowerCase())
    if (found >= 0 && (index === -1 || found < index)) index = found
  }
  const start = Math.max(0, (index === -1 ? 0 : index) - SNIPPET_BEFORE)
  const end = Math.min(haystack.length, (index === -1 ? 0 : index) + SNIPPET_AFTER)
  const core = haystack.slice(start, end)
  const prefix = start > 0 ? "..." : ""
  const suffix = end < haystack.length ? "..." : ""
  return `${prefix}${highlight(core, needles)}${suffix}`
}

function senpiSessionsSource(deps: MemoryCommandDeps, ctx: MemoryCommandContext): MemoryTranscriptSource {
  const sessionsDir = deps.sessionsDir?.() ?? (ctx.agentDir === undefined ? undefined : join(ctx.agentDir, "sessions"))
  if (sessionsDir === undefined || !existsSync(sessionsDir)) {
    return {
      error: `no senpi sessions directory found at ${sessionsDir ?? "<unknown>"}; start a session first or check the agent directory`,
    }
  }
  return { provider: new SenpiSessionProvider({ sessionsDir }) }
}

export async function runSearchCommand(
  deps: MemoryCommandDeps,
  args: string,
  ctx: MemoryCommandContext,
): Promise<string> {
  const parsed = parseCommandArgs(args, { booleans: ["include-hidden"] })
  const query = parsed.positionals.join(" ").trim()
  if (query.length === 0) return respond(ctx, "usage: /search <query> [--include-hidden]", "error")

  const source = deps.transcriptSource?.(ctx) ?? senpiSessionsSource(deps, ctx)
  if ("error" in source) return respond(ctx, source.error, "error")

  const results = searchTranscripts(source.provider, query, {
    includeHidden: parsed.flags.get("include-hidden") === true,
  })
  if (results.length === 0) return respond(ctx, `No matches for "${query}".`)

  const { terms, phrases } = parseQuery(query)
  const needles = [...phrases, ...terms]
  const lines = [`# Search: "${query}" - ${results.length} result${results.length === 1 ? "" : "s"}`, ""]
  results.forEach((result, index) => {
    lines.push(
      `${index + 1}. session ${result.conversationId} · ${result.createdAt} · ${result.document.messageType ?? "unknown"}`,
      `   ${buildSnippet(result, needles)}`,
      `   entry ${result.messageId}`,
      "",
    )
  })
  return respond(ctx, lines.join("\n").trimEnd())
}
