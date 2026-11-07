import type { LoadOmoConfigOptions } from "@oh-my-opencode/omo-config-core"
import { loadRuntimeConfig } from "../config/runtime"
export { agentOverrideSchema, type AgentOverride, type AgentsConfig } from "../config/agent-overrides"

/** Compatibility view for the existing eleven OpenCode agents. */
export function loadAgentsConfig(options: LoadOmoConfigOptions) {
  const snapshot = loadRuntimeConfig(options)
  // Core diagnostics are retained on the snapshot. Do not print raw config values.
  for (const diagnostic of snapshot.diagnostics) {
    console.warn(`[oh-my-openagent/v2] ${diagnostic.kind}: ${diagnostic.path}`)
  }
  return snapshot.agents
}
