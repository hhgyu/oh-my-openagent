import { expect, test } from "bun:test"
import { OmoConfigSchema } from "@oh-my-opencode/omo-config-core"
import { BUILTIN_MODEL_PROFILES } from "@oh-my-opencode/delegate-core/model-profile/builtin-profiles"
import { createModelProfileSelector } from "./model-profile"
import type { RuntimeConfigSnapshot } from "../config/runtime"
import type { CatalogModel } from "./model-catalog"

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}
const snapshot = (value: unknown): RuntimeConfigSnapshot => ({
  config: OmoConfigSchema.parse(value),
  agents: { agents: {}, disabled_agents: [] },
  sources: [],
  layers: [],
  diagnostics: [],
})
function model(providerID: string, id: string, patch: Partial<CatalogModel> = {}): CatalogModel {
  return {
    providerID,
    id,
    modelID: "DIFFERENT_REMOTE_ID",
    name: id,
    type: "chat",
    status: "active",
    reasoning: { source: "opencode.model.variants", variants: ["high"] },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 32000, output: 1000 },
    availability: {
      source: "opencode.model.list+provider.list",
      listed: true,
      enabled: true,
      providerListed: true,
      providerActivation: "enabled",
      authentication: "unknown",
    },
    ...patch,
  }
}
test("uses exact user profile and public ref without inventing auth or a Native reasoning variant", async () => {
  const select = createModelProfileSelector({
    config: () =>
      snapshot({
        model_profile: "custom",
        model_profiles: { custom: { models: [{ model: "qa/second", reasoning: "high" }] } },
      }),
    catalog: { list: async () => [model("qa", "first"), model("qa", "second")] },
  })
  const result = await select.select()
  expect(result.resolution).toMatchObject({ kind: "resolved", provider: "qa", modelId: "second", reasoning: "high" })
  expect(result.candidate).toEqual({ providerID: "qa", id: "second", hostVariants: ["high"] })
  expect(result.evidence).toMatchObject({ authentication: "unknown", automaticApplication: false })
  expect(result.candidate).not.toHaveProperty("variant")
})
test("default walk reaches the actual Native geeky lane after both daily lanes fail", async () => {
  const rung = defined(BUILTIN_MODEL_PROFILES["geeky-normal"].models[0])
  const select = createModelProfileSelector({
    config: () => snapshot({}),
    catalog: { list: async () => [model("openai", rung.model)] },
  })
  expect((await select.select()).resolution).toMatchObject({
    kind: "resolved",
    profile: { id: "geeky-normal" },
    provider: "openai",
  })
})
test("exclude_models wins even over an explicit literal pin", async () => {
  const select = createModelProfileSelector({
    config: () => snapshot({ model_profile: "qa/second", exclude_models: ["second"] }),
    catalog: { list: async () => [model("qa", "second")] },
  })
  const result = await select.select()
  expect(result.resolution.kind).toBe("unavailable")
  expect(result.candidate).toBeUndefined()
  expect(result.eligibleSelectors).toEqual([])
})
test("disabled, unlisted-provider and nonchat catalog entries cannot become candidates", async () => {
  const good = model("qa", "model")
  const entries = [
    { ...good, availability: { ...good.availability, enabled: false } },
    { ...good, availability: { ...good.availability, providerActivation: "disabled" as const } },
    { ...good, availability: { ...good.availability, providerListed: false } },
    model("qa", "model", { type: "embedding" }),
  ]
  for (const item of entries) {
    const select = createModelProfileSelector({
      config: () => snapshot({ model_profile: "qa/model" }),
      catalog: { list: async () => [item] },
    })
    expect((await select.select()).candidate).toBeUndefined()
  }
})
test("retired recommended defaults only when no user profile of that name exists", async () => {
  const rung = defined(BUILTIN_MODEL_PROFILES["geeky-normal"].models[0]),
    catalog = { list: async () => [model("openai", rung.model), model("qa", "model")] }
  const retired = await createModelProfileSelector({
    config: () => snapshot({ model_profile: "recommended" }),
    catalog,
  }).select()
  expect(retired.mode).toBe("retired-default")
  expect(retired.resolution).toMatchObject({ profile: { id: "geeky-normal" } })
  const own = await createModelProfileSelector({
    config: () => snapshot({ model_profile: "recommended", model_profiles: { recommended: { models: ["qa/model"] } } }),
    catalog,
  }).select()
  expect(own.mode).toBe("explicit")
  expect(own.resolution).toMatchObject({ kind: "resolved", profile: { id: "recommended", source: "user" } })
})
test("cold catalog never guesses and later calls re-read config and model evidence", async () => {
  let reads = 0,
    available: CatalogModel[] = []
  const select = createModelProfileSelector({
    config: () => {
      reads++
      return snapshot({ model_profile: "qa/model" })
    },
    catalog: { list: async () => available },
  })
  expect((await select.select()).resolution.kind).toBe("unavailable")
  available = [model("qa", "model")]
  expect((await select.select()).candidate?.id).toBe("model")
  expect(reads).toBe(2)
})
test("provider listing alone is not an explicit custom provider declaration", async () => {
  const rung = defined(BUILTIN_MODEL_PROFILES["daily-normal"].models[0]),
    catalog = { list: async () => [model("gateway", rung.model)] },
    config = () => snapshot({ model_profile: "daily-normal" })
  expect((await createModelProfileSelector({ config, catalog }).select()).resolution.kind).toBe("unavailable")
  expect(
    (
      await createModelProfileSelector({
        config,
        catalog,
        declaredProviders: () => [{ provider: "gateway", modelIds: [rung.model] }],
      }).select()
    ).resolution,
  ).toMatchObject({ kind: "resolved", provider: "gateway", modelId: rung.model })
})
test("label-only user override stays empty rather than inheriting builtin models", async () => {
  const rung = defined(BUILTIN_MODEL_PROFILES["daily-normal"].models[0])
  const result = await createModelProfileSelector({
    config: () =>
      snapshot({ model_profile: "daily-normal", model_profiles: { "daily-normal": { display_name: "Only a label" } } }),
    catalog: { list: async () => [model("anthropic", rung.model)] },
  }).select()
  expect(result.resolution.kind).toBe("empty")
  expect(result.candidate).toBeUndefined()
})

test("preserves Native retirement check ordering before selector whitespace normalization", async () => {
  const rung = defined(BUILTIN_MODEL_PROFILES["geeky-normal"].models[0])
  const result = await createModelProfileSelector({
    config: () => snapshot({ model_profile: " recommended " }),
    catalog: { list: async () => [model("openai", rung.model)] },
  }).select()
  expect(result.mode).toBe("explicit")
  expect(result.configured).toBe(" recommended ")
  expect(result.resolution.kind).toBe("unknown")
})

test("host evidence failures retain identity rather than selecting a guessed default", async () => {
  const error = Error("catalog unavailable")
  const select = createModelProfileSelector({
    config: () => snapshot({}),
    catalog: {
      list: async () => {
        throw error
      },
    },
  })
  expect(await select.select().catch((reason) => reason)).toBe(error)
})
