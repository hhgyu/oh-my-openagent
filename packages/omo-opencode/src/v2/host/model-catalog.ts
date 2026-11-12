import type { ModelDomain } from "@opencode/plugin/promise/model"
import type { ProviderDomain } from "@opencode/plugin/promise/provider"

export type ModelCatalogDomains = {
  readonly model: Pick<ModelDomain, "list">
  readonly provider: Pick<ProviderDomain, "list">
}

export type CatalogModel = {
  readonly providerID: string
  readonly id: string
  readonly modelID: string
  readonly name: string
  readonly type: string
  readonly status: string
  /** These are host variant IDs, not a fabricated Native reasoning level. */
  readonly reasoning: { readonly source: "opencode.model.variants"; readonly variants: readonly string[] }
  readonly capabilities: {
    readonly tools: boolean
    readonly input: readonly string[]
    readonly output: readonly string[]
    readonly temperature?: boolean
  }
  readonly limit: { readonly context: number; readonly input?: number; readonly output: number }
  /** Public USD-per-million price tiers only, never provider settings or headers. */
  readonly cost?: readonly {
    readonly tier?: { readonly type: "context"; readonly size: number }
    readonly input: number
    readonly output: number
    readonly cache: { readonly read: number; readonly write: number }
  }[]
  readonly availability: {
    readonly source: "opencode.model.list+provider.list"
    readonly listed: true
    readonly enabled: boolean
    readonly providerListed: boolean
    readonly providerActivation?: "auto" | "enabled" | "disabled"
    /** Neither public domain exposes an authentication verification result. */
    readonly authentication: "unknown"
  }
}

/** Creating this view performs no I/O; every read asks the live host again. */
export function createModelCatalog(domains: ModelCatalogDomains) {
  return {
    async list(): Promise<readonly CatalogModel[]> {
      const [models, providers] = await Promise.all([domains.model.list(), domains.provider.list()])
      const byID = new Map(providers.data.map((provider) => [provider.id, provider]))
      return models.data.map((model) => {
        const provider = byID.get(model.providerID)
        return {
          providerID: model.providerID,
          id: model.id,
          modelID: model.modelID,
          name: model.name,
          type: model.type ?? "chat",
          status: model.status,
          reasoning: { source: "opencode.model.variants", variants: model.variants.map((variant) => variant.id) },
          capabilities: {
            tools: model.capabilities.tools,
            input: [...model.capabilities.input],
            output: [...model.capabilities.output],
            ...(model.capabilities.temperature === undefined ? {} : { temperature: model.capabilities.temperature }),
          },
          limit: {
            context: model.limit.context,
            output: model.limit.output,
            ...(model.limit.input === undefined ? {} : { input: model.limit.input }),
          },
          cost: (model.cost ?? []).map((price) => ({
            ...(price.tier === undefined ? {} : { tier: { type: price.tier.type, size: price.tier.size } }),
            input: price.input,
            output: price.output,
            cache: { read: price.cache.read, write: price.cache.write },
          })),
          availability: {
            source: "opencode.model.list+provider.list",
            listed: true,
            enabled: model.enabled,
            providerListed: provider !== undefined,
            ...(provider === undefined ? {} : { providerActivation: provider.activation }),
            authentication: "unknown",
          },
        }
      })
    },
  }
}
