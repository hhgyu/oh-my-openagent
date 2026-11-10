// The hidden `kibitzer` agent the resident child runs as. It is registered by the memory component
// itself (not in `agents/definitions.ts`, whose eleven OmO roles are user-selectable and carry the
// shared execution prompt): its system prompt is the packaged Kibitzer persona, it is a hidden
// subagent, and its permissions deny everything except the five read-only tool actions. The same
// rules are written onto the child session at `stage`, so either layer alone keeps it read-only.

import { loadKibitzerPersona } from "@oh-my-opencode/memory-core"
import { KIBITZER_SIDECAR_TOOL_NAMES } from "@oh-my-opencode/memory-core/recall-sidecar"
import type { OmoConfig } from "@oh-my-opencode/omo-config-core"
import { Agent, Model } from "@opencode/plugin"
import type { AgentDomain, AgentEditor } from "@opencode/plugin/promise/agent"
import type { Registration } from "@opencode/plugin/promise/registration"

export const KIBITZER_AGENT_ID = "kibitzer"

type PermissionRule = ReturnType<AgentEditor["list"]>[number]["permissions"][number]

/** Deny everything, then allow exactly the five tool actions the envelope contract names. */
export const KIBITZER_PERMISSIONS: readonly PermissionRule[] = Object.freeze([
  { action: "*", resource: "*", effect: "deny" },
  ...KIBITZER_SIDECAR_TOOL_NAMES.map((action): PermissionRule => ({ action, resource: "*", effect: "allow" })),
])

/** `categories.<memory.recall.category>` first model (`models[0]`, else `model`) as `provider/model`. */
export function kibitzerCategoryModel(config: Pick<OmoConfig, "categories">, category: string): string | undefined {
  const entry = config.categories?.[category]
  if (entry === undefined) return undefined
  const first = entry.models?.[0]
  const model = typeof first === "string" ? first : first?.model ?? entry.model
  return model !== undefined && model.includes("/") ? model : undefined
}

function applyKibitzerAgent(editor: AgentEditor, options: { readonly persona: string; readonly model?: string; readonly warn?: (message: string) => void }): void {
  editor.update(KIBITZER_AGENT_ID, agent => {
    agent.name = Agent.Name.make("Kibitzer")
    agent.description = "Read-only memory recall judge; nudges only through the nudge tool."
    agent.mode = "subagent"
    agent.hidden = true
    agent.system = options.persona
    if (options.model !== undefined) {
      try {
        agent.model = Model.Ref.parse(options.model)
      } catch (error) {
        options.warn?.(`kibitzer ignored an invalid category model reference: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    agent.permissions = KIBITZER_PERMISSIONS.map(rule => ({ ...rule }))
  })
}

export async function registerKibitzerAgent(
  domain: Pick<AgentDomain, "transform">,
  options: { readonly model: () => string | undefined; readonly persona?: () => string; readonly warn?: (message: string) => void },
): Promise<Registration> {
  const persona = options.persona ?? loadKibitzerPersona
  return domain.transform(editor => {
    const model = options.model()
    applyKibitzerAgent(editor, { persona: persona(), ...(model === undefined ? {} : { model }), ...(options.warn === undefined ? {} : { warn: options.warn }) })
  })
}
