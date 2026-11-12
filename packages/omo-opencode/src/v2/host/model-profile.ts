import { isExcludedModel } from "@oh-my-opencode/omo-config-core"
import { resolveModelProfile, type ModelProfileResolution } from "@oh-my-opencode/delegate-core/model-profile/resolve"
import { resolveDefaultModelProfile } from "@oh-my-opencode/delegate-core/model-profile/default-profile"
import { RETIRED_MODEL_PROFILE_IDS } from "@oh-my-opencode/delegate-core/model-profile/builtin-profiles"
import type { DeclaredModelProvider } from "@oh-my-opencode/delegate-core/model-profile/types"
import type { RuntimeConfigSnapshot } from "../config/runtime"
import type { CatalogModel } from "./model-catalog"

export interface ModelProfileSelection {
  readonly resolution: ModelProfileResolution
  readonly mode: "explicit" | "default" | "retired-default"
  readonly configured?: string
  /** An exact public catalog reference. No Native reasoning→host variant guess is made. */
  readonly candidate?: { readonly providerID: string; readonly id: string; readonly hostVariants: readonly string[] }
  readonly binding: "catalog-listed" | "not-resolved" | "unlisted-selection"
  readonly eligibleSelectors: readonly string[]
  readonly configSources: RuntimeConfigSnapshot["sources"]
  readonly configProfile?: string
  readonly evidence: {
    readonly source: "native-selector+opencode-public-catalog"
    readonly authentication: "unknown"
    readonly automaticApplication: false
  }
}
export interface ModelProfileSelectorOptions {
  readonly config: () => RuntimeConfigSnapshot | Promise<RuntimeConfigSnapshot>
  readonly catalog: { list(): Promise<readonly CatalogModel[]> }
  /** Only genuine explicit provider/model declarations, not inferred provider metadata. */
  readonly declaredProviders?: () => readonly DeclaredModelProvider[] | Promise<readonly DeclaredModelProvider[]>
}

/** Native's pure selection and default walk, bound to current host evidence.
 * Auth refresh/admission and startup-origin policy remain separate required host ports. */
export function createModelProfileSelector(options: ModelProfileSelectorOptions) {
  return {
    async select(): Promise<ModelProfileSelection> {
      const [snapshot, models, declarations] = await Promise.all([
        options.config(),
        options.catalog.list(),
        options.declaredProviders?.() ?? [],
      ])
      const eligible = models.filter(
        (model) =>
          model.type === "chat" &&
          model.availability.enabled &&
          model.availability.providerListed &&
          model.availability.providerActivation !== "disabled" &&
          !isExcludedModel(`${model.providerID}/${model.id}`, snapshot.config.exclude_models),
      )
      const selectors = eligible.map((model) => `${model.providerID}/${model.id}`)
      const requested = snapshot.config.model_profile
      const configured = requested !== undefined && requested.trim().length > 0 ? requested : undefined
      const retired =
        configured !== undefined &&
        RETIRED_MODEL_PROFILE_IDS.has(configured) &&
        snapshot.config.model_profiles?.[configured] === undefined
      const explicit = retired ? undefined : configured
      const resolveFor = async (active: string) => ({
        resolution: resolveModelProfile({
          active,
          profiles: snapshot.config.model_profiles,
          availableModels: selectors,
          customProviders: declarations,
        }),
      })
      const { resolution } =
        explicit === undefined ? await resolveDefaultModelProfile(resolveFor) : await resolveFor(explicit)
      const selected =
        resolution.kind === "resolved"
          ? eligible.find((model) => model.providerID === resolution.provider && model.id === resolution.modelId)
          : undefined
      return {
        resolution,
        mode: retired ? "retired-default" : explicit === undefined ? "default" : "explicit",
        ...(configured === undefined ? {} : { configured }),
        ...(selected === undefined
          ? {}
          : {
              candidate: {
                providerID: selected.providerID,
                id: selected.id,
                hostVariants: [...selected.reasoning.variants],
              },
            }),
        binding: resolution.kind !== "resolved" ? "not-resolved" : selected ? "catalog-listed" : "unlisted-selection",
        eligibleSelectors: [...selectors],
        configSources: snapshot.sources,
        ...(snapshot.profile === undefined ? {} : { configProfile: snapshot.profile }),
        evidence: {
          source: "native-selector+opencode-public-catalog",
          authentication: "unknown",
          automaticApplication: false,
        },
      }
    },
  }
}
