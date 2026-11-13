// /facts -- read-only view of the facts pipeline, plus the ONLY manual unpark path.
// The handler is host-neutral and lives in memory-core; this module registers it on senpi.

import { runFactsCommand } from "@oh-my-opencode/memory-core/commands/facts"

import { senpiCommandDeps } from "./core-deps"
import { LAZY_MEMORY_COMMANDS, type MemoryCommandPort } from "./metadata"
import type { MemoryCommandContext, MemoryCommandDeps } from "./types"

export function registerFactsCommand(pi: MemoryCommandPort, deps: MemoryCommandDeps): void {
  pi.registerCommand("facts", {
    ...LAZY_MEMORY_COMMANDS.facts,
    handler: (args: string, ctx: MemoryCommandContext): Promise<string> =>
      runFactsCommand(senpiCommandDeps(deps), args, ctx),
  })
}
