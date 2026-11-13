import { describe, expect, test } from "bun:test"
import { OmoConfigSchema } from "@oh-my-opencode/omo-config-core"
import { catalogModel } from "../facts.test-support"
import { resolveKibitzerModel } from "./model"

const config = (input: Record<string, unknown>) => OmoConfigSchema.parse(input)

describe("kibitzer recall model selection", () => {
  test("#given a quick category chain whose primary has no consented provider #then the first available category candidate leads and the rest of the category chain follows", () => {
    // given
    const settings = config({
      categories: { quick: { models: ["stranger/first", "acme/second", "acme/third"] } },
    })
    const catalog = [catalogModel("acme", "second"), catalogModel("acme", "third"), catalogModel("acme", "large")]
    // when
    const resolution = resolveKibitzerModel("quick", settings, catalog, new Set(["acme"]))
    // then
    expect(resolution.kind).toBe("resolved")
    if (resolution.kind !== "resolved") return
    expect(resolution.candidates[0]).toEqual({ model: "acme/second" })
    expect(resolution.candidates.map((candidate) => candidate.model)).toContain("acme/third")
    expect(resolution.candidates.map((candidate) => candidate.model)).not.toContain("acme/large")
  })

  test("#given a category whose chain resolves nothing while other consented models exist #then the registry rung beyond the category is refused", () => {
    // given
    const settings = config({ categories: { custom: { model: "stranger/only" } } })
    const catalog = [catalogModel("acme", "large")]
    // when
    const resolution = resolveKibitzerModel("custom", settings, catalog, new Set(["acme"]))
    // then
    expect(resolution).toMatchObject({ kind: "unavailable", category: "custom" })
  })

  test("#given no model catalog #then nothing resolves", () => {
    // given
    const settings = config({ categories: { quick: { model: "acme/quick" } } })
    // when
    const resolution = resolveKibitzerModel("quick", settings, undefined, new Set(["acme"]))
    // then
    expect(resolution).toMatchObject({ kind: "unavailable", category: "quick" })
  })
})
