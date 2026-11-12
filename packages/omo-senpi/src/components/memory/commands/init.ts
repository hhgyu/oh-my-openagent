// /init - initialize the memory repository and send the init turn as a senpi user message.
// The handler is host-neutral and lives in memory-core; this module registers it on senpi.

import { runInitCommand } from "@oh-my-opencode/memory-core/commands"

import { senpiCommandDeps } from "./core-deps"
import { LAZY_MEMORY_COMMANDS, type MemoryCommandPort } from "./metadata"
import type { MemoryCommandContext, MemoryCommandDeps } from "./types"

export function registerInitCommand(pi: MemoryCommandPort, deps: MemoryCommandDeps): void {
  pi.registerCommand("init", {
    ...LAZY_MEMORY_COMMANDS.init,
    handler: (args: string, ctx: MemoryCommandContext): Promise<string> =>
      runInitCommand(senpiCommandDeps(deps, pi), args, ctx),
  })
}
