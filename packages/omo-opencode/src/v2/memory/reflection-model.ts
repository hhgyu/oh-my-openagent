// Native reflection selection over V2's public catalog. Every category, pin and fallback sees only
// consented providers or explicit user candidates. The parent model remains an explicit choice.

import { canonicalCategoryName, isExcludedModel, type OmoConfig } from "@oh-my-opencode/omo-config-core"
import {
  builtinCategoryChainCandidates,
  resolveCategory,
  withoutExcludedModels,
  type SenpiModelRegistryPort,
} from "@oh-my-opencode/senpi-task"
import type { CatalogModel } from "../host/model-catalog"
import { availableFactsModels, declaredCategoryModels } from "./facts-model"
import {
  reflectionCandidate,
  reflectionInputPrice,
  reflectionRegistryLadder,
  type ReflectionModelCandidate,
} from "./reflection-model-ladder"

export type ReflectionModelResolution =
  | ({
      readonly kind: "resolved"
      readonly category: string
      readonly fallbacks?: readonly ReflectionModelCandidate[]
      readonly source?: "registry_fallback" | "session_inherit"
    } & ReflectionModelCandidate)
  | {
      readonly kind: "unavailable"
      readonly category: string
      readonly cause: "no_registry" | "not_found" | "model_unavailable" | "unknown"
      readonly missingProviders?: readonly string[]
    }

type RegistryModel = { readonly provider: string; readonly id: string; readonly contextWindow: number }

function registryOver(
  models: readonly CatalogModel[],
  config: Pick<OmoConfig, "exclude_models">,
  eligible: (model: CatalogModel) => boolean,
): SenpiModelRegistryPort<RegistryModel> {
  const chat = models.filter((model) => model.type === "chat" && eligible(model))
  const entry = (model: CatalogModel): RegistryModel => ({
    provider: model.providerID,
    id: model.id,
    contextWindow: model.limit.context,
  })
  const available = new Set(availableFactsModels(chat, config))
  return withoutExcludedModels(
    {
      getAvailable: () => chat.filter((model) => available.has(`${model.providerID}/${model.id}`)).map(entry),
      find: (provider, id) => {
        const found = chat.find((model) => model.providerID === provider && model.id === id)
        return found === undefined ? undefined : entry(found)
      },
    },
    config.exclude_models,
  )
}

function beyondCategory(
  category: string,
  models: readonly CatalogModel[],
  session: string | undefined,
  catalog = models,
  sessionVariant?: string,
): ReflectionModelResolution | undefined {
  const candidates = reflectionRegistryLadder(models)
  const fresh = candidates[0]
  const price = (selector: string) =>
    reflectionInputPrice(catalog.find((model) => `${model.providerID}/${model.id}` === selector))
  const freshPrice = fresh === undefined ? undefined : price(fresh.model)
  const sessionPrice = session === undefined ? undefined : price(session)
  if (fresh !== undefined && !(sessionPrice !== undefined && freshPrice !== undefined && sessionPrice < freshPrice)) {
    return {
      kind: "resolved",
      category,
      ...fresh,
      source: "registry_fallback",
      ...(candidates.length < 2 ? {} : { fallbacks: candidates.slice(1) }),
    }
  }
  return session === undefined
    ? undefined
    : {
        kind: "resolved",
        category,
        ...reflectionCandidate(session, sessionVariant, catalog),
        source: "session_inherit",
      }
}

