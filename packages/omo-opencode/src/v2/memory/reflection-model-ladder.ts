import type { CatalogModel } from "../host/model-catalog"

export interface ReflectionModelCandidate {
  readonly model: string
  readonly variant?: string
}

export function reflectionCandidate(model: string, thinking: string | undefined, catalog: readonly CatalogModel[]): ReflectionModelCandidate {
  const variants = catalog.find(entry => `${entry.providerID}/${entry.id}` === model)?.reasoning.variants ?? []
  const normalized = thinking === "none" ? "off" : thinking
  const variant = normalized === undefined || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(normalized) ? undefined
    : variants.includes(normalized) ? normalized : normalized === "off" && variants.includes("none") ? "none" : undefined
  return { model, ...(variant === undefined ? {} : { variant }) }
}

/** Native's 50k-token workload, with no cache replay from the parent. */
export function reflectionInputPrice(model: CatalogModel | undefined): number | undefined {
  const tiers = model?.cost
  const priced = tiers?.filter(price => price.tier === undefined || price.tier.size <= 50_000)
    .toSorted((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0]
  return priced?.input
}

/** Port of Native registry-fallback: three candidates, cheapest first, fast names only when unpriced. */
export function reflectionRegistryLadder(models: readonly CatalogModel[]): readonly ReflectionModelCandidate[] {
  const ranked = models.filter(model => !/embed|image|audio|tts|whisper|rerank|moderation/i.test(model.id) && model.limit.context >= 131_072)
    .map((model, order) => ({ model, order, price: reflectionInputPrice(model) }))
    .sort((a, b) => {
      if (a.price !== undefined && b.price !== undefined) return a.price - b.price || b.model.limit.context - a.model.limit.context || a.order - b.order
      if (a.price !== undefined) return -1
      if (b.price !== undefined) return 1
      const fast = (id: string) => /fast|flash|mini|lite|haiku|turbo|highspeed/i.test(id) ? 0 : 1
      return fast(a.model.id) - fast(b.model.id) || a.order - b.order
    })
  return ranked.slice(0, 3).map(({ model }) => ({ model: `${model.providerID}/${model.id}` }))
}
