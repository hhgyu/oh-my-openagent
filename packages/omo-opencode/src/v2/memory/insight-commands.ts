// Shared shape of the OpenCode 2 read-side memory commands (plan S7c/S7d): `/doctor`, `/sleeptime`,
// `/people` and `/palace`. Their names live in their own record, apart from the core
// `MEMORY_COMMAND_NAMES`, and their output takes the same display + `msg_omo_memory_output_` record route
// as every memory command (`./commands`). `coreCommandCall` adapts a bound session to the memory-core
// command context and dependencies the moved Senpi handlers read.

import type {
  MemoryCommandContext,
  MemoryCommandDeps,
  MemoryCommandIdentity,
  NotifyLevel,
} from "@oh-my-opencode/memory-core/commands"
import { v2CommandName } from "../commands/namespace"
import type { BoundMemorySession } from "./binding"

/** Registered names of the read-side memory commands. */
export const INSIGHT_COMMAND_NAMES: Readonly<Record<"doctor" | "sleeptime" | "people" | "palace", string>> = {
  doctor: v2CommandName("doctor"),
  sleeptime: v2CommandName("sleeptime"),
  people: v2CommandName("people"),
  palace: v2CommandName("palace"),
}

export const UNBOUND_MEMORY_SESSION =
  "memory is not bound to this session; start a session with memory enabled and retry"

export interface CoreCommandCall {
  readonly identity: MemoryCommandIdentity
  readonly ctx: MemoryCommandContext
  readonly deps: MemoryCommandDeps
  /** The last level the handler notified with (`info` when it notified nothing). */
  level(): NotifyLevel
}

export function coreCommandCall(bound: BoundMemorySession): CoreCommandCall {
  let level: NotifyLevel = "info"
  const identity: MemoryCommandIdentity = { identity: bound.identity, identityPaths: bound.paths }
  return {
    identity,
    ctx: {
      mode: "opencode",
      hasUI: false,
      cwd: bound.directory,
      sessionManager: { getSessionId: () => bound.sessionID },
      ui: {
        notify: (_message, notified = "info") => {
          level = notified
        },
      },
    },
    deps: {
      contextForSession: (sessionID) => (sessionID === bound.sessionID ? identity : undefined),
      resolveIdentity: () => identity,
      bustPromptCache: () => undefined,
    },
    level: () => level,
  }
}
