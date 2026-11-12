import { describe, expect, test } from "bun:test"
import { OmoConfigSchema } from "@oh-my-opencode/omo-config-core"
import type { CatalogModel } from "../host/model-catalog"
import { catalogModel } from "./facts.test-support"
import { resolveReflectionModel } from "./reflection-model"

function config(input: Record<string, unknown>) {
  return OmoConfigSchema.parse(input)
}

function disabled(providerID: string, id: string): CatalogModel {
  const model = catalogModel(providerID, id)
  return { ...model, availability: { ...model.availability, enabled: false } }
}

const CONSENTED: ReadonlySet<string> = new Set(["acme", "anthropic"])

const CATALOG = [
  catalogModel("acme", "large"),
  catalogModel("acme", "quick-model"),
  catalogModel("anthropic", "claude-haiku-4-5"),
]

describe("reflection model selection", () => {
  test("#given priced eligible models and a cheaper unconfigured provider #then the Native three-rung cost ladder excludes the unconfigured model", () => {
    const priced = (provider: string, id: string, input: number, context = 200_000) => ({
      ...catalogModel(provider, id),
      cost: [{ input, output: input, cache: { read: input, write: input } }],
      limit: { context, output: 8000 },
    })
    const catalog = [
      priced("stranger", "free-mini", 0),
      priced("acme", "expensive-mini", 10),
      priced("acme", "cheap", 1),
      priced("acme", "equal-larger", 1, 300_000),
      priced("acme", "middle", 2),
    ]
    const result = resolveReflectionModel("custom", config({}), catalog, undefined, new Set(["acme"]))
    expect(result).toMatchObject({
      model: "acme/equal-larger",
      source: "registry_fallback",
      fallbacks: [{ model: "acme/cheap" }, { model: "acme/middle" }],
    })
  })
  test("#given configured thinking levels and fallbacks #then supported host variants survive on each rung", () => {
    const catalog = ["primary", "backup"].map((id) => ({
      ...catalogModel("acme", id),
      reasoning: { source: "opencode.model.variants" as const, variants: ["high", "low"] },
    }))
    const settings = config({
      categories: {
        custom: {
          models: [
            { model: "acme/primary", reasoning: "high" },
            { model: "acme/backup", variant: "low" },
          ],
        },
      },
    })
    expect(resolveReflectionModel("custom", settings, catalog, undefined, CONSENTED)).toMatchObject({
      model: "acme/primary",
      variant: "high",
      fallbacks: [{ model: "acme/backup", variant: "low" }],
    })
  })
  test("#given an excluded fallback and an unsupported thinking level #then neither reaches the child selection", () => {
    const settings = config({
      categories: {
        custom: { models: [{ model: "acme/primary", reasoning: "high" }, "acme/excluded", "acme/backup"] },
      },
      exclude_models: ["acme/excluded"],
    })
    const catalog = ["primary", "excluded", "backup"].map((id) => catalogModel("acme", id))
    expect(resolveReflectionModel("custom", settings, catalog, undefined, CONSENTED)).toEqual({
      kind: "resolved",
      category: "custom",
      model: "acme/primary",
      fallbacks: [{ model: "acme/backup" }],
    })
  })
  test("#given a cheaper small parent outside the registry size floor #then its model and supported thinking variant are inherited", () => {
    const price = (input: number) => [{ input, output: 1, cache: { read: 0, write: 0 } }]
    const parent = {
      ...catalogModel("acme", "parent"),
      limit: { context: 64_000, output: 8000 },
      cost: price(0.1),
      reasoning: { source: "opencode.model.variants" as const, variants: ["high"] },
    }
    const fresh = { ...catalogModel("acme", "large"), cost: price(1) }
    const result = resolveReflectionModel("custom", config({}), [fresh, parent], "acme/parent", CONSENTED, "high")
    expect(result).toEqual({
      kind: "resolved",
      category: "custom",
      model: "acme/parent",
      variant: "high",
      source: "session_inherit",
    })
  })
  test("#given the quick category declares an available candidate #then that candidate is selected", () => {
    // given
    const settings = config({ categories: { quick: { models: ["missing/one", "acme/quick-model"] } } })
    // when
    const resolution = resolveReflectionModel("quick", settings, CATALOG, "acme/large", CONSENTED)
    // then
    expect(resolution).toMatchObject({ kind: "resolved", category: "quick", model: "acme/quick-model" })
    expect(resolution.kind === "resolved" ? resolution.source : "unresolved").toBeUndefined()
  })

  test("#given a pinned category model the catalog lists but has not enabled #then the pin wins as Native's authoritative pin", () => {
    // given
    const settings = config({ categories: { writing: { model: "acme/pinned" } } })
    // when
    const resolution = resolveReflectionModel(
      "writing",
      settings,
      [...CATALOG, disabled("acme", "pinned")],
      "acme/large",
      CONSENTED,
    )
    // then
    expect(resolution).toEqual({ kind: "resolved", category: "writing", model: "acme/pinned" })
  })

  test("#given nothing in the category chain is available #then the beyond-category ladder takes a ranked registry model, else the session model", () => {
    // given
    const settings = config({ categories: { custom: { model: "gone/model" } } })
    const ranked = [catalogModel("acme", "large"), catalogModel("acme", "large-mini")]
    // when
    const fresh = resolveReflectionModel("custom", settings, ranked, "acme/large", CONSENTED)
    const inherited = resolveReflectionModel("custom", settings, [], "acme/large", CONSENTED)
    // then
    expect(fresh).toEqual({
      kind: "resolved",
      category: "custom",
      model: "acme/large-mini",
      source: "registry_fallback",
      fallbacks: [{ model: "acme/large" }],
    })
    expect(inherited).toEqual({ kind: "resolved", category: "custom", model: "acme/large", source: "session_inherit" })
  })

  test("#given a disabled category #then no beyond-category model is used and the category is unavailable", () => {
    // given
    const settings = config({ categories: { quick: { disable: true } } })
    // when
    const resolution = resolveReflectionModel("quick", settings, CATALOG, "acme/large", CONSENTED)
    // then
    expect(resolution).toMatchObject({ kind: "unavailable", category: "quick" })
  })

  test("#given no usable model anywhere #then the category is unavailable, and an excluded session model is never inherited", () => {
    // given
    const settings = config({ categories: { custom: { model: "gone/model" } }, exclude_models: ["acme/large"] })
    // when
    const empty = resolveReflectionModel("custom", settings, [], "acme/large", CONSENTED)
    const noCatalog = resolveReflectionModel("custom", config({}), undefined, undefined, CONSENTED)
    // then
    expect(empty).toMatchObject({ kind: "unavailable", category: "custom", cause: "model_unavailable" })
    expect(noCatalog).toEqual({ kind: "unavailable", category: "custom", cause: "no_registry" })
  })
})