export function resolveReflectionModel(
  category: string,
  config: OmoConfig,
  catalog: readonly CatalogModel[] | undefined,
  sessionModel: string | undefined,
  consented: ReadonlySet<string>,
  sessionVariant?: string,
): ReflectionModelResolution {
  const session =
    sessionModel !== undefined && !isExcludedModel(sessionModel, config.exclude_models) ? sessionModel : undefined
  if (catalog === undefined)
    return beyondCategory(category, [], session) ?? { kind: "unavailable", category, cause: "no_registry" }
  // The same key `resolveCategory` reads: a user entry under the requested name, else the canonical name of a retired one.
  const key =
    config.categories !== undefined && Object.hasOwn(config.categories, category)
      ? category
      : canonicalCategoryName(category)
  const userCategory =
    config.categories !== undefined && Object.hasOwn(config.categories, key) ? config.categories[key] : undefined
  const declared = new Set(declaredCategoryModels(userCategory))
  const eligible = catalog.filter(
    (model) => consented.has(model.providerID) || declared.has(`${model.providerID}/${model.id}`),
  )
  const registry = registryOver(eligible, config, () => true)
  const resolution = resolveCategory(category, config, registry)
  function selected(model: string, thinking?: string): ReflectionModelResolution {
    const specFallbacks =
      resolution.kind === "resolved"
        ? (resolution.spec.fallback_models ?? []).map((entry) =>
            reflectionCandidate(
              `${entry.provider}/${entry.model_id}`,
              entry.reasoning_effort ?? entry.variant,
              eligible,
            ),
          )
        : []
    const configured = userCategory?.models?.length
      ? userCategory.models
      : [
          model,
          ...(typeof userCategory?.fallback_models === "string"
            ? [userCategory.fallback_models]
            : (userCategory?.fallback_models ?? [])),
        ]
    const index = configured.findIndex((entry) => (typeof entry === "string" ? entry : entry.model) === model)
    const ordered = index < 0 ? [] : [...configured.slice(index + 1), ...configured.slice(0, index)]
    const candidates = [
      ...specFallbacks,
      ...ordered.map((entry) =>
        reflectionCandidate(
          typeof entry === "string" ? entry : entry.model,
          typeof entry === "string" ? undefined : (entry.reasoning ?? entry.reasoningEffort ?? entry.variant),
          eligible,
        ),
      ),
      ...builtinCategoryChainCandidates(category, registry).map((entry) =>
        reflectionCandidate(entry.model, entry.variant, eligible),
      ),
    ]
    const seen = new Set([model])
    const fallbacks = candidates.filter((entry) => {
      const slash = entry.model.indexOf("/")
      if (
        seen.has(entry.model) ||
        registry.find(entry.model.slice(0, slash), entry.model.slice(slash + 1)) === undefined
      )
        return false
      seen.add(entry.model)
      return true
    })
    return {
      kind: "resolved",
      category: resolution.kind === "resolved" ? resolution.category : category,
      ...reflectionCandidate(model, thinking, eligible),
      ...(fallbacks.length === 0 ? {} : { fallbacks }),
    }
  }
  if (resolution.kind === "resolved")
    return selected(
      `${resolution.spec.provider}/${resolution.spec.modelId}`,
      resolution.spec.reasoning ?? resolution.spec.reasoningEffort ?? resolution.spec.variant,
    )
  const pinned = userCategory?.model
  const slash = typeof pinned === "string" ? pinned.indexOf("/") : -1
  if (resolution.kind === "model_unavailable" && typeof pinned === "string" && slash > 0) {
    if (registry.find(pinned.slice(0, slash), pinned.slice(slash + 1)) !== undefined)
      return selected(pinned, userCategory?.reasoning ?? userCategory?.reasoningEffort ?? userCategory?.variant)
  }
  if (resolution.kind !== "disabled") {
    const available = new Set(availableFactsModels(eligible, config))
    const fallback = beyondCategory(
      category,
      eligible.filter((model) => model.type === "chat" && available.has(`${model.providerID}/${model.id}`)),
      session,
      catalog,
      sessionVariant,
    )
    if (fallback !== undefined) return fallback
  }
  const missing = resolution.kind === "model_unavailable" ? resolution.missing_providers : undefined
  return {
    kind: "unavailable",
    category,
    cause: resolution.kind === "not_found" || resolution.kind === "model_unavailable" ? resolution.kind : "unknown",
    ...(missing === undefined ? {} : { missingProviders: missing }),
  }
}

/** Native `categoryUnavailableDetail` (omo-senpi `worker/runner.ts`). */
export function reflectionModelUnavailableDetail(
  resolution: Extract<ReflectionModelResolution, { kind: "unavailable" }>,
): string {
  const base = `Reflection category "${resolution.category}" could not resolve a usable model (cause: ${resolution.cause})`
  const providers = resolution.missingProviders?.join(", ")
  return providers === undefined || providers.length === 0 ? base : `${base}; missing providers: ${providers}`
}
