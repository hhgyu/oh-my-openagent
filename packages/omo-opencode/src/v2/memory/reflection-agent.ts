// The hidden `omo-reflection` and `omo-dream` agents the reflection child runs as, registered by the
// memory component like the facts extractor and the Kibitzer judge (not in `agents/definitions.ts`): their
// system prompts are the V2 tool-based reflection and dream personas, both are hidden subagents, and their
// permissions deny everything except the four reflection tools. The same rules are written onto the child
// session at `stage`, so either layer alone confines it. The model is chosen per launch and passed at `stage`.
// A dream run is a reflection run with the dream persona (Senpi swaps `--system-prompt`); the agent is the
// only per-launch place a V2 system prompt can differ, so the dream gets its own hidden agent.

import { Agent } from "@opencode/plugin"
import type { AgentDomain, AgentEditor } from "@opencode/plugin/promise/agent"
import type { Registration } from "@opencode/plugin/promise/registration"
import { DREAM_PERSONA } from "./dream-persona"
import { REFLECTION_PERSONA } from "./reflection-persona"
import { REFLECTION_TOOL_NAMES } from "./reflection-tools"

export const REFLECTION_AGENT_ID = "omo-reflection"
export const DREAM_AGENT_ID = "omo-dream"

type PermissionRule = ReturnType<AgentEditor["list"]>[number]["permissions"][number]

/** Deny everything, then allow exactly the four reflection tools. */
export const REFLECTION_PERMISSIONS: readonly PermissionRule[] = Object.freeze([
  { action: "*", resource: "*", effect: "deny" },
  ...REFLECTION_TOOL_NAMES.map((action): PermissionRule => ({ action, resource: "*", effect: "allow" })),
])

export async function registerReflectionAgent(domain: Pick<AgentDomain, "transform">, persona: string = REFLECTION_PERSONA): Promise<Registration> {
  return domain.transform(editor => {
    editor.update(REFLECTION_AGENT_ID, agent => {
      agent.name = Agent.Name.make("Memory Reflection")
      agent.description = "Reflects on settled conversations into memory; reads and edits only through the reflection tools."
      agent.mode = "subagent"
      agent.hidden = true
      agent.system = persona
      agent.permissions = REFLECTION_PERMISSIONS.map(rule => ({ ...rule }))
    })
    editor.update(DREAM_AGENT_ID, agent => {
      agent.name = Agent.Name.make("Memory Dream")
      agent.description = "Consolidates memory across conversations; reads and edits only through the reflection tools."
      agent.mode = "subagent"
      agent.hidden = true
      agent.system = DREAM_PERSONA
      agent.permissions = REFLECTION_PERMISSIONS.map(rule => ({ ...rule }))
    })
  })
}
