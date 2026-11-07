import { Agent, Model } from "@opencode/plugin"
import type { AgentEditor, AgentDomain } from "@opencode/plugin/promise/agent"
import type { LoadOmoConfigOptions } from "@oh-my-opencode/omo-config-core"
import { AGENT_DEFINITIONS } from "./definitions"
import { loadAgentsConfig, type AgentsConfig, type AgentOverride } from "./config"

export { AGENT_IDS, AGENT_DEFINITIONS } from "./definitions"
export { loadAgentsConfig } from "./config"

type Rule = ReturnType<AgentEditor["list"]>[number]["permissions"][number]
function permissions(override: AgentOverride): Rule[] {
  const rules: Rule[] = [...(override.permissions ?? [])]
  for (const [action, value] of Object.entries(override.permission ?? {})) {
    if (typeof value === "string") rules.push({ action, resource: "*", effect: value })
    else for (const [resource, effect] of Object.entries(value)) rules.push({ action, resource, effect })
  }
  for (const [action, enabled] of Object.entries(override.tools ?? {})) {
    rules.push({ action, resource: "*", effect: enabled ? "allow" : "deny" })
  }
  for (const action of override.disallowed_tools ?? []) rules.push({ action, resource: "*", effect: "deny" })
  // Unified config keeps historical tool names, while OpenCode 2.2 uses
  // shell for bash and one edit permission for file mutation tools. Retain
  // original rules for older hosts and add the native action with the same scope.
  const nativeAction: Record<string, string> = {
    bash: "shell", write: "edit", apply_patch: "edit", patch: "edit",
    task: "subagent", agent: "subagent", call_omo_agent: "subagent",
  }
  return rules.flatMap((rule) => {
    const action = nativeAction[rule.action]
    return action === undefined ? [rule] : [rule, { ...rule, action }]
  })
}

export function applyAgents(editor: AgentEditor, config: AgentsConfig): void {
  const disabled = new Set(config.disabled_agents)
  for (const definition of AGENT_DEFINITIONS) {
    const override = config.agents[definition.id] ?? {}
    if (disabled.has(definition.id) || override.disable) {
      editor.remove(definition.id)
      continue
    }
    editor.update(definition.id, (agent) => {
      agent.name = Agent.Name.make(override.displayName ?? definition.name)
      agent.description = override.description ?? definition.description
      agent.mode = override.mode ?? definition.mode
      agent.hidden = false
      agent.system = [override.prompt ?? definition.system, override.prompt_append].filter((part) => part !== undefined && part.length > 0).join("\n\n")
      if (override.color !== undefined) agent.color = override.color
      const first = override.models?.[0]
      const model = typeof first === "string" ? first : first?.model ?? override.model
      if (model !== undefined) {
        try { agent.model = Model.Ref.parse(model) }
        catch { console.warn(`[oh-my-openagent/v2] Ignoring invalid model reference for ${definition.id}: expected provider/model`) }
      }
      const reasoning = (typeof first === "object" ? first.reasoning : undefined) ?? override.reasoning ?? override.variant
      if (reasoning !== undefined && agent.model !== undefined) agent.model.variant = Model.VariantID.make(reasoning)
      if (override.temperature !== undefined) agent.request.body.temperature = override.temperature
      // Host replay starts from a fresh draft. Deduplication also makes reapplication safe.
      const combined = [...agent.permissions, ...permissions(override), ...definition.restrictions]
      agent.permissions = combined.filter((rule, index) => combined.findLastIndex((other) => other.action === rule.action && other.resource === rule.resource) === index)
    })
  }
  const selectable = (id: string) => {
    const agent = editor.get(id)
    return agent !== undefined && agent.mode !== "subagent" && !agent.hidden
  }
  const implementationAvailable = AGENT_DEFINITIONS.some((definition) => definition.id !== "prometheus" && selectable(definition.id))
  const plannerAvailable = selectable("prometheus")
  // Hide redundant picker choices, retaining builtin IDs for internal and explicit
  // dispatch. The host still honors a selectable custom configured default and
  // naturally falls back to the first selectable OmO agent if Build is hidden.
  for (const id of ["build", "builder", "plan"]) {
    if (editor.get(id) !== undefined && (id === "plan" ? plannerAvailable : implementationAvailable)) {
      editor.update(id, (agent) => { agent.hidden = true; agent.mode = "subagent" })
    }
  }
}

export async function registerAgents(domain: Pick<AgentDomain, "transform">, options: LoadOmoConfigOptions): Promise<() => Promise<void>> {
  // Reload replays this transform and rereads unified config; disposing removes its ownership.
  const registration = await domain.transform((editor) => applyAgents(editor, loadAgentsConfig(options)))
  return () => registration.dispose()
}
