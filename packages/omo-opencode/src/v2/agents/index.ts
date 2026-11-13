import { Agent, Model } from "@opencode/plugin"
import type { AgentEditor, AgentDomain } from "@opencode/plugin/promise/agent"
import type { LoadOmoConfigOptions } from "@oh-my-opencode/omo-config-core"
import { CURATED_READONLY_AGENT_NAMES } from "@oh-my-opencode/senpi-task/agents-builtin"
import { AGENT_DEFINITIONS } from "./definitions"
import { loadAgentsConfig, type AgentsConfig, type AgentOverride } from "./config"
import { nativeAgentIdentities } from "./native-identities"
import { agentOverrideSchema } from "../config/agent-overrides"

export { AGENT_IDS, AGENT_DEFINITIONS } from "./definitions"
export { loadAgentsConfig } from "./config"

type Rule = ReturnType<AgentEditor["list"]>[number]["permissions"][number]
function permissions(override: AgentOverride): Rule[] {
  const rules: Rule[] = []
  for (const [action, enabled] of Object.entries(override.tools ?? {})) {
    if (enabled === true) rules.push({ action, resource: "*", effect: "allow" })
  }
  rules.push(...(override.permissions ?? []))
  for (const [action, value] of Object.entries(override.permission ?? {})) {
    if (typeof value === "string") rules.push({ action, resource: "*", effect: value })
    else for (const [resource, effect] of Object.entries(value)) rules.push({ action, resource, effect })
  }
  for (const [action, enabled] of Object.entries(override.tools ?? {})) {
    if (enabled === false) rules.push({ action, resource: "*", effect: "deny" })
  }
  for (const action of override.disallowed_tools ?? []) rules.push({ action, resource: "*", effect: "deny" })
  // Unified config keeps historical tool names, while OpenCode 2.2 uses
  // shell for bash and one edit permission for file mutation tools. Retain
  // original rules for older hosts and add the native action with the same scope.
  const nativeAction: Record<string, string> = {
    bash: "shell",
    write: "edit",
    apply_patch: "edit",
    patch: "edit",
    task: "subagent",
    agent: "subagent",
    call_omo_agent: "subagent",
  }
  return rules.flatMap((rule) => {
    const action = nativeAction[rule.action]
    return action === undefined ? [rule] : [rule, { ...rule, action }]
  })
}

export function applyAgents(
  editor: AgentEditor,
  config: AgentsConfig,
  warn: (message: string) => void = (message) => console.warn(message),
): void {
  const disabled = new Set(config.disabled_agents)
  for (const definition of [...AGENT_DEFINITIONS, ...nativeAgentIdentities(config)]) {
    const input = { ...config.nativeAgents?.[definition.id], ...config.agents[definition.id] }
    if (disabled.has(definition.id) || input.disable === true) {
      editor.remove(definition.id)
      continue
    }
    const converted = agentOverrideSchema.safeParse(input)
    if (!converted.success) {
      const fields = [
        ...new Set(converted.error.issues.map((issue) => `agents.${definition.id}.${issue.path.join(".")}`)),
      ]
      warn(
        `[oh-my-openagent/v2] Ignoring invalid agent override: ${fields.join(", ")}. Fix these fields and reload OmO.${definition.hidden ? " Identity skipped." : " Using stock defaults."}`,
      )
      if (definition.hidden) {
        editor.remove(definition.id)
        continue
      }
    }
    const override = converted.success ? converted.data : {}
    const first = override.models?.[0]
    const model = typeof first === "string" ? first : (first?.model ?? override.model)
    let modelRef: ReturnType<typeof Model.Ref.parse> | undefined
    if (model !== undefined) {
      try {
        modelRef = Model.Ref.parse(model)
      } catch {
        warn(
          `[oh-my-openagent/v2] Ignoring invalid model reference at agents.${definition.id}.${first === undefined ? "model" : "models.0"}: expected provider/model.${definition.hidden ? " Identity skipped; fix the field and reload OmO." : ""}`,
        )
        if (definition.hidden) {
          editor.remove(definition.id)
          continue
        }
      }
    }
    editor.update(definition.id, (agent) => {
      agent.name = Agent.Name.make(override.displayName ?? definition.name)
      agent.description = override.description ?? definition.description
      agent.mode = definition.hidden ? "subagent" : (override.mode ?? definition.mode)
      agent.hidden = definition.hidden ?? false
      agent.system = [override.prompt ?? definition.system, override.prompt_append]
        .filter((part) => part !== undefined && part.length > 0)
        .join("\n\n")
      if (override.color !== undefined) agent.color = override.color
      if (modelRef !== undefined) agent.model = modelRef
      const reasoning =
        (typeof first === "object" ? first.reasoning : undefined) ?? override.reasoning ?? override.variant
      if (reasoning !== undefined && agent.model !== undefined) agent.model.variant = Model.VariantID.make(reasoning)
      if (override.temperature !== undefined) agent.request.body.temperature = override.temperature
      // Host replay starts from a fresh draft. Deduplication also makes reapplication safe.
      const curatedDefaults: Rule[] = CURATED_READONLY_AGENT_NAMES.has(definition.id)
        ? ["omo_native_readonly", "omo_native_ls"].map((action) => ({ action, resource: "*", effect: "allow" }))
        : []
      const combined = [...agent.permissions, ...curatedDefaults, ...permissions(override), ...definition.restrictions]
      agent.permissions = combined.filter(
        (rule, index) =>
          combined.findLastIndex((other) => other.action === rule.action && other.resource === rule.resource) === index,
      )
    })
  }
  const selectable = (id: string) => {
    const agent = editor.get(id)
    return agent !== undefined && agent.mode !== "subagent" && !agent.hidden
  }
  const implementationAvailable = AGENT_DEFINITIONS.some(
    (definition) => definition.id !== "prometheus" && selectable(definition.id),
  )
  const plannerAvailable = selectable("prometheus")
  // Hide redundant picker choices, retaining builtin IDs for internal and explicit
  // dispatch. The host still honors a selectable custom configured default and
  // naturally falls back to the first selectable OmO agent if Build is hidden.
  for (const id of ["build", "builder", "plan"]) {
    if (editor.get(id) !== undefined && (id === "plan" ? plannerAvailable : implementationAvailable)) {
      editor.update(id, (agent) => {
        agent.hidden = true
        agent.mode = "subagent"
      })
    }
  }
}

export async function registerAgents(
  domain: Pick<AgentDomain, "transform">,
  options: LoadOmoConfigOptions,
): Promise<() => Promise<void>> {
  // Reload replays this transform and rereads unified config; disposing removes its ownership.
  let previous = new Set<string>()
  const registration = await domain.transform((editor) => {
    const current = new Set<string>()
    applyAgents(editor, loadAgentsConfig(options), (message) => {
      current.add(message)
      if (!previous.has(message)) console.warn(message)
    })
    previous = current
  })
  return () => registration.dispose()
}
