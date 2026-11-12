import { expect, it } from "bun:test"
import { resolveDefaultModelProfile } from "./default-profile"
import { resolveModelProfile, type ModelProfileResolution } from "./resolve"

function outcome(id: string, kind: "resolved" | "empty" | "unavailable" | "unknown") {
  const profile = { id, displayName: id, source: "user" as const }
  let resolution: ModelProfileResolution
  if (kind === "resolved") resolution = { kind, profile, provider: "test", modelId: id, skipped: [] }
  else if (kind === "unknown") resolution = { kind, name: id, known: [], message: "unknown profile" }
  else if (kind === "unavailable") resolution = { kind, profile, chain: [] }
  else resolution = { kind, profile }
  return { resolution, custody: new Set([id]) }
}

it("stops at the first resolved lane in default order and retains the exact caller-owned outcome", async () => {
  for (const winner of ["daily-normal", "daily-heavy", "geeky-normal", "geeky-heavy"]) {
    const calls: string[] = [],
      selected = outcome(winner, "resolved")
    const result = await resolveDefaultModelProfile(async (id) => {
      calls.push(id)
      return id === winner ? selected : outcome(id, "unavailable")
    })
    expect(result).toBe(selected)
    expect(calls).toEqual(
      ["daily-normal", "daily-heavy", "geeky-normal", "geeky-heavy"].slice(0, calls.indexOf(winner) + 1),
    )
    expect(calls.at(-1)).toBe(winner)
  }
})

it("walks unknown and empty outcomes but returns the first exact outcome when every lane fails", async () => {
  const first = outcome("daily-normal", "empty"),
    calls: string[] = []
  const result = await resolveDefaultModelProfile(async (id) => {
    calls.push(id)
    return id === "daily-normal" ? first : outcome(id, id === "daily-heavy" ? "unknown" : "unavailable")
  })
  expect(calls).toEqual(["daily-normal", "daily-heavy", "geeky-normal", "geeky-heavy"])
  expect(result).toBe(first)
  expect(result.custody).toBe(first.custody)
})

it("preserves sequential callback authority and does not probe another lane before the current promise settles", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: string[] = [],
    selected = outcome("daily-heavy", "resolved")
  const pending = resolveDefaultModelProfile(async (id) => {
    calls.push(id)
    if (id === "daily-normal") {
      await gate
      return outcome(id, "unavailable")
    }
    return selected
  })
  expect(calls).toEqual(["daily-normal"])
  release()
  expect(await pending).toBe(selected)
  expect(calls).toEqual(["daily-normal", "daily-heavy"])
})

it("propagates the same resolver rejection without attempting or substituting a later lane", async () => {
  const denied = new Error("AUTHORITY_DENIED"),
    calls: string[] = []
  await expect(
    resolveDefaultModelProfile(async (id) => {
      calls.push(id)
      if (id === "daily-heavy") throw denied
      return outcome(id, "unavailable")
    }),
  ).rejects.toBe(denied)
  expect(calls).toEqual(["daily-normal", "daily-heavy"])
})

it("uses the shared selector's actual availability rather than treating missing models as a resolved default", async () => {
  const calls: string[] = []
  const result = await resolveDefaultModelProfile(async (active) => {
    calls.push(active)
    return { resolution: resolveModelProfile({ active, availableModels: ["openai/gpt-6-astra"] }) }
  })
  expect(calls).toEqual(["daily-normal", "daily-heavy", "geeky-normal"])
  expect(result.resolution).toMatchObject({
    kind: "resolved",
    provider: "openai",
    modelId: "gpt-6-astra",
    reasoning: "medium",
  })
})
