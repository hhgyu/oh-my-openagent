// Prompt-free builtin agent names. Consumers that only need a name (config shadowing, telemetry enums)
// import this module so the agent prompts stay in the lazy task sidecar instead of the entry bundle.
// Plain literals on purpose: a spread of one constant into another is folded differently by the Linux
// and Windows bundle builds, which makes the committed omo.js stale on one of them.

export const BUILTIN_AGENT_NAMES: readonly string[] = [
  "explore",
  "librarian",
  "plan-consultant",
  "plan-reviewer",
  "omo-native-code-reviewer",
  "omo-native-qa-executor",
  "omo-native-gate-reviewer",
]

export const CURATED_READONLY_AGENT_NAMES: ReadonlySet<string> = new Set([
  "explore",
  "librarian",
  "plan-consultant",
  "plan-reviewer",
])
