// `/sleeptime` (plan S7c): a read-only view of the resolved memory settings for the bound identity,
// porting omo-senpi `commands/sleeptime.ts`. Each value carries ` [agent override]` when
// `memory.agents.<identity>` sets it. OpenCode 2 differences: the dream `shutdown_launch` setting and the
// reflection `sandbox` setting are shown as not used (V2 has no shutdown event, P-29, and the reflection
// child edits through private tools instead of a sandboxed shell, P-28), and the config hint names the
// unified omo config files instead of a resolved path.

import type { OmoMemorySettings } from "@oh-my-opencode/omo-config-core"
import { v2Slash } from "../commands/namespace"
import type { BoundMemorySession } from "./binding"
import { INSIGHT_COMMAND_NAMES, UNBOUND_MEMORY_SESSION } from "./insight-commands"
import type { ExtraMemoryCommand } from "./reflect-command"
import { reflectionSettings } from "./reflection-run-store"

const OVERRIDE_MARK = " [agent override]"

const mark = (overridden: boolean): string => (overridden ? OVERRIDE_MARK : "")
const onOff = (value: boolean): string => (value ? "on" : "off")

function renderSleeptime(settings: OmoMemorySettings, agentId: string): string {
  const agent = settings.agents[agentId]
  const reflection = reflectionSettings({ settings, identity: agentId })
  const r = agent?.reflection
  const nudge = { ...settings.nudge, ...agent?.nudge }
  const facts = { ...settings.facts, ...agent?.facts }
  const dream = { ...settings.dream, ...agent?.dream }
  const people = { ...settings.people, ...agent?.people }
  const soul = { ...settings.soul, ...agent?.soul }
  const has = (block: Readonly<Record<string, unknown>> | undefined, key: string): boolean => block?.[key] !== undefined
  return [
    `# Sleeptime reflection: ${agentId}`,
    "",
    `Reflection: ${onOff(reflection.enabled)}${mark(has(r, "enabled"))}`,
    `Step trigger: ${reflection.trigger.step_count > 0 ? `every ${reflection.trigger.step_count} steps` : "off"}${mark(r?.trigger?.step_count !== undefined)}`,
    `On compaction: ${onOff(reflection.trigger.on_compaction)}${mark(r?.trigger?.on_compaction !== undefined)}`,
    `Merge policy: ${reflection.merge}${mark(has(r, "merge"))}`,
    `Category: ${reflection.category}${mark(has(r, "category"))}`,
    `Timeout: ${reflection.timeout_minutes} minutes${mark(has(r, "timeout_minutes"))}`,
    "Sandbox: not used on OpenCode (the reflection child edits through private tools)",
    "",
    `Nudge: ${onOff(nudge.enabled)}${mark(has(agent?.nudge, "enabled"))}`,
    `Nudge every: every ${nudge.every_user_turns} turns${mark(has(agent?.nudge, "every_user_turns"))}`,
    "",
    `Facts: ${onOff(facts.enabled)}${mark(has(agent?.facts, "enabled"))}`,
    `Facts debounce: debounce ${facts.debounce_settles} settles${mark(has(agent?.facts, "debounce_settles"))}`,
    "",
    `Dream: ${onOff(dream.enabled)}${mark(has(agent?.dream, "enabled"))}`,
    `Dream idle: idle ${dream.idle_minutes} minutes${mark(has(agent?.dream, "idle_minutes"))}`,
    `Dream spacing: min ${dream.min_hours_between}h between${mark(has(agent?.dream, "min_hours_between"))}`,
    "Dream shutdown: not available on OpenCode (no shutdown event)",
    `Dream select: select max ${dream.auto_select_max}${mark(has(agent?.dream, "auto_select_max"))}`,
    `Dream select chars: max ${dream.auto_select_max_chars} chars${mark(has(agent?.dream, "auto_select_max_chars"))}`,
    "",
    `People: ${onOff(people.enabled)}${mark(has(agent?.people, "enabled"))}`,
    `People entries: max ${people.max_entries} entries${mark(has(agent?.people, "max_entries"))}`,
    `People chars: max ${people.max_entry_chars} chars${mark(has(agent?.people, "max_entry_chars"))}`,
    "",
    `Soul: edit notice ${onOff(soul.edit_notice)}${mark(has(agent?.soul, "edit_notice"))}`,
    "",
    `Edit your omo config file (~/.omo/omo.jsonc, or .omo/omo.jsonc in a project) under memory.reflection, or memory.agents.${agentId} for this identity only.`,
    `Reflect now: ${v2Slash("reflect")} [--recent N | --conversation <ids>] [focus]`,
    `Dream now: ${v2Slash("dream")} [--auto|--recent N|--conversation <ids>] [focus]`,
  ].join("\n")
}

export function createSleeptimeCommand(): ExtraMemoryCommand {
  return {
    name: INSIGHT_COMMAND_NAMES.sleeptime,
    description: "Show the resolved reflection, nudge, facts, dream, people and soul settings for this identity.",
    async run(bound: BoundMemorySession | undefined) {
      if (bound === undefined) return { text: UNBOUND_MEMORY_SESSION, level: "error" }
      return { text: renderSleeptime(bound.settings, bound.identity), level: "info" }
    },
  }
}
