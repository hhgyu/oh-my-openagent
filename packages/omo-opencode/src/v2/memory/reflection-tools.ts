// The hidden reflection child's four private tools, registered once through `tool.transform`:
// `reflection_read`, `reflection_list`, `reflection_grep` and `reflection_memory`. Like `record_fact`,
// each call resolves the reflection run from the CALLING session (`resolve`, which answers only for
// a live, issued reflection child whose lease is current) and refuses every other session with a
// model-visible error. The read tools are confined to the run's worktree and its transcript;
// `reflection_memory` runs memory-core `runMemoryTool` on a repo opened at the worktree, so every edit
// is a commit on the run branch. There is no bash and no git tool: commits come only from here.

import { MemoryToolError } from "@oh-my-opencode/memory-core"
import { Error as ToolError, type Info, type Result, type ToolContext } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import { ReflectionPathError } from "./reflection-paths"
import {
  reflectionGrepInput,
  reflectionListInput,
  reflectionReadInput,
  runReflectionGrep,
  runReflectionList,
  runReflectionRead,
} from "./reflection-read-tools"
import type { ReflectionRunScope } from "./reflection-run-scope"

export const REFLECTION_READ_TOOL_NAME = "reflection_read"
export const REFLECTION_LIST_TOOL_NAME = "reflection_list"
export const REFLECTION_GREP_TOOL_NAME = "reflection_grep"
export const REFLECTION_MEMORY_TOOL_NAME = "reflection_memory"
export const REFLECTION_TOOL_NAMES = Object.freeze([
  REFLECTION_READ_TOOL_NAME,
  REFLECTION_LIST_TOOL_NAME,
  REFLECTION_GREP_TOOL_NAME,
  REFLECTION_MEMORY_TOOL_NAME,
] as const)

export const REFLECTION_FOREIGN_SESSION_MESSAGE =
  "this tool is available only to a live reflection session issued by the memory component"

const reflectionMemoryInput = z
  .object({
    command: z
      .enum(["create", "str_replace", "insert", "delete", "rename", "update_description", "apply_patch"])
      .describe("The memory operation to perform. Each successful call is one commit on the reflection branch."),
    reason: z
      .string()
      .describe(
        "Commit message for this change: '<type>(reflection): <summary>', a blank line, then what changed and why.",
      ),
    file_path: z.string().optional().describe("Target memory file, relative to the memory worktree."),
    old_path: z.string().optional().describe("Current path of the memory file. Required by rename."),
    new_path: z.string().optional().describe("Destination path of the memory file. Required by rename."),
    old_string: z.string().optional().describe("Exact text to replace. Required by str_replace."),
    new_string: z.string().optional().describe("Replacement text. Required by str_replace."),
    insert_line: z.number().optional().describe("1-based line number at which to insert text. Required by insert."),
    insert_text: z.string().optional().describe("Text to insert. Required by insert."),
    description: z.string().optional().describe("Frontmatter description. Required by create and update_description."),
    file_text: z.string().optional().describe("Initial body text for create."),
    input: z
      .string()
      .optional()
      .describe("Codex-style patch text for apply_patch (several files or hunks in one commit)."),
  })
  .strict()

export type ReflectionToolResolver = (sessionID: string) => ReflectionRunScope | undefined

function scopeFor(resolve: ReflectionToolResolver, context: ToolContext, tool: string): ReflectionRunScope {
  const scope = resolve(context.sessionID)
  if (scope === undefined) throw new ToolError({ message: `${tool}: ${REFLECTION_FOREIGN_SESSION_MESSAGE}` })
  if (!scope.active()) throw new ToolError({ message: `${tool}: the reflection run is no longer active; end the turn` })
  return scope
}

async function answer(tool: string, run: () => Promise<string>): Promise<Result> {
  try {
    return { content: await run() }
  } catch (error) {
    if (error instanceof ReflectionPathError)
      throw new ToolError({ message: `${tool}: ${JSON.stringify({ rejected: error.code, message: error.message })}` })
    throw error
  }
}

export function createReflectionTools(
  resolve: ReflectionToolResolver,
): readonly [
  Info<typeof reflectionReadInput>,
  Info<typeof reflectionListInput>,
  Info<typeof reflectionGrepInput>,
  Info<typeof reflectionMemoryInput>,
] {
  return [
    {
      name: REFLECTION_READ_TOOL_NAME,
      description:
        "Read a memory file in the reflection worktree, or the run's transcript (target transcript), in numbered line windows.",
      input: reflectionReadInput,
      options: { codemode: false, permission: REFLECTION_READ_TOOL_NAME },
      execute: (input, context) =>
        answer(REFLECTION_READ_TOOL_NAME, () =>
          runReflectionRead(scopeFor(resolve, context, REFLECTION_READ_TOOL_NAME), input),
        ),
    },
    {
      name: REFLECTION_LIST_TOOL_NAME,
      description:
        "List the memory worktree tree (files with sizes, directories with a trailing '/'). Git administration files are hidden.",
      input: reflectionListInput,
      options: { codemode: false, permission: REFLECTION_LIST_TOOL_NAME },
      execute: (input, context) =>
        answer(REFLECTION_LIST_TOOL_NAME, () =>
          runReflectionList(scopeFor(resolve, context, REFLECTION_LIST_TOOL_NAME), input),
        ),
    },
    {
      name: REFLECTION_GREP_TOOL_NAME,
      description:
        "Search memory files (or the run's transcript, target transcript) line by line with a regular expression.",
      input: reflectionGrepInput,
      options: { codemode: false, permission: REFLECTION_GREP_TOOL_NAME },
      execute: (input, context) =>
        answer(REFLECTION_GREP_TOOL_NAME, () =>
          runReflectionGrep(scopeFor(resolve, context, REFLECTION_GREP_TOOL_NAME), input),
        ),
    },
    {
      name: REFLECTION_MEMORY_TOOL_NAME,
      description: [
        "Edit the memory worktree; every successful call is committed on the reflection branch with the given reason.",
        "Operations: create, str_replace, insert, delete, rename, update_description, apply_patch.",
        "Memory files are markdown with YAML frontmatter; paths stay inside the memory worktree.",
      ].join("\n"),
      input: reflectionMemoryInput,
      options: { codemode: false, permission: REFLECTION_MEMORY_TOOL_NAME },
      async execute(input, context): Promise<Result> {
        const scope = scopeFor(resolve, context, REFLECTION_MEMORY_TOOL_NAME)
        try {
          const result = await scope.edit({ ...input })
          return {
            content: result.message,
            metadata:
              result.commit === undefined ? {} : { commit: result.commit.sha, paths: [...result.commit.affectedPaths] },
          }
        } catch (error) {
          if (error instanceof MemoryToolError)
            throw new ToolError({ message: `${REFLECTION_MEMORY_TOOL_NAME}: ${error.message}` })
          throw error
        }
      },
    },
  ]
}
