import { describe, expect, it } from "bun:test"
import { mergeModelProfiles, resolveModelProfile } from "./resolve"

describe("prepared Native main-profile selector", () => {
  it("selects each lane with its current effort and subscription provider ranking", () => {
    const availableModels = [
      "opencode/claude-opus-5-5", "anthropic/claude-opus-5-5", "anthropic-subscription/claude-opus-5-5",
      "opencode/claude-fable-5-2", "anthropic-subscription/claude-fable-5-2",
      "openai/gpt-6-astra", "chatgpt-subscription/gpt-6-astra",
    ]
    for (const [active, provider, modelId, reasoning] of [
      ["daily-normal", "anthropic-subscription", "claude-opus-5-5", "medium"],
      ["daily-heavy", "anthropic-subscription", "claude-fable-5-2", "xhigh"],
      ["geeky-normal", "chatgpt-subscription", "gpt-6-astra", "medium"],
      ["geeky-heavy", "chatgpt-subscription", "gpt-6-astra", "high"],
    ]) expect(resolveModelProfile({ active, availableModels })).toMatchObject({ kind: "resolved", provider, modelId, reasoning, skipped: [] })
  })

  it("walks missing builtin rungs and reports unavailable without guessing on empty availability", () => {
    expect(resolveModelProfile({ active: "daily-normal", availableModels: ["moonshotai/kimi-k3.1-pro"] })).toMatchObject({
      kind: "resolved", provider: "moonshotai", modelId: "kimi-k3.1-pro", reasoning: "max", skipped: ["anthropic-subscription/claude-opus-5-5"],
    })
    expect(resolveModelProfile({ active: "daily-normal", availableModels: [] })).toMatchObject({
      kind: "unavailable", chain: ["anthropic-subscription/claude-opus-5-5", "kimi-coding/kimi-k3.1-pro", "zai/glm-5.3"],
    })
  })

  it("replaces a builtin chain wholesale, keeping its lane metadata without mutating input", () => {
    const profiles = { "daily-normal": { display_name: "House" } }
    expect(resolveModelProfile({ active: "daily-normal", profiles, availableModels: ["anthropic/claude-opus-5-5"] })).toEqual({
      kind: "empty", profile: { id: "daily-normal", displayName: "House", source: "user", family: "daily", tier: "normal" },
    })
    expect(profiles).toEqual({ "daily-normal": { display_name: "House" } })
    expect(mergeModelProfiles({ custom: { models: ["openai/custom:low"] } }).custom.models).toEqual([{ providers: ["openai"], model: "custom", reasoning: "low" }])
  })

  it("keeps explicit scoped user rungs exact while bare user IDs can match an unlisted provider", () => {
    const availableModels = ["gateway/claude-opus-5-5", "openai/claude-opus-5-5-extra"]
    expect(resolveModelProfile({ active: "scoped", profiles: { scoped: { models: ["openai/claude-opus-5-5"] } }, availableModels }).kind).toBe("unavailable")
    expect(resolveModelProfile({ active: "bare", profiles: { bare: { models: ["claude-opus-5-5"] } }, availableModels: [availableModels[0]] })).toMatchObject({ kind: "resolved", provider: "gateway", modelId: "claude-opus-5-5" })
    expect(resolveModelProfile({ active: "daily-normal", availableModels: [availableModels[0]] }).kind).toBe("unavailable")
  })

  it("uses declared custom providers only for exact declared model IDs and after listed providers", () => {
    const customProviders = [{ provider: "proxy-b", modelIds: ["claude-opus-5-5"] }, { provider: "proxy-a", modelIds: ["claude-opus-5-5"] }]
    const input = { active: "daily-normal", customProviders, availableModels: ["proxy-a/claude-opus-5-5", "proxy-b/claude-opus-5-5"] }
    expect(resolveModelProfile(input)).toMatchObject({ kind: "resolved", provider: "proxy-b", modelId: "claude-opus-5-5" })
    expect(resolveModelProfile({ ...input, availableModels: [...input.availableModels, "anthropic/claude-opus-5-5"] })).toMatchObject({ kind: "resolved", provider: "anthropic" })
    expect(resolveModelProfile({ ...input, customProviders: [{ provider: "proxy-a", modelIds: ["other"] }] }).kind).toBe("unavailable")
    expect(resolveModelProfile({ ...input, availableModels: ["proxy-b/anthropic/claude-opus-5-5"] }).kind).toBe("unavailable")
  })

  it("preserves pins, suffix effort and explicit object reasoning precedence", () => {
    const pin = "openai/exact:high"
    expect(resolveModelProfile({ active: pin, availableModels: ["openai/exact", "anthropic/claude-opus-5-5"] })).toMatchObject({ kind: "resolved", profile: { id: pin, source: "pin" }, provider: "openai", modelId: "exact", reasoning: "high" })
    expect(resolveModelProfile({ active: pin, availableModels: [] })).toMatchObject({ kind: "unavailable", chain: [pin] })
    expect(resolveModelProfile({ active: "custom", profiles: { custom: { models: [{ model: "openai/exact:low", reasoning: "high" }] } }, availableModels: ["openai/exact"] })).toMatchObject({ kind: "resolved", reasoning: "high" })
  })

  it("rejects prototype-shaped unknown names but preserves an explicit own data profile", () => {
    for (const active of ["__proto__", "constructor", "toString", "capable", "deep-work", "simple-work", ""]) {
      expect(resolveModelProfile({ active, availableModels: [] })).toMatchObject({ kind: "unknown", name: active })
    }
    const profiles = JSON.parse('{"__proto__":{"models":["openai/exact"]}}')
    expect(resolveModelProfile({ active: "__proto__", profiles, availableModels: ["openai/exact"] })).toMatchObject({ kind: "resolved", provider: "openai", modelId: "exact" })
    expect(Object.getPrototypeOf(mergeModelProfiles(profiles))).toBe(Object.prototype)
    expect({}).not.toHaveProperty("models")
  })
})
