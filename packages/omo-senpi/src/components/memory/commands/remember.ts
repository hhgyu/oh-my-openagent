// /remember <text> - durable memory request turn, sent as a senpi user message.
// The handler is host-neutral and lives in memory-core; this module registers it on senpi.

import { runRememberCommand } from "@oh-my-opencode/memory-core/commands"

import { senpiCommandDeps } from "./core-deps"
import { LAZY_MEMORY_COMMANDS, type MemoryCommandPort } from "./metadata"
import type { MemoryCommandContext, MemoryCommandDeps } from "./types"

export function registerRememberCommand(pi: MemoryCommandPort, deps: MemoryCommandDeps): void {
  pi.registerCommand("remember", {
    ...LAZY_MEMORY_COMMANDS.remember,
    handler: (args: string, ctx: MemoryCommandContext): Promise<string> => runRememberCommand(senpiCommandDeps(deps, pi), args, ctx),
  })
}
