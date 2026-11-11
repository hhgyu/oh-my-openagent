// The reflection child's read-only tools: `reflection_read`, `reflection_list` and `reflection_grep`.
// They replace the Senpi child's `cat`/`head`/`find`/`grep` in a worktree cwd. Every path is
// confined to the run's worktree by `reflection-paths.ts`; the `transcript` target is the one
// transcript file of the run. Output is bounded so a large transcript is read in line windows.

import { readFile, stat } from "@oh-my-opencode/memory-core/fs"
import { z } from "zod"
import { assertSafeGrepPattern, REFLECTION_GREP_LIMITS } from "./reflection-grep-guard"
import { normalizeReflectionPath, resolveConfinedPath, resolveTranscriptPath, walkConfined, ReflectionPathError } from "./reflection-paths"
import type { ReflectionRunScope } from "./reflection-run-scope"

const REFLECTION_READ_CAPS = {
  readLines: 2_000, lineChars: 2_000, outputChars: 60_000, listEntries: 500, listDepth: 10, grepMatches: 200, grepFileBytes: 2_000_000,
} as const

const target = z.enum(["memory", "transcript"]).optional()
  .describe("memory (default): a path inside the memory worktree. transcript: the run's transcript payload file (path is ignored).")

export const reflectionReadInput = z.object({
  target,
  path: z.string().optional().describe("Memory file path relative to the memory worktree. Required for target memory."),
  offset: z.number().int().min(1).optional().describe("1-based first line to return (default 1)."),
  limit: z.number().int().min(1).max(REFLECTION_READ_CAPS.readLines).optional().describe(`Lines to return (default and max ${REFLECTION_READ_CAPS.readLines}).`),
}).strict()

export const reflectionListInput = z.object({
  path: z.string().optional().describe("Directory relative to the memory worktree (default: the worktree root)."),
  depth: z.number().int().min(1).max(REFLECTION_READ_CAPS.listDepth).optional().describe("Directory levels to descend (default 3)."),
}).strict()

export const reflectionGrepInput = z.object({
  pattern: z.string().min(1).describe("JavaScript regular expression matched against each line (at most 256 characters; repeated groups that contain a quantifier or '|', and backreferences, are refused)."),
  target,
  path: z.string().optional().describe("File or directory relative to the memory worktree (default: the worktree root). Ignored for target transcript."),
  ignore_case: z.boolean().optional().describe("Case-insensitive match."),
}).strict()

export async function runReflectionRead(scope: ReflectionRunScope, input: z.infer<typeof reflectionReadInput>): Promise<string> {
  const { real, label } = await readTarget(scope, input.target, input.path)
  if (!(await stat(real)).isFile()) throw new ReflectionPathError("not_file", `${label} is not a file`)
  const lines = (await readFile(real, "utf8")).split(/\r?\n/)
  if (lines.at(-1) === "") lines.pop()
  const offset = input.offset ?? 1
  const limit = input.limit ?? REFLECTION_READ_CAPS.readLines
  const window = lines.slice(offset - 1, offset - 1 + limit)
  const body = window.map((line, index) => `${offset + index}: ${clip(line, REFLECTION_READ_CAPS.lineChars)}`).join("\n")
  const last = offset - 1 + window.length
  const header = window.length === 0
    ? `${label}: no lines at offset ${offset} (${lines.length} lines total)`
    : `${label}: lines ${offset}-${last} of ${lines.length}${last < lines.length ? ` (continue with offset ${last + 1})` : ""}`
  return bounded(`${header}\n${body}`)
}

export async function runReflectionList(scope: ReflectionRunScope, input: z.infer<typeof reflectionListInput>): Promise<string> {
  const start = await resolveConfinedPath(scope.memoryDir, input.path ?? "")
  if (!(await stat(start.real)).isDirectory()) throw new ReflectionPathError("not_directory", `${start.display || "."} is not a directory`)
  const walked = await walkConfined(start.realRoot, start, { maxDepth: input.depth ?? 3, maxEntries: REFLECTION_READ_CAPS.listEntries })
  const lines = await Promise.all(walked.entries.map(async entry => entry.kind === "directory"
    ? `${entry.path}/`
    : `${entry.path} (${(await stat(entry.real)).size} bytes)`))
  const footer = walked.truncated ? [`[truncated at ${REFLECTION_READ_CAPS.listEntries} entries; list a subdirectory]`] : []
  return bounded([`${start.display || "."}/`, ...lines, ...footer].join("\n"))
}

