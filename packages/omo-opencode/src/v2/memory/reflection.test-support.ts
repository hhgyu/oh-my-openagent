// UNIT fixtures for the reflection child slice: a real parent memory repo with a real reflection
// worktree (memory-core `createReflectionWorktree`), a transcript file outside it, and a host tool
// context. Everything lives under one temp root; nothing touches the repository or the real home.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildIdentityPaths,
  createReflectionWorktree,
  GitMemoryRepo,
  type ReflectionWorktree,
} from "@oh-my-opencode/memory-core"
import { OmoMemorySettingsSchema } from "@oh-my-opencode/omo-config-core"
import type { Info, Result, ToolContext } from "@opencode/plugin/promise/tool"
import type { BoundMemorySession } from "./binding"

export const REFLECTION_TEST_AGENT = "agent-one"

export interface ReflectionFixture {
  readonly root: string
  readonly parent: GitMemoryRepo
  readonly worktree: ReflectionWorktree
  readonly transcriptPath: string
  /** A directory outside the worktree holding `secret.md`. */
  readonly outside: string
  readonly bound: BoundMemorySession
  cleanup(): void
}

export async function createReflectionFixture(): Promise<ReflectionFixture> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "omo-v2-reflection-")))
  const parent = new GitMemoryRepo({ dir: join(root, "memory"), agentId: REFLECTION_TEST_AGENT })
  await parent.init({
    seedFiles: [{ relativePath: "system/persona.md", content: "---\ndescription: Persona\n---\nI am helpful.\n" }],
  })
  const worktree = await createReflectionWorktree(parent, "run-1", join(root, "worktrees"))
  const sessions = join(root, "reflection-sessions", "run-1")
  mkdirSync(sessions, { recursive: true })
  const transcriptPath = join(sessions, "transcript-payload.json")
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ schemaVersion: 1, runId: "run-1", request: { trigger: "manual" }, note: "user prefers tabs" }, null, 2)}\n`,
  )
  const outside = join(root, "outside")
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(outside, "secret.md"), "outside secret\n")
  const bound: BoundMemorySession = {
    sessionID: "ses_root",
    identity: REFLECTION_TEST_AGENT,
    paths: buildIdentityPaths(join(root, "home"), REFLECTION_TEST_AGENT),
    settings: OmoMemorySettingsSchema.parse({}),
    directory: root,
    metadata: {},
  }
  return {
    root,
    parent,
    worktree,
    transcriptPath,
    outside,
    bound,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    },
  }
}

/** A bound identity under a temp home with no memory repo yet (the runner seeds it); for runner and recovery tests. */
export function createBoundIdentity(): { readonly root: string; readonly bound: BoundMemorySession; cleanup(): void } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "omo-v2-reflection-run-")))
  const bound: BoundMemorySession = {
    sessionID: "ses_root",
    identity: REFLECTION_TEST_AGENT,
    paths: buildIdentityPaths(join(root, "home"), REFLECTION_TEST_AGENT),
    settings: OmoMemorySettingsSchema.parse({}),
    directory: root,
    metadata: {},
  }
  return {
    root,
    bound,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    },
  }
}

export function toolContext(sessionID: string, id = "call_1"): ToolContext {
  // The host context carries more than a tool reads; the doubles fill only what these tools use.
  return {
    sessionID,
    agent: "omo-reflection",
    messageID: "msg_1",
    id,
    signal: new AbortController().signal,
    progress: async () => undefined,
  } as unknown as ToolContext
}

export function runTool(tool: Info, input: Record<string, unknown>, context: ToolContext): Promise<Result> {
  return Reflect.apply(tool.execute, undefined, [input, context])
}

export async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) return error.message
    if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
      return error.message
    return String(error)
  }
  throw new Error("expected the tool call to be refused")
}
