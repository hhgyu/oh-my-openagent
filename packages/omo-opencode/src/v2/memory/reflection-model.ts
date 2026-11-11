// Native reflection model selection (omo-senpi `worker/resolve-model.ts` `resolveReflectionModel`) over the
// V2 public model catalog. The category is `memory.reflection.category` (per identity, default `quick`):
// 1. senpi-task `resolveCategory` over the catalog (user `categories.<name>` first, then the builtin chain);
// 2. a pinned `categories.<name>.model` the catalog lists is authoritative even when not enabled;
// 3. unless the category is disabled, the beyond-category ladder: the first ranked available model
//    (`registry-fallback.ts`), else the root session's own model (`model-cost.ts` picks "fresh" whenever
//    either side lacks pricing; the V2 catalog carries none);
// 4. otherwise unavailable: the run settles `failed`/`category_unavailable` without launching.
// Provider consent (privacy parity): Native's registry lists only providers the user holds credentials
// for, while the V2 catalog also lists host built-ins the user never set up (OpenCode's `opencode`
// provider with free models). Every rung therefore sees only models of a consented provider
// (`reflection-consent.ts`: configured or authenticated) plus the candidates the user wrote in
// `categories.<name>` (`model`, `models`, `fallback_models`), which stay eligible on any provider as the
// user's explicit choice. The builtin chain and the ladder never reach an unconsented provider. The
// root session's own model stays eligible for the session rung, as the user is already talking to it.
// `exclude_models` reaches every rung and the inherited session model. Not ported: thinking levels and
// fallback candidates, because the V2 child launches one model per run with no attempt chain.

import { canonicalCategoryName, isExcludedModel, type OmoConfig } from "@oh-my-opencode/omo-config-core"
import { resolveCategory, withoutExcludedModels, type SenpiModelRegistryPort } from "@oh-my-opencode/senpi-task"
import type { CatalogModel } from "../host/model-catalog"
import { availableFactsModels, declaredCategoryModels } from "./facts-model"

export type ReflectionModelResolution =
  | { readonly kind: "resolved"; readonly category: string; readonly model: string; readonly source?: "registry_fallback" | "session_inherit" }
  | {
    readonly kind: "unavailable"
    readonly category: string
    readonly cause: "no_registry" | "not_found" | "model_unavailable" | "unknown"
    readonly missingProviders?: readonly string[]
  }

type RegistryModel = { readonly provider: string; readonly id: string; readonly contextWindow: number }

const NON_CHAT_ID = /embed|image|audio|tts|whisper|rerank|moderation/i
const FAST_TIER_ID = /fast|flash|mini|lite|haiku|turbo|highspeed/i
const MIN_CONTEXT_WINDOW = 131_072

function registryOver(models: readonly CatalogModel[], config: Pick<OmoConfig, "exclude_models">, eligible: (model: CatalogModel) => boolean): SenpiModelRegistryPort<RegistryModel> {
  const chat = models.filter(model => model.type === "chat" && eligible(model))
  const entry = (model: CatalogModel): RegistryModel => ({ provider: model.providerID, id: model.id, contextWindow: model.limit.context })
  const available = new Set(availableFactsModels(chat, config))
  return withoutExcludedModels({
    getAvailable: () => chat.filter(model => available.has(`${model.providerID}/${model.id}`)).map(entry),
    find: (provider, id) => {
      const found = chat.find(model => model.providerID === provider && model.id === id)
      return found === undefined ? undefined : entry(found)
    },
  }, config.exclude_models)
}

/** Native `selectRegistryFallbackModels` without pricing: fast-tier names first, then catalog order. */
function freshCandidate(registry: SenpiModelRegistryPort<RegistryModel> | undefined): string | undefined {
  const available = registry?.getAvailable()
  if (!Array.isArray(available)) return undefined
  const ranked = (available as readonly RegistryModel[])
    .map((model, order) => ({ model, order, fast: FAST_TIER_ID.test(model.id) }))
    .filter(({ model }) => !NON_CHAT_ID.test(model.id) && model.contextWindow >= MIN_CONTEXT_WINDOW)
    .sort((left, right) => left.fast === right.fast ? left.order - right.order : (left.fast ? -1 : 1))
  const first = ranked[0]?.model
  return first === undefined ? undefined : `${first.provider}/${first.id}`
}

function beyondCategory(category: string, registry: SenpiModelRegistryPort<RegistryModel> | undefined, session: string | undefined): ReflectionModelResolution | undefined {
  const fresh = freshCandidate(registry)
  if (fresh !== undefined) return { kind: "resolved", category, model: fresh, source: "registry_fallback" }
  return session === undefined ? undefined : { kind: "resolved", category, model: session, source: "session_inherit" }
}

export function resolveReflectionModel(
  category: string,
  config: OmoConfig,
  catalog: readonly CatalogModel[] | undefined,
  sessionModel: string | undefined,
  consented: ReadonlySet<string>,
): ReflectionModelResolution {
  const session = sessionModel !== undefined && !isExcludedModel(sessionModel, config.exclude_models) ? sessionModel : undefined
  if (catalog === undefined) return beyondCategory(category, undefined, session) ?? { kind: "unavailable", category, cause: "no_registry" }
  // The same key `resolveCategory` reads: a user entry under the requested name, else the canonical name of a retired one.
  const key = config.categories !== undefined && Object.hasOwn(config.categories, category) ? category : canonicalCategoryName(category)
  const userCategory = config.categories !== undefined && Object.hasOwn(config.categories, key) ? config.categories[key] : undefined
  const declared = new Set(declaredCategoryModels(userCategory))
  const registry = registryOver(catalog, config, model => consented.has(model.providerID) || declared.has(`${model.providerID}/${model.id}`))
  const resolution = resolveCategory(category, config, registry)
  if (resolution.kind === "resolved") return { kind: "resolved", category: resolution.category, model: `${resolution.spec.provider}/${resolution.spec.modelId}` }
  const pinned = userCategory?.model
  const slash = typeof pinned === "string" ? pinned.indexOf("/") : -1
  if (resolution.kind === "model_unavailable" && typeof pinned === "string" && slash > 0) {
    if (registry.find(pinned.slice(0, slash), pinned.slice(slash + 1)) !== undefined) return { kind: "resolved", category, model: pinned }
  }
  if (resolution.kind !== "disabled") {
    const fallback = beyondCategory(category, registry, session)
    if (fallback !== undefined) return fallback
  }
  const missing = resolution.kind === "model_unavailable" ? resolution.missing_providers : undefined
  return {
    kind: "unavailable", category,
    cause: resolution.kind === "not_found" || resolution.kind === "model_unavailable" ? resolution.kind : "unknown",
    ...(missing === undefined ? {} : { missingProviders: missing }),
  }
}

/** Native `categoryUnavailableDetail` (omo-senpi `worker/runner.ts`). */
export function reflectionModelUnavailableDetail(resolution: Extract<ReflectionModelResolution, { kind: "unavailable" }>): string {
  const base = `Reflection category "${resolution.category}" could not resolve a usable model (cause: ${resolution.cause})`
  const providers = resolution.missingProviders?.join(", ")
  return providers === undefined || providers.length === 0 ? base : `${base}; missing providers: ${providers}`
}
