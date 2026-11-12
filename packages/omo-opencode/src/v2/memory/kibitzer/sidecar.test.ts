import { describe, expect, test } from "bun:test"
import type { RecallCandidate, RecallNudge } from "@oh-my-opencode/memory-core"
import type { KibitzerWakeOutcome } from "./outcome"
import { createKibitzerSidecar, type KibitzerSidecar } from "./sidecar"
import {
  createCountingSlot,
  createManualTimers,
  createScriptedPort,
  deferred,
  flush,
  type CountingSlot,
  type ManualTimers,
  type ScriptedPort,
} from "./test-support"

const candidate = (path: string): RecallCandidate => ({
  path,
  description: `note ${path}`,
  excerpt: `body of ${path}`,
  score: 1,
})

interface Harness {
  readonly sidecar: KibitzerSidecar
  readonly port: ScriptedPort
  readonly slot: CountingSlot
  readonly timers: ManualTimers
  readonly delivered: RecallNudge[][]
  readonly outcomes: KibitzerWakeOutcome[]
  nextOutcome(): Promise<KibitzerWakeOutcome>
}

function harness(overrides: { toolBudget?: number } = {}): Harness {
  const port = createScriptedPort()
  const slot = createCountingSlot()
  const timers = createManualTimers()
  const delivered: RecallNudge[][] = []
  const outcomes: KibitzerWakeOutcome[] = []
  let waiter: ((outcome: KibitzerWakeOutcome) => void) | undefined
  const sidecar = createKibitzerSidecar({
    sessionId: "root",
    port,
    wakeSlot: slot,
    timers,
    random: () => 0.5,
    toolBudget: overrides.toolBudget ?? 8,
    deliver: async (nudges) => {
      delivered.push([...nudges])
    },
    onWake: (outcome) => {
      outcomes.push(outcome)
      waiter?.(outcome)
      waiter = undefined
    },
  })
  return {
    sidecar,
    port,
    slot,
    timers,
    delivered,
    outcomes,
    nextOutcome: () =>
      new Promise((resolve) => {
        waiter = resolve
      }),
  }
}

const offer = (h: Harness, paths: string[], surfaced: string[] = []) =>
  h.sidecar.offer({ candidates: paths.map(candidate), surfaced: new Set(surfaced), maxItems: 3 })

