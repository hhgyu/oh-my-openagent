export const BUILTIN_AGENT_NAMES: readonly string[] = [
  "explore",
  "librarian",
  "plan-consultant",
  "plan-reviewer",
  "omo-native-code-reviewer",
  "omo-native-qa-executor",
  "omo-native-gate-reviewer",
]

// Prompt-free twin of CURATED_READONLY_AGENT_DEFAULTS: importing the definitions would pull every builtin
// prompt into a bundle that only needs the names (the Senpi entry bundle's telemetry).
export const CURATED_READONLY_AGENT_NAMES: ReadonlySet<string> = new Set([
  "explore",
  "librarian",
  "plan-consultant",
  "plan-reviewer",
])
