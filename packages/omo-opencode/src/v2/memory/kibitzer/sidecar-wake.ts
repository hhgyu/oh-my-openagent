// The transitions of one wake, each run under the per-session mutex (V2 port of omo-senpi
// `sidecar-wake.ts`): `seed` starts a fresh child, `followUp` revives the idle child, `steer` joins
// the running turn, `settle` closes the turn - lease back first, nudges re-validated and delivered,
// unread envelopes carried, next state chosen.

import type { RecallCandidate, RecallNudge } from "@oh-my-opencode/memory-core"
import {
  renderKibitzerReseedPrompt,
  renderKibitzerSeedPrompt,
  renderKibitzerWakePrompt,
} from "@oh-my-opencode/memory-core/recall-sidecar"
import type { KibitzerChild, KibitzerChildTurnReport, KibitzerOfferResult } from "./contract"
import { classifyWakeEnd, startFailureEnd } from "./outcome"
import { describe, type Child, type Envelope, type Payload, type SidecarCore, type Turn } from "./sidecar-core"
import { envelopeInput, merge, payloadOf } from "./sidecar-envelope"
import type { TurnLifecycle } from "./sidecar-turn"

export interface WakeTransitions {
  seed(fresh: readonly RecallCandidate[], maxItems: number): Promise<KibitzerOfferResult>
  followUp(current: Child, fresh: readonly RecallCandidate[], maxItems: number): Promise<KibitzerOfferResult>
  steer(current: Child, turn: Turn, fresh: readonly RecallCandidate[], maxItems: number): Promise<KibitzerOfferResult>
  settle(turn: Turn, report: KibitzerChildTurnReport): Promise<void>
}

