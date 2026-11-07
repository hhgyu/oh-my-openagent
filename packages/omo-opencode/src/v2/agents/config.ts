import { z } from "zod"
import {
  loadOmoConfig, mergeOmoConfigRecords, resolveOmoConfigView, resolveModelReferences,
  OmoConfigSchema, OmoModelCatalogSchema, type LoadOmoConfigOptions,
} from "@oh-my-opencode/omo-config-core"

const effect = z.enum(["allow", "deny", "ask"])
const modelEntry = z.union([z.string(), z.object({ model: z.string(), reasoning: z.string().optional() })])
export const agentOverrideSchema = z.object({
  model: z.string().optional(), models: z.array(modelEntry).optional(),
  reasoning: z.string().optional(), variant: z.string().optional(),
  prompt: z.string().optional(), prompt_append: z.string().optional(),
  description: z.string().optional(), displayName: z.string().optional(),
  mode: z.enum(["primary", "subagent", "all"]).optional(),
  color: z.string().optional(), disable: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  permission: z.record(z.string(), z.union([effect, z.record(z.string(), effect)])).optional(),
  permissions: z.array(z.object({ action: z.string(), resource: z.string(), effect })).optional(),
  tools: z.record(z.string(), z.boolean()).optional(),
  disallowed_tools: z.array(z.string()).optional(),
})
export type AgentOverride = z.infer<typeof agentOverrideSchema>
export type AgentsConfig = { agents: Record<string, AgentOverride>; disabled_agents: string[] }

// The core owns discovery, JSONC parsing, validation, layer order and profile selection.
// OpenCode-only fields remain in its intentionally open [opencode] block.
export function loadAgentsConfig(options: LoadOmoConfigOptions): AgentsConfig {
  const loaded = loadOmoConfig(options)
  for (const diagnostic of loaded.diagnostics) console.warn(`[oh-my-openagent/v2] ${diagnostic.path}: ${diagnostic.message}`)
  const merged = loaded.layers.reduce<Record<string, unknown>>((result, layer) => mergeOmoConfigRecords(result, layer.config), {})
  const resolved = resolveOmoConfigView({ config: merged, harness: "opencode", profile: loaded.profile }).config
  const agents: Record<string, AgentOverride> = {}
  if (typeof resolved.agents === "object" && resolved.agents !== null) {
    for (const [id, input] of Object.entries(resolved.agents)) {
      const parsed = agentOverrideSchema.safeParse(input)
      if (parsed.success) agents[id] = parsed.data
      else console.warn(`[oh-my-openagent/v2] Ignoring invalid agent ${id}: ${parsed.error.message}`)
    }
  }
  // Reuse core model catalog expansion without passing OpenCode-only fields to its strict schema.
  const catalog = OmoModelCatalogSchema.safeParse(resolved.models)
  const modelInput = OmoConfigSchema.parse({ models: catalog.success ? catalog.data : loaded.config.models, agents: Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, {
    model: agent.model, models: agent.models, reasoning: agent.reasoning ?? agent.variant,
  }])) })
  const expanded = resolveModelReferences(modelInput)
  for (const diagnostic of expanded.diagnostics) console.warn(`[oh-my-openagent/v2] ${diagnostic.message}`)
  for (const [id, resolvedAgent] of Object.entries(expanded.view.agents ?? {})) {
    Object.assign(agents[id], resolvedAgent)
  }
  const disabled = z.array(z.string()).safeParse(resolved.disabled_agents)
  return { agents, disabled_agents: disabled.success ? disabled.data : [] }
}
