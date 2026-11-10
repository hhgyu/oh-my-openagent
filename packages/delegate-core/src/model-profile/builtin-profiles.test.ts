import { expect, it } from "bun:test"
import { FABLE_55_RELEASED } from "@oh-my-opencode/model-core"
import { BUILTIN_MODEL_PROFILES, DEFAULT_MODEL_PROFILE_ID, DEFAULT_MODEL_PROFILE_ORDER, RETIRED_MODEL_PROFILE_IDS } from "./builtin-profiles"
import { resolveModelProfile } from "./resolve"

it("preserves picker/default order and retired recommended without silently resolving it", () => {
  expect(Object.keys(BUILTIN_MODEL_PROFILES)).toEqual([...DEFAULT_MODEL_PROFILE_ORDER])
  expect(DEFAULT_MODEL_PROFILE_ID).toBe(DEFAULT_MODEL_PROFILE_ORDER[0])
  expect([...RETIRED_MODEL_PROFILE_IDS]).toEqual(["recommended"])
  expect(resolveModelProfile({ active: "recommended", availableModels: ["anthropic/claude-opus-5-5"] }).kind).toBe("unknown")
  expect(resolveModelProfile({ active: "recommended", profiles: { recommended: { models: ["openai/user-choice"] } }, availableModels: ["openai/user-choice"] })).toMatchObject({ kind: "resolved", profile: { source: "user" }, modelId: "user-choice" })
})

it("applies the shared launch gate before a provisional model can become a builtin selection", () => {
  const result = resolveModelProfile({ active: "daily-heavy", availableModels: ["anthropic-subscription/claude-fable-5-5", "anthropic-subscription/claude-fable-5-1"] })
  expect(result).toMatchObject({ kind: "resolved", modelId: FABLE_55_RELEASED ? "claude-fable-5-5" : "claude-fable-5-1", reasoning: "xhigh" })
  if (!FABLE_55_RELEASED) {
    expect(resolveModelProfile({ active: "daily-heavy", availableModels: ["anthropic-subscription/claude-fable-5-5"] }).kind).toBe("unavailable")
  }
})
