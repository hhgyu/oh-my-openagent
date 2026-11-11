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

const CATALOG = [catalogModel("acme", "large"), catalogModel("acme", "quick-model"), catalogModel("anthropic", "claude-haiku-4-5")]

describe("reflection model selection", () => {
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
    const resolution = resolveReflectionModel("writing", settings, [...CATALOG, disabled("acme", "pinned")], "acme/large", CONSENTED)
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
    expect(fresh).toEqual({ kind: "resolved", category: "custom", model: "acme/large-mini", source: "registry_fallback" })
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
    expect(resolution).toEqual({ kind: "resolved", category: "custom", model: "acme/large", source: "registry_fallback" })
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
    const declared = config({ categories: { quick: { models: ["gone/model"], fallback_models: ["opencode/mimo-v2.6-flash-free"] } } })
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
    const resolution = resolveReflectionModel("custom", settings, [BUILTIN_FREE], "opencode/mimo-v2.6-flash-free", new Set())
    // then
    expect(resolution).toEqual({ kind: "resolved", category: "custom", model: "opencode/mimo-v2.6-flash-free", source: "session_inherit" })
  })
})
