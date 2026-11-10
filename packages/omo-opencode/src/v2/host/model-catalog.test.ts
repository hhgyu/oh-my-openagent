import { expect, it } from "bun:test"
import { createModelCatalog, type ModelCatalogDomains } from "./model-catalog"

type ModelOutput = Awaited<ReturnType<ModelCatalogDomains["model"]["list"]>>
type ProviderOutput = Awaited<ReturnType<ModelCatalogDomains["provider"]["list"]>>
function model(providerID: string): ModelOutput["data"][number] {
  return {
    id: "shared", modelID: "underlying", providerID, name: "Current", enabled: true, status: "active",
    capabilities: { tools: true, input: ["text", "image"], output: ["text"], temperature: false },
    variants: [{ id: "high", headers: { authorization: "SECRET_VARIANT" } }],
    limit: { context: 120000, input: 100000, output: 20000 }, time: { released: 0 }, cost: [],
    headers: { authorization: "SECRET_MODEL" }, body: { secret: "SECRET_BODY" },
  }
}

it("reads current actual provider/model domains lazily and returns only whitelisted metadata", async () => {
  let modelCalls = 0
  let providerCalls = 0
  const models: ModelOutput = { location: { directory: "/fixture" }, data: [model("custom"), model("__proto__"), model("missing")] }
  const providers: ProviderOutput = { location: { directory: "/fixture" }, data: [
    { id: "custom", name: "Custom", activation: "enabled", package: "fixture", headers: { authorization: "SECRET_PROVIDER" } },
    { id: "__proto__", name: "Safe Map", activation: "disabled", package: "fixture" },
  ] }
  const catalog = createModelCatalog({ model: { list: async () => { modelCalls++; return models } }, provider: { list: async () => { providerCalls++; return providers } } })
  expect([modelCalls, providerCalls]).toEqual([0, 0])
  const first = await catalog.list()
  expect([modelCalls, providerCalls]).toEqual([1, 1])
  expect(first.map((entry) => [entry.providerID, entry.id])).toEqual([["custom", "shared"], ["__proto__", "shared"], ["missing", "shared"]])
  expect(first[0]).toMatchObject({ modelID: "underlying", reasoning: { source: "opencode.model.variants", variants: ["high"] }, availability: { enabled: true, providerListed: true, providerActivation: "enabled", authentication: "unknown" } })
  expect(first[1].availability.providerActivation).toBe("disabled")
  expect(first[2].availability.providerListed).toBe(false)
  expect(first[2].availability).not.toHaveProperty("providerActivation")
  expect(JSON.stringify(first)).not.toContain("SECRET")
  models.data[0].enabled = false
  models.data[0].capabilities.input.push("audio")
  providers.data[0].activation = "disabled"
  const second = await catalog.list()
  expect(second[0].availability).toMatchObject({ enabled: false, providerActivation: "disabled" })
  expect(second[0].capabilities.input).toEqual(["text", "image", "audio"])
  expect(first[0].capabilities.input).toEqual(["text", "image"])
  expect(first[0].availability.enabled).toBe(true)
  expect([modelCalls, providerCalls]).toEqual([2, 2])
})

it("propagates host catalog failures instead of inventing provider or authentication availability", async () => {
  const catalog = createModelCatalog({ model: { list: async () => { throw new Error("host unavailable") } }, provider: { list: async () => ({ location: { directory: "/fixture" }, data: [] }) } })
  await expect(catalog.list()).rejects.toThrow("host unavailable")
})
