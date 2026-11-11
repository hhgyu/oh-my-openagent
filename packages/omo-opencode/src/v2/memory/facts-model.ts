// Native facts model selection (omo-senpi `facts-model.ts`) over the V2 public model catalog: facts may
// use only a user selection, never a built-in category chain or a registry ladder.
// 1. `memory.agents.<identity>.facts.model` else `memory.facts.model` (must be available);
// 2. else an explicit `categories.quick` declaration: its first available declared candidate, in
//    category order (`models`, `model`, `fallback_models`), the rest available as fallbacks;
//    `categories.quick.disable` with nothing configured refuses;
// 3. else the triggering root session's own model.
// "Available" means listed by the live catalog as an enabled chat model of a listed, non-disabled
// provider and not matched by `exclude_models` (the same eligibility as `host/model-profile.ts`).

import { isExcludedModel, type OmoConfig } from "@oh-my-opencode/omo-config-core"
import type { CatalogModel } from "../host/model-catalog"

export type FactsModelResolution =
  | { readonly kind: "resolved"; readonly model: string; readonly fallbacks: readonly string[] }
  | { readonly kind: "unavailable"; readonly cause: "no_catalog" | "not_found" | "model_unavailable" }

/** `provider/model` selectors the live catalog can run, after `exclude_models`. */
export function availableFactsModels(models: readonly CatalogModel[], config: Pick<OmoConfig, "exclude_models">): readonly string[] {
  return models
    .filter(model => model.type === "chat" && model.availability.enabled && model.availability.providerListed && model.availability.providerActivation !== "disabled")
    .map(model => `${model.providerID}/${model.id}`)
    .filter(selector => !isExcludedModel(selector, config.exclude_models))
}

type CategoryEntry = NonNullable<OmoConfig["categories"]>[string]

/** The `provider/model` candidates a user category declares, in category order (`models`, `model`, `fallback_models`). */
export function declaredCategoryModels(category: CategoryEntry | undefined): readonly string[] {
  if (category === undefined) return []
  const fallbacks = category.fallback_models === undefined ? [] : (Array.isArray(category.fallback_models) ? category.fallback_models : [category.fallback_models])
  return [...new Set([
    ...(category.models ?? []).map(entry => typeof entry === "string" ? entry : entry.model),
    ...(category.model === undefined ? [] : [category.model]),
    ...fallbacks.map(entry => typeof entry === "string" ? entry : entry.model),
  ])]
}

export function resolveFactsModel(
  config: Pick<OmoConfig, "memory" | "categories" | "exclude_models">,
  available: readonly string[] | undefined,
  sessionModel: string | undefined,
  identity: string,
): FactsModelResolution {
  const configured = config.memory?.agents?.[identity]?.facts?.model ?? config.memory?.facts?.model
  const quick = config.categories?.quick
  if (configured === undefined && quick?.disable === true) return { kind: "unavailable", cause: "not_found" }
  if (available === undefined) return { kind: "unavailable", cause: "no_catalog" }
  const usable = new Set(available)
  if (configured === undefined && quick !== undefined && (quick.model !== undefined || (quick.models?.length ?? 0) > 0)) {
    const candidates = declaredCategoryModels(quick).filter(model => usable.has(model))
    const [model, ...fallbacks] = candidates
    return model === undefined ? { kind: "unavailable", cause: "model_unavailable" } : { kind: "resolved", model, fallbacks }
  }
  const excludedSession = sessionModel !== undefined && isExcludedModel(sessionModel, config.exclude_models)
  const selector = configured ?? (excludedSession ? undefined : sessionModel)
  if (selector === undefined) return { kind: "unavailable", cause: "not_found" }
  return usable.has(selector) ? { kind: "resolved", model: selector, fallbacks: [] } : { kind: "unavailable", cause: "model_unavailable" }
}
