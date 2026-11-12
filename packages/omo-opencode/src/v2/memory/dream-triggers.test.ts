import { afterEach, describe, expect, test } from "bun:test"
import type { BoundMemorySession } from "./binding"
import type { DreamFireOutcome } from "./dream-fire"
import { createDreamTriggers } from "./dream-triggers"
import { createManualTimers } from "./kibitzer/test-support"
import { createBoundIdentity } from "./reflection.test-support"

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

const user = (id: string) => ({ type: "user", id, text: "hello" })
const answer = (id: string, completed = true) => ({ type: "assistant", id, content: [], time: completed ? { created: 1, completed: 2 } : { created: 1 } })

function setup(options: { readonly idleMinutes?: number; readonly active?: boolean; readonly owned?: boolean; readonly pressure?: boolean } = {}) {
  const identity = createBoundIdentity()
  cleanups.push(identity.cleanup)
  const bound: BoundMemorySession = identity.bound
  const timers = createManualTimers()
  const transcript: { messages: unknown[] } = { messages: [user("u1"), answer("a1")] }
  const requests: string[] = []
  const activity = { active: options.active !== false }
  const triggers = createDreamTriggers({
    resolve: async sessionID => (sessionID === bound.sessionID ? bound : undefined),
    session: { context: async () => structuredClone(transcript.messages) as never },
    request: async (_bound, origin): Promise<DreamFireOutcome> => { requests.push(origin); return { fired: true, runId: "run-1", status: "active" } },
    settings: () => ({ enabled: true, idleMinutes: options.idleMinutes ?? 30, minHoursBetween: 24, shutdownLaunch: false, autoSelectMax: 5, autoSelectMaxChars: 150_000 }),
    pressure: async () => options.pressure === true,
    hasUserActivity: () => activity.active,
    isOwnedSession: () => options.owned === true,
    logger: { warn: () => undefined },
    timers,
  })
  cleanups.push(() => { void triggers.close() })
  const idle = async () => { triggers.onIdle(bound.sessionID); await triggers.settled() }
  const fire = async () => { timers.fire(); await triggers.settled() }
  return { bound, timers, transcript, requests, activity, triggers, idle, fire }
}

describe("dream idle timer", () => {
  test("#given a bound root session with user input #when it goes idle and the timer fires while still idle #then one idle dream is requested", async () => {
    // given
    const { timers, requests, idle, fire } = setup({ idleMinutes: 30 })
    // when
    await idle()
    const armed = timers.pending()
    await fire()
    // then
    expect(armed).toBe(1)
    expect(requests).toEqual(["idle"])
  })

  test("#given an armed timer #when a prompt, a compaction or close arrives #then the timer is cleared and nothing is requested", async () => {
    for (const interrupt of ["prompt", "compaction", "close"] as const) {
      // given
      const { bound, timers, requests, triggers, idle, fire } = setup()
      await idle()
      // when
      if (interrupt === "prompt") triggers.onPrompt(bound.sessionID)
      if (interrupt === "compaction") triggers.onCompaction(bound.sessionID)
      if (interrupt === "close") await triggers.close()
      await fire()
      // then
      expect(timers.pending()).toBe(0)
      expect(requests).toEqual([])
    }
  })

  test("#given a timer that fires #when the session is no longer idle #then the fire is dropped", async () => {
    for (const messages of [[user("u1"), answer("a1"), user("u2")], [user("u1"), answer("a1", false)], []]) {
      // given
      const { transcript, requests, idle, fire } = setup()
      await idle()
      // when
      transcript.messages = messages
      await fire()
      // then
      expect(requests).toEqual([])
    }
  })

  test("#given idle_minutes 0, no user input or an owned session #when it goes idle #then no timer is armed", async () => {
    for (const options of [{ idleMinutes: 0 }, { active: false }, { owned: true }]) {
      // given
      const { timers, idle } = setup(options)
      // when
      await idle()
      // then
      expect(timers.pending()).toBe(0)
    }
  })
})

describe("dream pressure origin", () => {
  test("#given system-token pressure at bind and prior user input #when the session binds #then one pressure dream is requested", async () => {
    // given
    const { bound, requests, triggers } = setup({ pressure: true })
    // when
    triggers.onBound(bound)
    await triggers.settled()
    // then
    expect(requests).toEqual(["pressure"])
  })

  test("#given pressure at bind before any user input #when the first turn settles #then the deferred pressure dream is requested then", async () => {
    // given
    const { bound, requests, triggers, activity, idle } = setup({ pressure: true })
    activity.active = false
    triggers.onBound(bound)
    await triggers.settled()
    const beforeTurn = [...requests]
    // when
    activity.active = true
    await idle()
    await idle()
    // then
    expect(beforeTurn).toEqual([])
    expect(requests).toEqual(["pressure"])
  })

  test("#given no pressure at bind #when the session binds #then nothing is requested", async () => {
    // given
    const { bound, requests, triggers } = setup({ pressure: false })
    // when
    triggers.onBound(bound)
    await triggers.settled()
    // then
    expect(requests).toEqual([])
  })
})
