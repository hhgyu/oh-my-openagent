// Names, descriptions and argument hints of the host-neutral memory slash commands. Every harness
// registers these commands from this table so a command reads the same on each host.

export const MEMORY_REPOSITORY_SUBCOMMANDS = ["set", "unset", "status", "push"] as const

export const MEMFS_SUBCOMMANDS = ["status", "init", "sync", "repair", "reset", "backup", "restore", "diff", "tokens"] as const

export const CORE_MEMORY_COMMANDS = {
  memory: {
    description: "View committed memory: HEAD, system bodies, external names, and uncommitted changes; unlock re-checks and removes a stranded git lock.",
    argumentHint: "[unlock <lock path> [--force]]",
  },
  memfs: {
    description: "Inspect and maintain the memory filesystem repository.",
    argumentHint: `<${MEMFS_SUBCOMMANDS.join("|")}>`,
  },
  remember: {
    description: "Persist text to long-term memory via a memory-tool turn.",
    argumentHint: "<text>",
  },
  init: {
    description: "Initialize the memory repository and instruct the agent to create initial memory.",
    argumentHint: "",
  },
  recompile: {
    description: "Recompile the memory block into the system prompt on the next agent run.",
    argumentHint: "",
  },
  "memory-repository": {
    description: "Configure the push-only mirror remote for the memory repository.",
    argumentHint: `<${MEMORY_REPOSITORY_SUBCOMMANDS.join("|")}> [url]`,
  },
  search: {
    description: "Search past session transcripts and show scored, numbered results.",
    argumentHint: "<query> [--include-hidden]",
  },
} as const satisfies Record<string, { readonly description: string; readonly argumentHint: string }>

export type CoreMemoryCommandName = keyof typeof CORE_MEMORY_COMMANDS
