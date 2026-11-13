// The Kibitzer child's own tools, registered once through `tool.transform` and refusing every
// caller that is not a live Kibitzer child issued by this component (V2 port of omo-senpi
// `kibitzer/tools/`). `read` and `grep` are the host's native read-only tools, admitted only by the
// child's permission rules; `session_entries` and `nudge` are added here; the committed-memory
// `search`/`read` operations ride the existing `memory` tool name (see `wrapMemoryTool`) so the
// tool names the persona and the envelope contract state stay exactly the five shared ones.

import { redactUrl, selectRecallCandidates, type RecallCorpus } from "@oh-my-opencode/memory-core"
import { Error as ToolError, type Info, type Result, type ToolContext } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import type { KibitzerToolBinding } from "./contract"
import {
  applyNudge,
  KIBITZER_NUDGE_DESCRIPTION,
  KIBITZER_NUDGE_HINT_DESCRIPTION,
  KIBITZER_NUDGE_TOOL_NAME,
} from "./nudge"
import type { KibitzerSidecar } from "./sidecar"

const KIBITZER_SESSION_ENTRIES_TOOL_NAME = "session_entries"
/** The tools only a Kibitzer child may see; `memory` is shared with the parent and stays out of this list. */
export const KIBITZER_PRIVATE_TOOL_NAMES: readonly string[] = Object.freeze([
  KIBITZER_SESSION_ENTRIES_TOOL_NAME,
  KIBITZER_NUDGE_TOOL_NAME,
])
export const KIBITZER_MEMORY_TOOL_NAME = "memory"
const KIBITZER_FOREIGN_SESSION_MESSAGE =
  "this tool is available only to a live Kibitzer judge session issued by the memory component"

const KIBITZER_TOOL_CAPS = {
  sessionEntries: 30,
  sessionEntryChars: 600,
  memorySearchResults: 8,
  memoryReadChars: 6000,
} as const

export interface KibitzerCaller {
  readonly sidecar: KibitzerSidecar
  readonly binding: KibitzerToolBinding
}

export interface KibitzerToolsDeps {
  /** A live, issued Kibitzer child of this component; undefined for every other session. */
  resolve(sessionID: string): KibitzerCaller | undefined
  /** The parent's committed recall corpus (HEAD only); undefined when the parent has no memory. */
  corpus(parentSessionId: string): Promise<RecallCorpus | undefined>
}

const sessionEntriesInput = z.object({
  since: z
    .number()
    .int()
    .min(-1)
    .optional()
    .describe("Cursor of the last entry already seen; -1 (default) starts from the beginning."),
})
const nudgeInput = z.object({
  path: z.string().describe("Memory path copied exactly from the candidates input."),
  hint: z.string().describe(KIBITZER_NUDGE_HINT_DESCRIPTION),
})
export const kibitzerMemoryInput = z.object({
  operation: z
    .enum(["search", "read"])
    .describe("search: find committed memories by query. read: return one committed memory body."),
  query: z.string().optional().describe("Search terms (double quotes group a phrase). Required by search."),
  path: z.string().optional().describe("Memory path relative to the memory repo. Required by read."),
})
export const KIBITZER_MEMORY_DESCRIPTION =
  "Read-only access to committed memories: search by query or read one path. This tool cannot write."

function caller(deps: KibitzerToolsDeps, context: ToolContext, tool: string): KibitzerCaller {
  const found = deps.resolve(context.sessionID)
  if (found === undefined) throw new ToolError({ message: `${tool}: ${KIBITZER_FOREIGN_SESSION_MESSAGE}` })
  return found
}

function charged(found: KibitzerCaller, context: ToolContext, tool: string): void {
  if (!found.binding.charge(context.id)) {
    throw new ToolError({
      message: `${tool}: ${JSON.stringify({ rejected: "tool_budget_exceeded", message: `The tool-call budget for this wake (${found.binding.budgetLimit}) is exhausted; end the turn.` })}`,
    })
  }
}

