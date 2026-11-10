import { CORE_MEMORY_COMMANDS } from "@oh-my-opencode/memory-core/command-metadata"

import type { SenpiExtensionAPI } from "../../../extension/types"
import type { MemoryCommandContext, MemoryCommandDeps } from "./types"

export function registerMemfsCommand(pi: SenpiExtensionAPI, deps: MemoryCommandDeps): void {
  pi.registerCommand("memfs", {
    ...CORE_MEMORY_COMMANDS.memfs,
    handler: async (args: string, ctx: MemoryCommandContext): Promise<string> => {
      const { runMemfs } = await import("#omo-memory-memfs-runtime")
      return runMemfs(deps, args, ctx)
    },
  })
}
