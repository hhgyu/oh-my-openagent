// `/people [<name>] [--all]` (plan S7d): the people roster with its relationship graph, or one person's
// card, relationships and observations, through the memory-core palace read side (moved from omo-senpi
// `commands/people-runtime.ts`). The graph is derived on every read and never stored. `--ask` is refused
// with an explicit message: it needs a zero-tool memory child that V2 does not host yet (parity P-30).

import { parseCommandArgs } from "@oh-my-opencode/memory-core/commands/args"
import {
  derivePeopleGraph,
  describePersonMiss,
  parsePeopleCardLines,
  readPersonFile,
  renderPersonCard,
  renderRoster,
  resolvePersonQuery,
  selectPersonObservations,
} from "@oh-my-opencode/memory-core/palace"
import { GitMemoryRepo, type PeopleLimits } from "@oh-my-opencode/memory-core"
import { v2Slash } from "../commands/namespace"
import type { BoundMemorySession } from "./binding"
import { INSIGHT_COMMAND_NAMES, UNBOUND_MEMORY_SESSION } from "./insight-commands"
import type { ExtraMemoryCommand } from "./reflect-command"

const ASK_REFUSAL = `${v2Slash("people")} --ask is not available on OpenCode yet: it needs a dedicated memory child; use ${v2Slash("people")} <name> to read the record`

/** Native reads the root `memory.people` block here (no per-identity override). */
function peopleLimits(bound: BoundMemorySession): PeopleLimits | undefined {
  const people = bound.settings.people
  if (!people.enabled) return undefined
  return { maxEntries: people.max_entries, maxEntryChars: people.max_entry_chars }
}

export function createPeopleCommand(): ExtraMemoryCommand {
  return {
    name: INSIGHT_COMMAND_NAMES.people,
    description: "Show the people roster and relationship graph, or one person's record.",
    async run(bound: BoundMemorySession | undefined, args: string) {
      if (bound === undefined) return { text: UNBOUND_MEMORY_SESSION, level: "error" }
      if (/(?:^|\s)--ask(?:[=\s]|$)/.test(args)) return { text: ASK_REFUSAL, level: "error" }
      const limits = peopleLimits(bound)
      if (limits === undefined) return { text: "people records are disabled (memory.people.enabled)", level: "error" }
      const parsed = parseCommandArgs(args, { booleans: ["all"] })
      const repo = new GitMemoryRepo({ dir: bound.paths.repo, agentId: bound.identity })
      const graph = await derivePeopleGraph(repo, limits)
      const name = parsed.positionals.join(" ").trim()
      if (name.length === 0) return { text: renderRoster(graph), level: "info" }
      const resolved = resolvePersonQuery(graph.nodes, name)
      if (resolved.kind === "miss")
        return { text: describePersonMiss(graph.nodes, name, resolved.close), level: "error" }
      const node = graph.nodes.find((candidate) => candidate.slug === resolved.slug)
      if (node === undefined) return { text: `no person matches "${name}"`, level: "error" }
      const observations = await selectPersonObservations(repo, node.slug, limits, {
        all: parsed.flags.get("all") === true,
      })
      const cardLines = parsePeopleCardLines(await readPersonFile(repo, node.path), limits)
      return { text: renderPersonCard(node, cardLines, observations, graph.edges), level: "info" }
    },
  }
}