describe("kibitzer sidecar lifecycle", () => {
  test("#given one main session #when wakes arrive while running and after settling #then one child is steered then followed up", async () => {
    // given
    const h = harness()
    h.sidecar.events.onPrompt("deploy the service")
    // when
    const first = await offer(h, ["reference/a.md"])
    const second = await offer(h, ["reference/b.md"])
    const settled = h.nextOutcome()
    h.port.children[0]?.finish()
    await settled
    const third = await offer(h, ["reference/c.md"])
    // then
    expect([first.action, second.action, third.action]).toEqual(["seeded", "steered", "followed_up"])
    expect(h.port.children).toHaveLength(1)
    expect(h.port.children[0]?.prompts[0]).toContain("<kibitzer-seed")
    expect(h.port.children[0]?.prompts[0]).toContain("reference/a.md")
    expect(h.port.children[0]?.steers[0]).toContain("reference/b.md")
    expect(h.port.children[0]?.followUps[0]).toContain("reference/c.md")
    await h.sidecar.shutdown()
  })

  test("#given judged or surfaced or system candidates #then the sidecar buffers without a model turn", async () => {
    // given
    const h = harness()
    await offer(h, ["reference/a.md"])
    const settled = h.nextOutcome()
    h.port.children[0]?.finish()
    await settled
    // when
    const repeat = await offer(h, ["reference/a.md"])
    const surfaced = await offer(h, ["reference/b.md"], ["reference/b.md"])
    const system = await offer(h, ["system/persona.md"])
    const empty = await offer(h, [])
    // then
    expect([repeat, surfaced, system, empty]).toEqual([
      { action: "buffered", reason: "no_new_candidate" },
      { action: "buffered", reason: "no_new_candidate" },
      { action: "buffered", reason: "no_new_candidate" },
      { action: "buffered", reason: "no_candidates" },
    ])
    expect(h.port.children[0]?.followUps).toEqual([])
    expect(h.slot.acquired).toBe(1)
    await h.sidecar.shutdown()
  })

  test("#given a tool budget of 2 #when the child starts a third call #then the turn is aborted as tool_budget_exceeded and the lease returns", async () => {
    // given
    const h = harness({ toolBudget: 2 })
    await offer(h, ["reference/a.md"])
    const child = h.port.children[0]
    const binding = h.sidecar.toolBinding(child?.sessionID ?? "")
    // when
    const settled = h.nextOutcome()
    for (const id of ["t1", "t2", "t3"]) h.sidecar.observeChildTool(child?.sessionID ?? "", "start", id)
    const outcome = await settled
    // then
    expect(child?.aborts).toBe(1)
    expect(binding?.charge("t1")).toBe(true)
    expect(binding?.charge("t3")).toBe(false)
    expect(outcome).toMatchObject({ status: "tool_budget_exceeded", toolCalls: 3, diagnostic: false })
    expect([h.slot.live, h.slot.released]).toEqual([0, 1])
    await h.sidecar.shutdown()
  })

  test("#given an accepted nudge #when the wake deadline fires #then the turn aborts as deadline and the nudge is still delivered once", async () => {
    // given
    const h = harness()
    await offer(h, ["reference/a.md", "reference/b.md"])
    const child = h.port.children[0]
    const binding = h.sidecar.toolBinding(child?.sessionID ?? "")
    binding?.accepted.push({ path: "reference/a.md", hint: "The note records that rollouts go through staging first." })
    binding?.accepted.push({ path: "reference/zzz.md", hint: "The note records an unoffered fact." })
    // when
    const settled = h.nextOutcome()
    h.timers.fire(90_000)
    const outcome = await settled
    // then
    expect(child?.aborts).toBe(1)
    expect(outcome.status).toBe("deadline")
    expect(h.delivered).toEqual([
      [{ path: "reference/a.md", hint: "The note records that rollouts go through staging first." }],
    ])
    expect(h.slot.live).toBe(0)
    await h.sidecar.shutdown()
  })

  test("#given every exit path #then the machine lease count returns to zero each time", async () => {
    // given
    const h = harness()
    // when: a failed turn backs off
    await offer(h, ["reference/a.md"])
    let settled = h.nextOutcome()
    h.port.children[0]?.finish({ status: "error", message: "provider 503 overloaded" })
    const failed = await settled
    const afterFailure = h.slot.live
    const backoff = await offer(h, ["reference/b.md"])
    h.timers.fire()
    // when: a start failure backs off
    h.port.failNextStart = new Error("stage refused")
    settled = h.nextOutcome()
    const refused = await offer(h, ["reference/c.md"])
    const startFailure = await settled
    const afterStart = h.slot.live
    h.timers.fire()
    // when: shutdown during a running turn
    await offer(h, ["reference/d.md"])
    settled = h.nextOutcome()
    await h.sidecar.shutdown()
    const cancelled = await settled
    // then
    expect(failed).toMatchObject({ status: "failed", cause: "child_failed_upstream", diagnostic: true })
    expect(backoff).toEqual({ action: "buffered", reason: "backoff" })
    expect(refused).toEqual({ action: "buffered", reason: "backoff" })
    expect(startFailure).toMatchObject({ status: "failed", cause: "start_failed" })
    expect(cancelled).toMatchObject({ status: "cancelled", cause: "shutdown" })
    expect([afterFailure, afterStart, h.slot.live]).toEqual([0, 0, 0])
    expect(h.slot.acquired).toBe(h.slot.released)
    expect(h.port.children.every((child) => child.disposed)).toBe(true)
    expect(h.port.closed).toBe(true)
    expect(h.sidecar.state()).toBe("disposed")
  })

  test("#given a start that never returns #when the deadline fires #then the wake ends as deadline with the lease back and the late child is disposed", async () => {
    // given
    const h = harness()
    const hold = deferred<void>()
    h.port.holdNextStart = hold.promise
    const settled = h.nextOutcome()
    const pending = offer(h, ["reference/a.md"])
    await flush()
    // when
    h.timers.fire(90_000)
    const outcome = await settled
    const leaseAfterDeadline = h.slot.live
    hold.resolve()
    const result = await pending
    await h.sidecar.whenIdle()
    // then
    expect(outcome.status).toBe("deadline")
    expect(leaseAfterDeadline).toBe(0)
    expect(result).toEqual({ action: "buffered", reason: "backoff" })
    expect(h.port.children[0]?.disposed).toBe(true)
    await h.sidecar.shutdown()
  })

  test("#given a busy machine slot #then the offer buffers as slot_busy without a child and a later offer seeds", async () => {
    // given
    const h = harness()
    h.slot.next = "busy"
    // when
    const busy = await offer(h, ["reference/a.md"])
    const later = await offer(h, ["reference/a.md"])
    // then
    expect(busy).toEqual({ action: "buffered", reason: "slot_busy" })
    expect(later.action).toBe("seeded")
    expect(h.port.children).toHaveLength(1)
    await h.sidecar.shutdown()
    expect(h.slot.live).toBe(0)
  })
})
