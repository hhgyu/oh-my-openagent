import { describe, expect, test } from "bun:test"
import { OmoConfigSchema } from "@oh-my-opencode/omo-config-core"
import { availableFactsModels, resolveFactsModel } from "./facts-model"
import { catalogModel } from "./facts.test-support"

function config(input: Record<string, unknown>) {
  return OmoConfigSchema.parse(input)
}

const AVAILABLE = ["openai/gpt-quick", "anthropic/haiku", "test/session"]

describe("facts model selection", () => {
  test("#given a per-identity facts model #then it wins over the global facts model, quick and the session model", () => {
    // given
    const settings = config({
      memory: { facts: { model: "openai/gpt-quick" }, agents: { me: { facts: { model: "anthropic/haiku" } } } },
      categories: { quick: { model: "openai/gpt-quick" } },
    })
    // when
    const resolution = resolveFactsModel(settings, AVAILABLE, "test/session", "me")
    // then
    expect(resolution).toEqual({ kind: "resolved", model: "anthropic/haiku", fallbacks: [] })
  })

  test("#given an explicit quick category #then its first available declared candidate is used and the rest are fallbacks", () => {
    // given
    const settings = config({
      categories: { quick: { models: ["missing/one", "anthropic/haiku"], model: "openai/gpt-quick" } },
    })
    // when
    const resolution = resolveFactsModel(settings, AVAILABLE, "test/session", "me")
    // then
    expect(resolution).toEqual({ kind: "resolved", model: "anthropic/haiku", fallbacks: ["openai/gpt-quick"] })
  })

  test("#given nothing configured #then the session model is inherited unless it is excluded or unavailable", () => {
    // given
    const plain = config({})
    const excluding = config({ exclude_models: ["test/session"] })
    // when
    const inherited = resolveFactsModel(plain, AVAILABLE, "test/session", "me")
    const excluded = resolveFactsModel(excluding, AVAILABLE, "test/session", "me")
    const unavailable = resolveFactsModel(plain, AVAILABLE, "gone/model", "me")
    // then
    expect(inherited).toEqual({ kind: "resolved", model: "test/session", fallbacks: [] })
    expect(excluded).toEqual({ kind: "unavailable", cause: "not_found" })
    expect(unavailable).toEqual({ kind: "unavailable", cause: "model_unavailable" })
  })

  test("#given quick is disabled and nothing configured #then facts refuse to launch", () => {
    // given
    const settings = config({ categories: { quick: { disable: true } } })
    // when
    const resolution = resolveFactsModel(settings, AVAILABLE, "test/session", "me")
    // then
    expect(resolution).toEqual({ kind: "unavailable", cause: "not_found" })
  })

  test("#given a catalog #then only enabled chat models of listed providers outside exclude_models are available", () => {
    // given
    const disabled = {
      ...catalogModel("test", "off"),
      availability: { ...catalogModel("test", "off").availability, enabled: false },
    }
    const models = [catalogModel("test", "on"), disabled, catalogModel("test", "excluded")]
    // when
    const available = availableFactsModels(models, { exclude_models: ["test/excluded"] })
    // then
    expect(available).toEqual(["test/on"])
  })
})
