// The hidden `omo-facts` agent the facts extractor child runs as, registered by the memory component
// like the Kibitzer judge (not in `agents/definitions.ts`): its system prompt is memory-core's packaged
// facts persona, it is a hidden subagent, and its permissions deny everything except `record_fact`.
// The same rules are written onto the child session at `stage`, so either layer alone confines it.
// The model is chosen per launch (`facts-model.ts`) and passed at `stage`, not pinned here.

import { Agent } from "@opencode/plugin"
import type { AgentDomain, AgentEditor } from "@opencode/plugin/promise/agent"
import type { Registration } from "@opencode/plugin/promise/registration"
import { FACTS_RECORD_TOOL_NAME } from "./facts-record-tool"

export const FACTS_AGENT_ID = "omo-facts"

type PermissionRule = ReturnType<AgentEditor["list"]>[number]["permissions"][number]

export const FACTS_PERMISSIONS: readonly PermissionRule[] = Object.freeze([
  { action: "*", resource: "*", effect: "deny" },
  { action: FACTS_RECORD_TOOL_NAME, resource: "*", effect: "allow" },
])

export async function registerFactsAgent(
  domain: Pick<AgentDomain, "transform">,
  persona: string,
): Promise<Registration> {
  return domain.transform((editor) => {
    editor.update(FACTS_AGENT_ID, (agent) => {
      agent.name = Agent.Name.make("Facts Extractor")
      agent.description = "Extracts durable facts from a settled conversation; records them only through record_fact."
      agent.mode = "subagent"
      agent.hidden = true
      agent.system = persona
      agent.permissions = FACTS_PERMISSIONS.map((rule) => ({ ...rule }))
    })
  })
}
