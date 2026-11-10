// /agreements: the person's own surface over system/agreements.md.
// The handler is host-neutral and lives in memory-core; this module registers it on senpi.

import { runAgreementsCommand } from "@oh-my-opencode/memory-core/commands/agreements"

import { senpiCommandDeps } from "./core-deps"
import { LAZY_MEMORY_COMMANDS, type MemoryCommandPort } from "./metadata"
import type { MemoryCommandContext, MemoryCommandDeps } from "./types"

export function registerAgreementsCommand(pi: MemoryCommandPort, deps: MemoryCommandDeps): void {
  pi.registerCommand("agreements", {
    ...LAZY_MEMORY_COMMANDS.agreements,
    handler: (args: string, ctx: MemoryCommandContext): Promise<string> => runAgreementsCommand(senpiCommandDeps(deps), args, ctx),
  })
}
