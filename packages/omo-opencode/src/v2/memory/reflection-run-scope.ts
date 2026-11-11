// One reflection run as its child's tools see it: the run's worktree (the only tree the read tools
// reach), the transcript file the parent wrote, and a `GitMemoryRepo` opened AT the worktree so
// every `reflection_memory` edit is a commit on the run branch, never on the parent repo. The
// parent's cross-process writer lock is not taken: the run branch is private to this run until the
// parent integrates it (S7f). Edits of one run are serialized in process instead, so parallel tool
// calls cannot interleave a clean check with another call's write.

import {
  GitMemoryRepo, MemoryToolError, runMemoryTool, type GitExec, type MemoryToolLock, type MemoryToolParams, type MemoryToolResult,
} from "@oh-my-opencode/memory-core"

const REFLECTION_AUTHOR_NAME = "Reflection Agent"

export interface ReflectionRunScope {
  readonly runId: string
  /** The run's worktree (`ReflectionWorktree.dir`). */
  readonly memoryDir: string
  /** The transcript payload file the parent wrote for this run. */
  readonly transcriptPath: string
  /** Applies one memory-core memory command on the run branch and commits it. */
  edit(params: Omit<MemoryToolParams, "author" | "provenance">): Promise<MemoryToolResult>
  /** SHAs committed through `edit`, in order. */
  commits(): readonly string[]
  /** Stops accepting edits (the run settled, was cancelled, or is finalizing). */
  deactivate(): void
  readonly active: () => boolean
}

export interface ReflectionRunScopeInput {
  readonly runId: string
  readonly worktreeDir: string
  readonly transcriptPath: string
  /** The memory identity; the commit author id. */
  readonly agentId: string
  readonly exec?: GitExec
}

export function createReflectionRunScope(input: ReflectionRunScopeInput): ReflectionRunScope {
  const repo = new GitMemoryRepo({ dir: input.worktreeDir, agentId: input.agentId, ...(input.exec === undefined ? {} : { exec: input.exec }) })
  const shas: string[] = []
  let active = true
  let tail: Promise<unknown> = Promise.resolve()
  const lock: MemoryToolLock = (domain, operation) => {
    if (domain !== "memory-write") throw new MemoryToolError(`unsupported lock domain '${domain}'`)
    const next = tail.then(operation, operation)
    tail = next.catch(() => undefined)
    return next
  }
  return {
    runId: input.runId,
    memoryDir: input.worktreeDir,
    transcriptPath: input.transcriptPath,
    active: () => active,
    commits: () => [...shas],
    deactivate: () => { active = false },
    async edit(params) {
      if (!active) throw new MemoryToolError("the reflection run is no longer active; stop editing")
      const result = await runMemoryTool({ repo, lock, params: { ...params, author: { agentId: input.agentId, authorName: REFLECTION_AUTHOR_NAME } } })
      if (result.commit !== undefined) shas.push(result.commit.sha)
      return result
    },
  }
}