export function createKibitzerTools(
  deps: KibitzerToolsDeps,
): readonly [Info<typeof sessionEntriesInput>, Info<typeof nudgeInput>] {
  return [
    {
      name: KIBITZER_SESSION_ENTRIES_TOOL_NAME,
      description: `Read the primary agent's session entries after a cursor (at most ${KIBITZER_TOOL_CAPS.sessionEntries} per call).`,
      input: sessionEntriesInput,
      options: { codemode: false, permission: KIBITZER_SESSION_ENTRIES_TOOL_NAME },
      async execute(input, context): Promise<Result> {
        const found = caller(deps, context, KIBITZER_SESSION_ENTRIES_TOOL_NAME)
        charged(found, context, KIBITZER_SESSION_ENTRIES_TOOL_NAME)
        const since = input.since ?? -1
        const all = found.sidecar.history(since)
        const page = all.slice(0, KIBITZER_TOOL_CAPS.sessionEntries)
        const entries = page.map((event) => ({
          cursor: event.cursor,
          type: event.kind,
          ...(event.tool === undefined ? {} : { tool: event.tool }),
          ...(event.isError === undefined ? {} : { error: event.isError }),
          text: boundedText(event.body, KIBITZER_TOOL_CAPS.sessionEntryChars),
        }))
        return {
          content: JSON.stringify({
            entries,
            next_since: page.at(-1)?.cursor ?? since,
            hidden: 0,
            truncated: all.length > page.length,
          }),
        }
      },
    },
    {
      name: KIBITZER_NUDGE_TOOL_NAME,
      description: KIBITZER_NUDGE_DESCRIPTION,
      input: nudgeInput,
      options: { codemode: false, permission: KIBITZER_NUDGE_TOOL_NAME },
      async execute(input, context): Promise<Result> {
        const found = caller(deps, context, KIBITZER_NUDGE_TOOL_NAME)
        charged(found, context, KIBITZER_NUDGE_TOOL_NAME)
        const { binding } = found
        const result = applyNudge(input, binding)
        if (!result.ok) throw new ToolError({ message: result.message })
        return { content: result.message, metadata: { capped: result.capped } }
      },
    },
  ]
}

/** The read-only committed-memory operations, for a live Kibitzer caller. */
async function runKibitzerMemory(
  deps: KibitzerToolsDeps,
  input: z.infer<typeof kibitzerMemoryInput>,
  context: ToolContext,
): Promise<Result> {
  const found = caller(deps, context, KIBITZER_MEMORY_TOOL_NAME)
  charged(found, context, KIBITZER_MEMORY_TOOL_NAME)
  const corpus = await deps.corpus(found.binding.parentSessionId)
  if (input.operation === "search") {
    const query = input.query?.trim() ?? ""
    if (query === "") throw rejection("missing_argument", "search requires a non-empty query.")
    if (corpus === undefined) return { content: JSON.stringify({ revision: null, results: [], truncated: false }) }
    const probe = KIBITZER_TOOL_CAPS.memorySearchResults + 1
    const selected = selectRecallCandidates(corpus.documents, [query], { maxItems: probe, surfaced: new Set() })
    const results = selected.slice(0, KIBITZER_TOOL_CAPS.memorySearchResults).map((candidate) => ({
      path: candidate.path,
      description: boundedText(candidate.description, KIBITZER_TOOL_CAPS.memoryReadChars),
      excerpt: boundedText(candidate.excerpt, KIBITZER_TOOL_CAPS.memoryReadChars),
    }))
    for (const hit of results) found.binding.searched.add(hit.path)
    return {
      content: JSON.stringify({ revision: corpus.revision, results, truncated: selected.length > results.length }),
    }
  }
  if (input.path === undefined) throw rejection("missing_argument", "read requires a path.")
  const normalized = normalizeMemoryPath(input.path)
  if (!normalized.ok) throw rejection(normalized.code, normalized.message, input.path)
  const document = corpus?.documents.find((candidate) => candidate.path === normalized.path)
  if (document === undefined)
    throw rejection("not_committed", `"${normalized.path}" is not a committed memory file at HEAD.`, normalized.path)
  return {
    content: boundedText(
      `description: ${document.description}\n\n${document.body}`,
      KIBITZER_TOOL_CAPS.memoryReadChars,
    ),
  }
}

