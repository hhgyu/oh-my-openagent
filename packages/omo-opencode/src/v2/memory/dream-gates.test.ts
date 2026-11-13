import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { TranscriptJournal, type ReservedRun } from "@oh-my-opencode/memory-core"
import { OmoMemorySettingsSchema } from "@oh-my-opencode/omo-config-core"
import type { BoundMemorySession } from "./binding"
import { fireDream } from "./dream-fire"
import {
  evaluateDreamGates,
  resolveDreamTriggerSettings,
  type DreamTriggerSettings,
} from "@oh-my-opencode/memory-core/dream-gates"
import { reflectionStore } from "./reflection-run-store"
import { createBoundIdentity } from "./reflection.test-support"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const NOW = Date.parse("2026-11-12T00:00:00.000Z")
const settings: DreamTriggerSettings = {
  enabled: true,
  idleMinutes: 30,
  minHoursBetween: 24,
  shutdownLaunch: false,
  autoSelectMax: 5,
  autoSelectMaxChars: 150_000,
}

function setup() {
  const identity = createBoundIdentity()
  cleanups.push(identity.cleanup)
  const bound: BoundMemorySession = identity.bound
  const launched: ReservedRun[] = []
  let runs = 0
  const fire = (origin: "manual" | "idle" | "pressure", request = {}, overrides: Partial<DreamTriggerSettings> = {}) =>
    fireDream({
      bound,
      origin,
      request,
      settings: { ...settings, ...overrides },
      now: () => NOW,
      store: reflectionStore(bound, { createRunId: () => `dream-${++runs}`, now: () => new Date(NOW) }),
      launch: (run) => {
        launched.push(run)
      },
    })
  const journal = async (conversationId: string, bytes: number) => {
    await new TranscriptJournal({ journalDir: join(bound.paths.transcripts, conversationId) }).reconcile([
      { kind: "user", messageId: `${conversationId}-u`, text: "x".repeat(bytes) },
      { kind: "assistant", messageId: `${conversationId}-a`, textBlocks: ["done"], reasoningBlocks: [], toolCalls: [] },
    ])
  }
  const lastDream = (iso: string) => {
    mkdirSync(join(bound.paths.runtime, "dream"), { recursive: true })
    writeFileSync(join(bound.paths.runtime, "dream", "state.json"), JSON.stringify({ last_dream_at: iso }))
  }
  return { bound, launched, fire, journal, lastDream }
}

describe("dream gates", () => {
  test("#given each origin #when the gates are evaluated #then manual bypasses, disabled and spacing refuse, and only idle needs volume", async () => {
    // given
    const probe = (lastDreamAtMs: number | null, bytes: number) => ({
      nowMs: NOW,
      lastDreamAtMs: async () => lastDreamAtMs,
      unreflectedBytes: async () => bytes,
    })
    // when
    const results = await Promise.all([
      evaluateDreamGates("manual", { ...settings, enabled: false }, probe(NOW, 0)),
      evaluateDreamGates("idle", { ...settings, enabled: false }, probe(null, 99_999)),
      evaluateDreamGates("idle", settings, probe(NOW - 3_600_000, 99_999)),
      evaluateDreamGates("idle", settings, probe(null, 8192)),
      evaluateDreamGates("idle", settings, probe(NOW - 25 * 3_600_000, 8193)),
      evaluateDreamGates("pressure", settings, probe(null, 0)),
      evaluateDreamGates("pressure", settings, probe(NOW - 3_600_000, 0)),
    ])
    // then
    expect(results).toEqual([
      { allowed: true },
      { allowed: false, rejection: "disabled" },
      { allowed: false, rejection: "too_soon" },
      { allowed: false, rejection: "insufficient_volume" },
      { allowed: true },
      { allowed: true },
      { allowed: false, rejection: "too_soon" },
    ])
  })

  test("#given a per-identity dream override #when the settings resolve #then the override wins field by field", () => {
    // given
    const memory = OmoMemorySettingsSchema.parse({
      dream: { idle_minutes: 10 },
      agents: { "agent-one": { dream: { enabled: false } } },
    })
    // when
    const resolved = resolveDreamTriggerSettings(memory, "agent-one")
    // then
    expect(resolved).toMatchObject({ enabled: false, idleMinutes: 10, minHoursBetween: 24 })
  })
})

describe("dream fire", () => {
  test("#given unreflected journals over the volume floor #when an idle dream fires #then the scored selection is reserved and launched", async () => {
    // given
    const { fire, journal, launched } = setup()
    await journal("ses_a", 6000)
    await journal("ses_b", 6000)
    // when
    const outcome = await fire("idle")
    // then
    expect(outcome).toEqual({ fired: true, runId: "dream-1", status: "active" })
    expect(launched[0]?.request).toMatchObject({ trigger: "dream", origin: "idle" })
    expect([...(launched[0]?.request.conversationIds ?? [])].toSorted()).toEqual(["ses_a", "ses_b"])
  })

  test("#given too little volume or a recent dream #when an idle dream fires #then it is refused before any reservation", async () => {
    // given
    const small = setup()
    await small.journal("ses_a", 100)
    const recent = setup()
    await recent.journal("ses_a", 20_000)
    recent.lastDream(new Date(NOW - 3_600_000).toISOString())
    // when
    const outcomes = [await small.fire("idle"), await recent.fire("idle")]
    // then
    expect(outcomes).toEqual([
      { fired: false, rejection: "insufficient_volume" },
      { fired: false, rejection: "too_soon" },
    ])
    expect([...small.launched, ...recent.launched]).toEqual([])
  })

  test("#given no journals #when a pressure dream fires #then it reserves with no conversations; a manual dream refuses with no unreflected content", async () => {
    // given
    const { fire, launched } = setup()
    // when
    const pressure = await fire("pressure")
    const manual = await fire("manual", { conversationIds: ["ses_missing"], targetDoc: "system/persona.md" })
    // then
    expect(pressure).toEqual({ fired: true, runId: "dream-1", status: "active" })
    expect(launched[0]?.request).toMatchObject({ trigger: "dream", origin: "pressure", conversationIds: [] })
    expect(manual).toEqual({ fired: false, rejection: "no_unreflected_content" })
  })

  test("#given an active run #when a manual dream with a target fires #then it is queued pending and not launched", async () => {
    // given
    const { fire, journal, launched } = setup()
    await fire("pressure")
    await journal("ses_a", 100)
    // when
    const outcome = await fire("manual", { conversationIds: ["ses_a"], targetDoc: "reference/notes.md", focus: "tabs" })
    // then
    expect(outcome).toEqual({ fired: true, runId: "dream-2", status: "pending" })
    expect(launched).toHaveLength(1)
  })
})