export function createWakeTransitions(core: SidecarCore, turns: TurnLifecycle): WakeTransitions {
  /** The deadline fired while child I/O was in flight: settle inline, the transition disposes the late handle. */
  async function abandonPendingStart(turn: Turn): Promise<void> {
    if (turn.abort !== undefined) return
    turn.abort = "deadline"
    turns.clearDeadline(turn)
    await turns.releaseLease(turn)
    turns.report(turn, { status: "deadline" }, [], undefined)
  }

  function abandoned(payload: Payload): KibitzerOfferResult {
    core.carry = [payload]
    turns.enterBackoff()
    return { action: "buffered", reason: "backoff" }
  }

  function beginTurn(current: Child, turn: Turn, envelope: Envelope): void {
    turn.envelopes.push(envelope)
    current.charsSent += envelope.text.length
    core.activeTurn = turn
    core.state = "turn_running"
    turns.armDeadline(turn)
    turn.settled = current.handle
      .waitForIdle()
      .then(
        (report) => core.serialized(() => settle(turn, report)),
        (error: unknown) =>
          core.serialized(() => settle(turn, { status: "error", message: describe(error), userTexts: [] })),
      )
      .catch((error: unknown) =>
        core.warn("kibitzer sidecar settlement failed", { wake: turn.wake, error: describe(error) }),
      )
  }

  async function seed(fresh: readonly RecallCandidate[], maxItems: number): Promise<KibitzerOfferResult> {
    const admitted = await turns.admit()
    if (admitted.status !== "acquired") return turns.refused(admitted, core.generations + 1, maxItems, fresh.length)
    const payload = merge([...core.carry, payloadOf(core.stream.drain(), fresh)])
    core.carry = []
    const wakeText =
      core.pendingReseed === undefined
        ? renderKibitzerSeedPrompt(envelopeInput(core, payload, maxItems, true))
        : renderKibitzerWakePrompt(envelopeInput(core, payload, maxItems, false))
    const prompt =
      core.pendingReseed === undefined
        ? wakeText
        : `${renderKibitzerReseedPrompt({ ...core.pendingReseed, maxItems, toolBudget: core.toolBudget })}${wakeText}`
    const generation = core.generations + 1
    const turn = turns.newTurn(generation, maxItems, payload.candidates.length)
    turn.lease = admitted.lease
    turn.slotWaitMs = admitted.waitedMs
    turns.armDeadline(turn, () => {
      void abandonPendingStart(turn)
    })
    let handle: KibitzerChild
    try {
      handle = await core.options.port.start({ sessionId: core.sessionId, generation, prompt })
    } catch (error) {
      if (turn.abort === "deadline") return abandoned(payload)
      turns.clearDeadline(turn)
      core.carry = [payload]
      await turns.releaseLease(turn)
      turns.report(turn, startFailureEnd(error), [], undefined)
      turns.enterBackoff()
      return { action: "buffered", reason: "backoff" }
    }
    if (turn.abort === "deadline" || core.closing) {
      // The wake is already settled (or the session is closing): the late child begins no turn.
      turns.disposeHandle(handle)
      if (core.closing && turn.abort === undefined) {
        turns.clearDeadline(turn)
        await turns.releaseLease(turn)
        return { action: "buffered", reason: "disposed" }
      }
      return abandoned(payload)
    }
    core.generations = generation
    core.pendingReseed = undefined
    turns.offerPaths(fresh, turn.wake)
    const created: Child = { handle, generation, searched: new Set(), usageTokens: undefined, charsSent: 0 }
    core.child = created
    beginTurn(created, turn, { text: prompt, payload, steered: false, consumed: true })
    return { action: "seeded", wake: turn.wake }
  }

  async function followUp(
    current: Child,
    fresh: readonly RecallCandidate[],
    maxItems: number,
  ): Promise<KibitzerOfferResult> {
    const admitted = await turns.admit()
    if (admitted.status !== "acquired") return turns.refused(admitted, current.generation, maxItems, fresh.length)
    const payload = merge([...core.carry, payloadOf(core.stream.drain(), fresh)])
    core.carry = []
    const text = renderKibitzerWakePrompt(envelopeInput(core, payload, maxItems, false))
    const turn = turns.newTurn(current.generation, maxItems, payload.candidates.length)
    turn.lease = admitted.lease
    turn.slotWaitMs = admitted.waitedMs
    turns.offerPaths(fresh, turn.wake)
    turns.armDeadline(turn, () => {
      void abandonPendingStart(turn)
    })
    try {
      await current.handle.followUp(text)
    } catch (error) {
      if (turn.abort === "deadline") {
        turns.disposeChild()
        return abandoned(payload)
      }
      turns.clearDeadline(turn)
      core.carry = [payload]
      await turns.releaseLease(turn)
      turns.report(turn, { status: "failed", cause: "child_failed", reason: describe(error) }, [], current)
      turns.disposeChild()
      turns.enterBackoff()
      return { action: "buffered", reason: "backoff" }
    }
    if (turn.abort === "deadline") {
      await turns.abortChild(current, "deadline")
      turns.disposeChild()
      return abandoned(payload)
    }
    beginTurn(current, turn, { text, payload, steered: false, consumed: true })
    return { action: "followed_up", wake: turn.wake }
  }

  async function steer(
    current: Child,
    turn: Turn,
    fresh: readonly RecallCandidate[],
    maxItems: number,
  ): Promise<KibitzerOfferResult> {
    const payload = payloadOf(core.stream.drain(), fresh)
    const text = renderKibitzerWakePrompt(envelopeInput(core, payload, maxItems, false))
    turns.offerPaths(fresh, turn.wake)
    turn.candidateCount += fresh.length
    turn.envelopes.push({ text, payload, steered: true, consumed: false })
    current.charsSent += text.length
    turns.armDeadline(turn)
    try {
      await current.handle.steer(text)
    } catch (error) {
      // Left unconsumed on purpose: settlement replays it through the followUp.
      core.warn("kibitzer sidecar steer failed", { wake: turn.wake, error: describe(error) })
    }
    return { action: "steered", wake: turn.wake }
  }

  async function settle(turn: Turn, report: KibitzerChildTurnReport): Promise<void> {
    // The provider turn is over whatever happens next: the machine slot goes back first.
    await turns.releaseLease(turn)
    if (core.activeTurn !== turn || core.child === undefined) return
    const current = core.child
    turns.clearDeadline(turn)
    turn.report = report
    if (report.contextTokens !== undefined) current.usageTokens = report.contextTokens
    const read = new Set(report.userTexts)
    for (const envelope of turn.envelopes) if (envelope.steered && read.has(envelope.text)) envelope.consumed = true
    const end = classifyWakeEnd(report, turn.abort)
    const nudges: RecallNudge[] = end.status === "cancelled" ? [] : turns.validated(turn, current)
    if (nudges.length > 0) {
      try {
        await core.options.deliver(nudges, { wake: turn.wake, generation: turn.generation })
      } catch (error) {
        core.warn("kibitzer sidecar delivery failed", { wake: turn.wake, error: describe(error) })
      }
      for (const nudge of nudges) {
        core.delivered.add(nudge.path)
        core.surfaced.add(nudge.path)
      }
      core.cooldown.charge()
    }
    // A dead child judged nothing it was sent; a live one may have missed steers that landed late.
    const unread =
      end.status === "failed"
        ? turn.envelopes
        : turn.envelopes.filter((envelope) => envelope.steered && !envelope.consumed)
    core.carry.push(...unread.map((envelope) => envelope.payload))
    if (end.status === "failed") {
      for (const path of turn.envelopes.flatMap((envelope) =>
        envelope.payload.candidates.map((candidate) => candidate.path),
      )) {
        if (core.delivered.has(path)) continue
        core.offered.delete(path)
        core.offeredAtWake.delete(path)
      }
    }
    core.activeTurn = undefined
    turns.report(turn, end, nudges, current)
    switch (end.status) {
      case "cancelled":
        turns.disposeChild()
        core.state = "disposed"
        return
      case "failed":
        turns.disposeChild()
        turns.enterBackoff()
        return
      case "completed":
      case "tool_budget_exceeded":
      case "deadline":
        core.consecutiveFailures = 0
        if (turns.contextEstimate(current) >= core.reseedAtTokens) {
          turns.prepareReseed(turn.wake)
          turns.disposeChild()
          core.state = "reseeding"
          return
        }
        if (core.carry.length > 0 && !core.closing) {
          core.state = "idle"
          await followUp(current, [], turn.maxItems)
          return
        }
        core.state = "idle"
        return
      default:
        end satisfies never
    }
  }

  return { seed, followUp, steer, settle }
}
