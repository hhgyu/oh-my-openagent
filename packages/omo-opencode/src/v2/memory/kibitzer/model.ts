// Which model answers for the resident Kibitzer (port of omo-senpi `kibitzer/sidecar-model.ts`). The
// child is pinned to `memory.recall.category` (default `quick`): an advisor reading a live transcript
// must never land on an arbitrary, possibly frontier-priced model, so the registry and parent-session
// rungs the reflection worker tolerates are refused and the category's own chain (user candidates
// plus the builtin category ladder, filtered to consented, catalog-available providers) is the only
// ladder. A retryable model failure retires a candidate for the sidecar's life; once every candidate
// is retired the whole ladder is offered again. When nothing resolves the wake is skipped: the child
// is never staged without a model, so the host default model never runs the judge.

import type { OmoConfig } from "@oh-my-opencode/omo-config-core"
import type { CatalogModel } from "../../host/model-catalog"
import type { BoundMemorySession } from "../binding"
import { resolveRecallSettings } from "../config"
import { resolveReflectionModel } from "../reflection-model"
import type { KibitzerChildModel, KibitzerModelPick } from "./contract"

export type KibitzerModelResolution =
  | { readonly kind: "resolved"; readonly category: string; readonly candidates: readonly KibitzerChildModel[] }
  | { readonly kind: "unavailable"; readonly category: string; readonly detail: string }

export function resolveKibitzerModel(
  category: string,
  config: OmoConfig,
  catalog: readonly CatalogModel[] | undefined,
  consented: ReadonlySet<string>,
): KibitzerModelResolution {
  const resolution = resolveReflectionModel(category, config, catalog, undefined, consented)
  if (resolution.kind === "unavailable") {
    const providers = resolution.missingProviders?.join(", ") ?? ""
    return {
      kind: "unavailable",
      category,
      detail: `Kibitzer recall category "${category}" could not resolve a usable model (cause: ${resolution.cause})${providers === "" ? "" : `; missing providers: ${providers}`}`,
    }
  }
  if (resolution.source !== undefined)
    return {
      kind: "unavailable",
      category,
      detail: `Kibitzer recall category "${category}" has no usable model; a model outside the category is refused`,
    }
  return {
    kind: "resolved",
    category: resolution.category,
    candidates: [
      { model: resolution.model, ...(resolution.variant === undefined ? {} : { variant: resolution.variant }) },
      ...(resolution.fallbacks ?? []),
    ],
  }
}

/** The first candidate no earlier wake retired; the whole ladder again once every candidate is retired. */
export function pickKibitzerModel(
  resolution: KibitzerModelResolution,
  retired: ReadonlySet<string>,
): KibitzerModelPick {
  if (resolution.kind === "unavailable") return resolution
  const open = resolution.candidates.find((candidate) => !retired.has(candidate.model))
  const model = open ?? resolution.candidates[0]
  return model === undefined
    ? { kind: "unavailable", category: resolution.category, detail: "Kibitzer recall category resolved no candidate" }
    : { kind: "resolved", model }
}

export interface KibitzerModelResolverDeps {
  readonly loadConfig: (cwd: string) => OmoConfig
  readonly catalog: (() => Promise<readonly CatalogModel[]>) | undefined
  readonly consentedProviders: () => Promise<ReadonlySet<string>>
}

/** Resolved per seed like Native: the category from the freshly loaded config, the catalog and provider consent live. */
export function createKibitzerModelResolver(
  deps: KibitzerModelResolverDeps,
): (bound: BoundMemorySession) => Promise<KibitzerModelResolution> {
  return async (bound) => {
    const config = deps.loadConfig(bound.directory)
    const category = resolveRecallSettings(config.memory ?? bound.settings, bound.identity).category
    try {
      const [catalog, consented] = await Promise.all([deps.catalog?.(), deps.consentedProviders()])
      return resolveKibitzerModel(category, config, catalog, consented)
    } catch (error) {
      return {
        kind: "unavailable",
        category,
        detail: `Kibitzer could not read the model catalog: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
}
