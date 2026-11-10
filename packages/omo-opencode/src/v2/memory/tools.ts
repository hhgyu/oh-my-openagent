import { join } from "node:path"
import {
  GitMemoryRepo, MemoryToolError, createLockRecord, initMemoryWithSeeds, memoryWriterLockPath, runMemoryTool, withLock,
  type MemoryToolLock, type MemoryToolParams,
} from "@oh-my-opencode/memory-core"
import { existsSync, mkdir } from "@oh-my-opencode/memory-core/fs"
import { Error as ToolError, type Info, type Result, type ToolContext } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import type { BoundMemorySession, MemoryBinder } from "./binding"

export const MEMORY_TOOL_NAME = "memory"
export const MEMORY_APPLY_PATCH_TOOL_NAME = "memory_apply_patch"
export const UNBOUND_MEMORY_MESSAGE =
  "no memory identity is bound to this session: memory is written only from a root session with memory enabled"

const reason = z.string().describe("Git commit message recorded for this memory change.")
const memoryInput = z.object({
  command: z.enum(["create", "str_replace", "insert", "delete", "rename", "update_description", "apply_patch"])
    .describe("The memory operation to perform."),
  reason,
  file_path: z.string().optional().describe("Target memory file, relative to the memory repo or absolute inside it."),
  old_path: z.string().optional().describe("Current path of the memory file. Required by rename."),
  new_path: z.string().optional().describe("Destination path of the memory file. Required by rename."),
  old_string: z.string().optional().describe("Exact text to replace. Required by str_replace."),
  new_string: z.string().optional().describe("Replacement text. Required by str_replace."),
  insert_line: z.number().optional().describe("1-based line number at which to insert text. Required by insert."),
  insert_text: z.string().optional().describe("Text to insert. Required by insert."),
  description: z.string().optional().describe("Frontmatter description. Required by create and update_description."),
  file_text: z.string().optional().describe("Initial body text for create."),
  input: z.string().optional().describe("Codex-style patch text for apply_patch."),
})
const applyPatchInput = z.object({
  reason,
  input: z.string().describe("Codex-style multi-file or multi-hunk patch over the memory repo."),
})

const MEMORY_DESCRIPTION = [
  "Edit memories stored in the omo memory repo; every change is committed with the given reason.",
  "Operations: create, str_replace, insert, delete, rename, update_description, apply_patch.",
  "Memory files are markdown with YAML frontmatter; paths must stay inside the memory repo.",
].join("\n")
const APPLY_PATCH_DESCRIPTION = "Apply a Codex-style patch to the omo memory repo and commit it with the given reason."

export interface MemoryToolsDeps {
  readonly binder: MemoryBinder
  /** Writer-lock wait budget before contention is reported; defaults to 5000ms. */
  readonly lockWaitTimeoutMs?: number
  readonly lockRetryDelayMs?: number
  /** User turns observed for this session; becomes the Omo-Session/Omo-Turn commit trailers. */
  readonly userTurns?: (sessionID: string) => number
}

export function createMemoryTools(deps: MemoryToolsDeps): readonly [Info<typeof memoryInput>, Info<typeof applyPatchInput>] {
  const run = async (tool: string, caller: ToolContext, params: Omit<MemoryToolParams, "author">): Promise<Result> => {
    const bound = await deps.binder.resolve(caller.sessionID)
    if (bound === undefined) throw new ToolError({ message: `${tool}: ${UNBOUND_MEMORY_MESSAGE}` })
    try {
      const { repo, lock } = await prepareWrite(bound, caller.sessionID, deps)
      const provenance = deps.userTurns ? { provenance: { sessionId: caller.sessionID, userTurns: deps.userTurns(caller.sessionID) } } : {}
      const result = await runMemoryTool({ repo, lock, params: { ...params, author: { agentId: bound.identity, authorName: bound.identity }, ...provenance } })
      return { content: result.message, metadata: result.commit === undefined ? {} : { commit: result.commit.sha, paths: [...result.commit.affectedPaths] } }
    } catch (error) {
      if (error instanceof MemoryToolError) throw new ToolError({ message: error.message })
      throw error
    }
  }
  return [
    {
      name: MEMORY_TOOL_NAME, description: MEMORY_DESCRIPTION, input: memoryInput, options: { codemode: false },
      execute: (input, caller) => run(MEMORY_TOOL_NAME, caller, { ...input }),
    },
    {
      name: MEMORY_APPLY_PATCH_TOOL_NAME, description: APPLY_PATCH_DESCRIPTION, input: applyPatchInput, options: { codemode: false },
      execute: (input, caller) => run(MEMORY_APPLY_PATCH_TOOL_NAME, caller, { command: "apply_patch", reason: input.reason, input: input.input }),
    },
  ]
}

/**
 * First-write seam: the locks directory and, under the cross-process writer lock, the seeded repository
 * are created here and nowhere else. Reads never reach this function.
 */
async function prepareWrite(bound: BoundMemorySession, sessionID: string, deps: MemoryToolsDeps): Promise<{ repo: GitMemoryRepo; lock: MemoryToolLock }> {
  await mkdir(bound.paths.locks, { recursive: true, mode: 0o700 })
  const repo = new GitMemoryRepo({ dir: bound.paths.repo, agentId: bound.identity })
  const lock: MemoryToolLock = async (domain, operation) => {
    if (domain !== "memory-write") throw new MemoryToolError(`unsupported lock domain '${domain}'`)
    const record = await createLockRecord(`memory tool (${bound.identity}) oc2-${sessionID}`)
    return withLock(memoryWriterLockPath(bound.paths.locks), record, operation, {
      waitTimeoutMs: deps.lockWaitTimeoutMs ?? 5_000,
      ...(deps.lockRetryDelayMs === undefined ? {} : { retryDelayMs: deps.lockRetryDelayMs }),
    })
  }
  if (!existsSync(join(bound.paths.repo, ".git"))) {
    await lock("memory-write", async () => {
      if (!existsSync(join(bound.paths.repo, ".git"))) await initMemoryWithSeeds(repo, { authorName: bound.identity })
    })
  }
  return { repo, lock }
}
