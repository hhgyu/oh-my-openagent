// /search - FTS-lite scan over senpi session JSONL (memory-core runSearchCommand).
// The handler is host-neutral and lives in memory-core; this module registers it on senpi.

import { runSearchCommand } from "@oh-my-opencode/memory-core/commands"

import { senpiCommandDeps } from "./core-deps"
import { LAZY_MEMORY_COMMANDS, type MemoryCommandPort } from "./metadata"
import type { MemoryCommandContext, MemoryCommandDeps } from "./types"

export function registerSearchCommand(pi: MemoryCommandPort, deps: MemoryCommandDeps): void {
  pi.registerCommand("search", {
    ...LAZY_MEMORY_COMMANDS.search,
    handler: (args: string, ctx: MemoryCommandContext): Promise<string> => runSearchCommand(senpiCommandDeps(deps), args, ctx),
  })
}
