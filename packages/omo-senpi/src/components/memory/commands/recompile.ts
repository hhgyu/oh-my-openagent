// /recompile - bust the compiled memory-block cache (memory-core runRecompileCommand).
// The handler is host-neutral and lives in memory-core; this module registers it on senpi.

import { runRecompileCommand } from "@oh-my-opencode/memory-core/commands"

import { senpiCommandDeps } from "./core-deps"
import { LAZY_MEMORY_COMMANDS, type MemoryCommandPort } from "./metadata"
import type { MemoryCommandContext, MemoryCommandDeps } from "./types"

export function registerRecompileCommand(pi: MemoryCommandPort, deps: MemoryCommandDeps): void {
  pi.registerCommand("recompile", {
    ...LAZY_MEMORY_COMMANDS.recompile,
    handler: (args: string, ctx: MemoryCommandContext): Promise<string> => runRecompileCommand(senpiCommandDeps(deps), args, ctx),
  })
}
