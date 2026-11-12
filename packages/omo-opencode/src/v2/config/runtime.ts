import {
  loadOmoConfig,
  mergeOmoConfigRecords,
  resolveOmoConfigView,
  resolveModelReferences,
  OmoConfigSchema,
  OmoModelCatalogSchema,
  isUnsafeObjectKey,
  type LoadOmoConfigOptions,
  type LoadOmoConfigResult,
  type OmoModelReferenceDiagnostic,
  type OmoConfigDiagnostic,
  type OmoConfig,
} from "@oh-my-opencode/omo-config-core"
import { z } from "zod"
import { agentOverrideSchema, type AgentOverride, type AgentsConfig } from "./agent-overrides"

export type RuntimeConfigSnapshot = {
  /** Entire canonical common config; no Native builtin profile selection is implied. */
  readonly config: OmoConfig
  /** OpenCode-only compatibility fields, kept separate from the strict common schema. */
  readonly agents: AgentsConfig
  readonly profile?: string
  readonly sources: LoadOmoConfigResult["sources"]
  readonly layers: LoadOmoConfigResult["layers"]
  readonly diagnostics: readonly (OmoConfigDiagnostic | OmoModelReferenceDiagnostic)[]
}

export function loadRuntimeConfig(options: LoadOmoConfigOptions = {}): RuntimeConfigSnapshot {
  const loaded = loadOmoConfig({ ...options, harness: "opencode" })
  const expanded = resolveModelReferences(loaded.config)
  const diagnostics: (OmoConfigDiagnostic | OmoModelReferenceDiagnostic)[] = [
    ...loaded.diagnostics,
    ...expanded.diagnostics,
  ]
  // The loader's sanitized layers retain intentionally open [opencode] fields.
  const merged = loaded.layers.reduce<Record<string, unknown>>(
    (result, layer) => mergeOmoConfigRecords(result, layer.config),
    {},
  )
  const resolved = resolveOmoConfigView({ config: merged, harness: "opencode", profile: loaded.profile }).config
  const agents: Record<string, AgentOverride> = Object.create(null)
  if (typeof resolved.agents === "object" && resolved.agents !== null && !Array.isArray(resolved.agents)) {
    for (const [id, input] of Object.entries(resolved.agents)) {
      if (isUnsafeObjectKey(id)) continue
      const parsed = agentOverrideSchema.safeParse(input)
      if (parsed.success) agents[id] = parsed.data
      else
        diagnostics.push({
          kind: "validation",
          path: `agents.${id}`,
          message: "Invalid OpenCode agent override",
          issuePaths: parsed.error.issues.map((issue) => issue.path.join(".")),
        })
    }
  }
  // Preserve the existing host view's model/variant precedence without feeding
  // displayName or permission arrays through the strict canonical agent schema.
  const catalog = OmoModelCatalogSchema.safeParse(resolved.models)
  const modelInput = OmoConfigSchema.parse({
    models: catalog.success ? catalog.data : loaded.config.models,
    agents: Object.fromEntries(
      Object.entries(agents).map(([id, agent]) => [
        id,
        {
          model: agent.model,
          models: agent.models,
          reasoning: agent.reasoning ?? agent.variant,
        },
      ]),
    ),
  })
  const hostModels = resolveModelReferences(modelInput)
  diagnostics.push(
    ...hostModels.diagnostics.filter(
      (diagnostic) =>
        !diagnostics.some(
          (existing) =>
            existing.kind === diagnostic.kind &&
            existing.path === diagnostic.path &&
            existing.message === diagnostic.message,
        ),
    ),
  )
  for (const [id, model] of Object.entries(hostModels.view.agents ?? {})) Object.assign(agents[id], model)
  const disabled = z.array(z.string()).safeParse(resolved.disabled_agents)
  return {
    config: expanded.view,
    agents: { agents, disabled_agents: disabled.success ? disabled.data : [], nativeAgents: expanded.view.agents },
    ...(loaded.profile === undefined ? {} : { profile: loaded.profile }),
    sources: loaded.sources,
    layers: loaded.layers,
    diagnostics,
  }
}
