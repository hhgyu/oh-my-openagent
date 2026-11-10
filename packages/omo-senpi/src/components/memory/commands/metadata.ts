// Names, descriptions and argument hints of the memory slash commands whose handlers ship in the
// `#omo-memory-commands-runtime` sidecar. The entry bundle registers these commands from this table
// (register.ts) and each command module uses the same entry, so a command reads the same before and
// after its handler is loaded.

import { CORE_MEMORY_COMMANDS } from "@oh-my-opencode/memory-core/command-metadata"

import type { SenpiExtensionAPI } from "../../../extension/types"

export type MemoryCommandPort = Pick<SenpiExtensionAPI, "registerCommand" | "sendUserMessage">

export const LAZY_MEMORY_COMMANDS = {
  memory: CORE_MEMORY_COMMANDS.memory,
  remember: CORE_MEMORY_COMMANDS.remember,
  init: CORE_MEMORY_COMMANDS.init,
  recompile: CORE_MEMORY_COMMANDS.recompile,
  "memory-repository": CORE_MEMORY_COMMANDS["memory-repository"],
  sleeptime: {
    description: "Show the resolved sleeptime memory settings for this identity.",
    argumentHint: "",
  },
  reflect: {
    description: "Request a memory reflection run now, optionally scoped and focused.",
    argumentHint: "[--recent N | --conversation <ids>] [focus]",
  },
  dream: {
    description: "Request a manual multi-conversation memory dream run.",
    argumentHint: "[--auto | --recent N | --conversation <ids> | --from transcript:<path>] [--to <doc>] [focus]",
  },
  search: CORE_MEMORY_COMMANDS.search,
  facts: {
    description: "Show facts-extraction queue/backoff state, or manually retry parked batches.",
    argumentHint: "[retry [--conversation <id>]]",
  },
  agreements: {
    description: "List, add, acknowledge, or drop your standing agreements with the agent.",
    argumentHint: "[list] | add [--project] <text> | ack <id> | drop <id>",
  },
} as const satisfies Record<string, { readonly description: string; readonly argumentHint: string }>

export type LazyMemoryCommandName = keyof typeof LAZY_MEMORY_COMMANDS
