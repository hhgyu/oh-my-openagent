import { expect, it } from "bun:test"
import { BUILTIN_MODEL_PROFILES, DEFAULT_MODEL_PROFILE_ID, DEFAULT_MODEL_PROFILE_ORDER, RETIRED_MODEL_PROFILE_IDS } from "./builtin-profiles"
import { resolveModelProfile } from "./resolve"

it("preserves picker/default order and retired recommended without silently resolving it", () => {
  expect(Object.keys(BUILTIN_MODEL_PROFILES)).toEqual([...DEFAULT_MODEL_PROFILE_ORDER])
  expect(DEFAULT_MODEL_PROFILE_ID).toBe(DEFAULT_MODEL_PROFILE_ORDER[0])
  expect([...RETIRED_MODEL_PROFILE_IDS]).toEqual(["recommended"])
  expect(resolveModelProfile({ active: "recommended", availableModels: ["anthropic/claude-opus-5-5"] }).kind).toBe("unknown")
  expect(resolveModelProfile({ active: "recommended", profiles: { recommended: { models: ["openai/user-choice"] } }, availableModels: ["openai/user-choice"] })).toMatchObject({ kind: "resolved", profile: { source: "user" }, modelId: "user-choice" })
})

it("runs daily-heavy as the current Fable, then Fable 5.1, at xhigh", () => {
  expect(resolveModelProfile({ active: "daily-heavy", availableModels: ["anthropic-subscription/claude-fable-5-2", "anthropic-subscription/claude-fable-5-1"] })).toMatchObject({ kind: "resolved", modelId: "claude-fable-5-2", reasoning: "xhigh" })
  expect(resolveModelProfile({ active: "daily-heavy", availableModels: ["anthropic-subscription/claude-fable-5-1"] })).toMatchObject({ kind: "resolved", modelId: "claude-fable-5-1", reasoning: "xhigh" })
})
