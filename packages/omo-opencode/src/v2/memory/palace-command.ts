// `/palace` (plan S7d): writes the self-contained memory palace HTML viewer for the bound identity through
// the memory-core generator (moved from omo-senpi `palace/generator.ts`) to
// `<identity runtime>/viewers/palace-<timestamp>.html` (0600 in a 0700 directory) and reports the path.
// Senpi opens the file on a desktop session; the V2 component runs inside the OpenCode server, which may
// not share a display with the user, so the path is always reported instead (parity P-16).

import { generatePalaceHtml } from "@oh-my-opencode/memory-core/palace"
import type { BoundMemorySession } from "./binding"
import { INSIGHT_COMMAND_NAMES } from "./insight-commands"
import type { ExtraMemoryCommand } from "./reflect-command"

const UNBOUND_NOTICE = "memory is not bound in this session, so /palace has nothing to render"

export function createPalaceCommand(deps: { readonly now?: () => Date } = {}): ExtraMemoryCommand {
  return {
    name: INSIGHT_COMMAND_NAMES.palace,
    description: "Generate the memory palace HTML viewer for the bound identity and report its path.",
    async run(bound: BoundMemorySession | undefined) {
      if (bound === undefined) return { text: UNBOUND_NOTICE, level: "warning" }
      const people = bound.settings.people
      const { path } = await generatePalaceHtml(
        { identity: bound.identity, identityPaths: bound.paths },
        {
          people: {
            enabled: people.enabled,
            limits: { maxEntries: people.max_entries, maxEntryChars: people.max_entry_chars },
          },
          ...(deps.now === undefined ? {} : { now: deps.now }),
        },
      )
      return { text: `memory palace written to ${path}`, level: "info" }
    },
  }
}
