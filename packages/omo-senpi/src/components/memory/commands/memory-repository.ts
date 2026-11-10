// /memory-repository - push-only mirror configuration (memory-core runMemoryRepositoryCommand).
// The handler is host-neutral and lives in memory-core; this module registers it on senpi.

import { runMemoryRepositoryCommand } from "@oh-my-opencode/memory-core/commands"

import { senpiCommandDeps } from "./core-deps"
import { LAZY_MEMORY_COMMANDS, type MemoryCommandPort } from "./metadata"
import type { MemoryCommandContext, MemoryCommandDeps } from "./types"

export function registerMemoryRepositoryCommand(pi: MemoryCommandPort, deps: MemoryCommandDeps): void {
  pi.registerCommand("memory-repository", {
    ...LAZY_MEMORY_COMMANDS["memory-repository"],
    handler: (args: string, ctx: MemoryCommandContext): Promise<string> => runMemoryRepositoryCommand(senpiCommandDeps(deps), args, ctx),
  })
}
