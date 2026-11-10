// /memory - committed memory tree and file viewer (memory-core runMemoryViewCommand).
// The handler is host-neutral and lives in memory-core; this module registers it on senpi.

import { runMemoryViewCommand } from "@oh-my-opencode/memory-core/commands"

import { senpiCommandDeps } from "./core-deps"
import { LAZY_MEMORY_COMMANDS, type MemoryCommandPort } from "./metadata"
import type { MemoryCommandContext, MemoryCommandDeps } from "./types"

export function registerMemoryCommand(pi: MemoryCommandPort, deps: MemoryCommandDeps): void {
  pi.registerCommand("memory", {
    ...LAZY_MEMORY_COMMANDS.memory,
    handler: (args: string, ctx: MemoryCommandContext): Promise<string> => runMemoryViewCommand(senpiCommandDeps(deps), args, ctx),
  })
}