/**
 * Line-by-line regex search. The pattern is screened first (`reflection-grep-guard.ts`), each line is
 * matched on its first `matchChars` characters, and the walk stops once `budgetMs` of wall clock is spent.
 */
export async function runReflectionGrep(scope: ReflectionRunScope, input: z.infer<typeof reflectionGrepInput>, clock: () => number = Date.now): Promise<string> {
  assertSafeGrepPattern(input.pattern)
  let matcher: RegExp
  try {
    matcher = new RegExp(input.pattern, input.ignore_case === true ? "i" : "")
  } catch (error) {
    throw new ReflectionPathError("invalid_input", `invalid pattern: ${error instanceof Error ? error.message : String(error)}`)
  }
  const files = await grepFiles(scope, input.target, input.path)
  const matches: string[] = []
  const deadline = clock() + REFLECTION_GREP_LIMITS.budgetMs
  let truncated = false
  let outOfTime = false
  for (const file of files) {
    if ((await stat(file.real)).size > REFLECTION_READ_CAPS.grepFileBytes) continue
    const content = await readFile(file.real, "utf8")
    if (content.includes("\0")) continue
    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length && !truncated; index += 1) {
      if (clock() > deadline) { outOfTime = true; break }
      const line = lines[index] ?? ""
      if (!matcher.test(line.slice(0, REFLECTION_GREP_LIMITS.matchChars))) continue
      if (matches.length >= REFLECTION_READ_CAPS.grepMatches) truncated = true
      else matches.push(`${file.label}:${index + 1}: ${clip(line, REFLECTION_READ_CAPS.lineChars)}`)
    }
    if (truncated || outOfTime) break
  }
  const notes = [
    ...(truncated ? [`[truncated at ${REFLECTION_READ_CAPS.grepMatches} matches; narrow the pattern or path]`] : []),
    ...(outOfTime ? [`[search stopped after ${REFLECTION_GREP_LIMITS.budgetMs} ms; narrow the pattern or path]`] : []),
  ]
  if (matches.length === 0 && notes.length === 0) return "no matches"
  return bounded([...(matches.length === 0 ? ["no matches before the search stopped"] : matches), ...notes].join("\n"))
}

async function readTarget(scope: ReflectionRunScope, which: "memory" | "transcript" | undefined, path: string | undefined): Promise<{ readonly real: string; readonly label: string }> {
  if (which === "transcript") return { real: await resolveTranscriptPath(scope.transcriptPath), label: "transcript" }
  if (path === undefined || normalizeReflectionPath(path) === "") throw new ReflectionPathError("invalid_input", "a memory file path is required for target memory")
  const resolved = await resolveConfinedPath(scope.memoryDir, path)
  return { real: resolved.real, label: resolved.display }
}

async function grepFiles(scope: ReflectionRunScope, which: "memory" | "transcript" | undefined, path: string | undefined): Promise<readonly { readonly real: string; readonly label: string }[]> {
  if (which === "transcript") return [{ real: await resolveTranscriptPath(scope.transcriptPath), label: "transcript" }]
  const start = await resolveConfinedPath(scope.memoryDir, path ?? "")
  if ((await stat(start.real)).isFile()) return [{ real: start.real, label: start.display }]
  const walked = await walkConfined(start.realRoot, start, { maxDepth: Number.POSITIVE_INFINITY, maxEntries: 5_000 })
  return walked.entries.filter(entry => entry.kind === "file").map(entry => ({ real: entry.real, label: entry.path }))
}

function clip(line: string, cap: number): string {
  return line.length <= cap ? line : `${line.slice(0, cap)} [line truncated]`
}

function bounded(text: string): string {
  const cap = REFLECTION_READ_CAPS.outputChars
  return text.length <= cap ? text : `${text.slice(0, cap)}\n[output truncated at ${cap} chars]`
}
