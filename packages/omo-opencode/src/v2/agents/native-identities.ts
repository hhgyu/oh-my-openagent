import { CURATED_READONLY_AGENT_NAMES } from "@oh-my-opencode/senpi-task/agents-builtin"
import { resolveTaskAgents } from "@oh-my-opencode/senpi-task/task-operations"
import { AGENT_IDS, CURATED_ROLE_RESTRICTIONS, type AgentDefinition } from "./definitions"
import type { AgentsConfig } from "./config"

export function nativeAgentIdentities(config: AgentsConfig): AgentDefinition[] {
  const roles = new Set<string>(AGENT_IDS)
  return Object.entries(resolveTaskAgents({ agents: config.nativeAgents }))
    .filter(([id]) => !roles.has(id))
    .map(([id, definition]) => ({
      id,
      name: id,
      description: definition.description ?? `Native task agent ${id}`,
      mode: "subagent",
      hidden: true,
      system: definition.prompt ?? "",
      restrictions: CURATED_READONLY_AGENT_NAMES.has(id) ? CURATED_ROLE_RESTRICTIONS : [],
    }))
}