describe("reflection model provider consent", () => {
  const BUILTIN_FREE = catalogModel("opencode", "mimo-v2.6-flash-free")

  test("#given an unconfigured built-in provider whose model ranks higher #when the ladder runs #then the configured provider's model wins", () => {
    // given
    const settings = config({ categories: { custom: { model: "gone/model" } } })
    const catalog = [BUILTIN_FREE, catalogModel("acme", "large")]
    // when
    const resolution = resolveReflectionModel("custom", settings, catalog, undefined, new Set(["acme"]))
    // then
    expect(resolution).toEqual({
      kind: "resolved",
      category: "custom",
      model: "acme/large",
      source: "registry_fallback",
    })
  })

  test("#given only unconfigured built-in models and no session model #when reflection resolves #then the category is unavailable", () => {
    // given
    const settings = config({ categories: { custom: { model: "gone/model" } } })
    // when
    const resolution = resolveReflectionModel("custom", settings, [BUILTIN_FREE], undefined, new Set())
    // then
    expect(resolution).toMatchObject({ kind: "unavailable", category: "custom", cause: "model_unavailable" })
  })

  test("#given the builtin quick chain and no user quick entry #when the provider serving its model is not configured #then the chain does not reach it", () => {
    // given
    const catalog = [catalogModel("anthropic", "claude-haiku-5-5"), BUILTIN_FREE]
    // when
    const unconfigured = resolveReflectionModel("quick", config({}), catalog, undefined, new Set())
    const configured = resolveReflectionModel("quick", config({}), catalog, undefined, new Set(["anthropic"]))
    // then
    expect(unconfigured.kind).toBe("unavailable")
    expect(configured).toEqual({ kind: "resolved", category: "quick", model: "anthropic/claude-haiku-5-5" })
  })

  test("#given the user pins or declares a built-in provider model #when reflection resolves #then the explicit choice is honored", () => {
    // given
    const pinned = config({ categories: { quick: { model: "opencode/mimo-v2.6-flash-free" } } })
    const declared = config({
      categories: { quick: { models: ["gone/model"], fallback_models: ["opencode/mimo-v2.6-flash-free"] } },
    })
    // when
    const fromPin = resolveReflectionModel("quick", pinned, [BUILTIN_FREE], undefined, new Set())
    const fromDeclared = resolveReflectionModel("quick", declared, [BUILTIN_FREE], undefined, new Set())
    // then
    expect(fromPin).toEqual({ kind: "resolved", category: "quick", model: "opencode/mimo-v2.6-flash-free" })
    expect(fromDeclared).toMatchObject({ kind: "resolved", category: "quick", model: "opencode/mimo-v2.6-flash-free" })
  })

  test("#given the root session runs on an unconfigured built-in provider #when nothing else resolves #then the session model is still inherited", () => {
    // given
    const settings = config({ categories: { custom: { model: "gone/model" } } })
    // when
    const resolution = resolveReflectionModel(
      "custom",
      settings,
      [BUILTIN_FREE],
      "opencode/mimo-v2.6-flash-free",
      new Set(),
    )
    // then
    expect(resolution).toEqual({
      kind: "resolved",
      category: "custom",
      model: "opencode/mimo-v2.6-flash-free",
      source: "session_inherit",
    })
  })
})