type MemoryWriterInput = z.ZodObject<z.ZodRawShape>

/**
 * One `memory` tool for both callers: the parent's writer operations (unchanged validation and
 * execution) and, for a live Kibitzer child only, the read-only `search`/`read` operations. The
 * registered schema is a flat object accepting both shapes; the Kibitzer context hook narrows what
 * the child model sees to the read-only shape. A Kibitzer child can never reach the writer path and
 * every other session is refused the read-only operations.
 */
export function wrapMemoryTool<S extends MemoryWriterInput>(writer: Info<S>, deps: KibitzerToolsDeps): Info {
  const input = writer.input.partial().extend(kibitzerMemoryInput.partial().shape)
  return {
    ...writer,
    input,
    async execute(raw, context): Promise<Result> {
      if (deps.resolve(context.sessionID) !== undefined) {
        const parsed = kibitzerMemoryInput.safeParse(raw)
        if (!parsed.success)
          throw new ToolError({
            message: `${KIBITZER_MEMORY_TOOL_NAME}: the Kibitzer judge may only search or read committed memories`,
          })
        return runKibitzerMemory(deps, parsed.data, context)
      }
      if (isRecord(raw) && raw.operation !== undefined) {
        throw new ToolError({ message: `${KIBITZER_MEMORY_TOOL_NAME}: ${KIBITZER_FOREIGN_SESSION_MESSAGE}` })
      }
      const parsed = writer.input.safeParse(raw)
      if (!parsed.success) throw new ToolError({ message: `${KIBITZER_MEMORY_TOOL_NAME}: ${parsed.error.message}` })
      // `writer.input` itself validated this value; the generic cannot unify zod's output with the host's InputValue.
      return writer.execute(parsed.data as Parameters<Info<S>["execute"]>[0], context)
    },
  }
}

type RejectionCode =
  | "path_empty"
  | "path_separator"
  | "path_absolute"
  | "path_traversal"
  | "system_path"
  | "not_committed"
  | "missing_argument"

function rejection(code: RejectionCode, message: string, path?: string): ToolError {
  return new ToolError({
    message: `${KIBITZER_MEMORY_TOOL_NAME}: ${JSON.stringify({ rejected: code, message, ...(path === undefined ? {} : { path }) })}`,
  })
}

/** Repo-relative POSIX paths only; the reserved root `system/` tree is invisible to the judge. */
function normalizeMemoryPath(
  input: string,
):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly code: RejectionCode; readonly message: string } {
  if (input.trim().length === 0) return { ok: false, code: "path_empty", message: "A memory path is required." }
  if (input.includes("\\")) return { ok: false, code: "path_separator", message: "Memory paths use '/' separators." }
  if (input.startsWith("/") || /^[A-Za-z]:/.test(input))
    return { ok: false, code: "path_absolute", message: "Memory paths are relative to the memory repo." }
  const segments = input.split("/").filter((segment) => segment.length > 0 && segment !== ".")
  if (segments.some((segment) => segment === ".."))
    return { ok: false, code: "path_traversal", message: "Memory paths cannot contain '..' segments." }
  if (segments.length === 0) return { ok: false, code: "path_empty", message: "A memory path is required." }
  const path = segments.join("/")
  if (path === "system" || path.startsWith("system/"))
    return { ok: false, code: "system_path", message: "The system/ tree is not readable by the sidecar." }
  return { ok: true, path }
}

/** Redaction FIRST (a secret split by truncation would escape the pattern), then the cap. */
function boundedText(text: string, cap: number): string {
  const redacted = redactUrl(text)
  return redacted.length <= cap
    ? redacted
    : `${redacted.slice(0, cap)}\n[truncated: ${cap} of ${redacted.length} chars]`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
