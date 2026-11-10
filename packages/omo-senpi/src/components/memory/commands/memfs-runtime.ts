// Sidecar entry for `/memfs` (`#omo-memory-memfs-runtime`). The handlers are host-neutral and live in
// memory-core; this entry adapts senpi's deps onto them.

import { runMemfsCommand } from "@oh-my-opencode/memory-core/commands"

import { senpiCommandDeps } from "./core-deps"
import type { MemoryCommandContext, MemoryCommandDeps } from "./types"

export function runMemfs(deps: MemoryCommandDeps, args: string, ctx: MemoryCommandContext): Promise<string> {
  return runMemfsCommand(senpiCommandDeps(deps), args, ctx)
}
