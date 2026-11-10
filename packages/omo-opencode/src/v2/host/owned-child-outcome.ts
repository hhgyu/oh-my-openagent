import type { ChildCompletionPolicy } from "@oh-my-opencode/orchestration-core/contracts/child-outcome"
import {
  observationRecordSchema,
  type ObservationSnapshot,
  type ObservedModel,
  type OwnedChildOutcome,
  type SafeChildEvent,
} from "./owned-child-observation-types"

type Step = {
  id: string
  afterOwnDelivery: boolean
  model: ObservedModel
  parts: Map<number, string>
  textStarts: Set<number>
  calls: Map<string, "called" | "success" | "failed">
  retryAttempt: number
  pendingRetry?: number
  ended?: SafeChildEvent
  failed?: string
}
type Frame = {
  start: string
  terminal?: SafeChildEvent
  steps: Step[]
  delivered: string[]
  calls: Set<string>
}

const terminals = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])
const finishes = new Set(["stop", "length", "tool-calls"])

/** Own observations, not host wait/info.outcome or a fabricated execution identifier. */
export function projectOwnedChildOutcome(snapshot: ObservationSnapshot, completion?: ChildCompletionPolicy): OwnedChildOutcome {
  const base = { delivered: [] as string[], consumption: "unconfirmed" as const }
  const uncertain = (reason: string): OwnedChildOutcome => ({ ...base, status: "uncertain", reason })
  if (completion !== undefined && completion !== "final-text" && completion !== "turn") return uncertain("invalid-completion-policy")
  const locator = snapshot?.binding?.locator
  if (!locator || locator.format !== 1 || !snapshot.binding.key || !snapshot.binding.token
    || !locator.sessionID || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.uncertainty)) {
    return uncertain("invalid-snapshot")
  }
  if (snapshot.uncertainty.length > 0) return uncertain("observation-invalidated")

  const ids = new Set<string>()
  const expected = new Set<string>()
  const delivered = new Set<string>()
  const steps = new Map<string, Step>()
  let frame: Frame | undefined
  let cursor: number | undefined
  let stopped = false
  let issue: string | undefined
  const fail = (reason: string) => { issue ??= reason }
  const currentStep = (event: SafeChildEvent): Step | undefined => {
    const step = event.data.assistantMessageID === undefined ? undefined : steps.get(event.data.assistantMessageID)
    if (!frame || frame.terminal || !step || !frame.steps.includes(step)) fail("unmatched-step")
    else return step
  }

  for (const value of snapshot.records) {
    const parsed = observationRecordSchema.safeParse(value)
    if (!parsed.success) return uncertain("invalid-record")
    const record = parsed.data
    if (ids.has(record.id)) return uncertain("duplicate-record")
    ids.add(record.id)
    if (record.kind === "uncertain") return uncertain("observation-invalidated")
    if (record.kind === "stop") { stopped = true; continue }
    if (record.kind === "input") {
      if (expected.has(record.inboxID)) return uncertain("duplicate-input")
      expected.add(record.inboxID)
      continue
    }
    // Request kind/model hooks have no causal assistant-step ID. Arrival time cannot pair them.
    if (record.kind !== "host") continue
    const event = record.event
    if (event.sessionID !== locator.sessionID || (event.durable && event.durable.aggregateID !== locator.sessionID)) {
      return uncertain("foreign-session")
    }
    if (event.durable) {
      if (event.durable.version !== 1 && event.durable.version !== 2) fail("unknown-event-version")
      if (cursor !== undefined && event.durable.seq !== cursor + 1) fail("insufficient-cursor-coverage")
      cursor = event.durable.seq
    } else if (event.type === "session.execution.started" || terminals.has(event.type)
      || event.type === "session.inbox.delivered" || event.type.startsWith("session.step.")
      || event.type === "session.text.ended" || event.type === "session.tool.called" || event.type === "session.retry.scheduled") {
      fail("missing-durable-cursor")
    }

    if (event.type === "session.execution.started") {
      if (frame && !frame.terminal) fail("overlapping-execution")
      frame = { start: event.id, steps: [], delivered: [], calls: new Set() }
      continue
    }
    if (event.type === "session.inbox.delivered") {
      const inboxID = event.data.inboxID
      if (!inboxID) { fail("missing-input-identity"); continue }
      if (expected.has(inboxID)) {
        if (!frame || frame.terminal || delivered.has(inboxID)) fail("unmatched-input-delivery")
        else { delivered.add(inboxID); frame.delivered.push(inboxID) }
      }
      continue
    }
    if (event.type === "session.step.started") {
      const { assistantMessageID, model } = event.data
      const prior = assistantMessageID === undefined ? undefined : steps.get(assistantMessageID)
      if (frame && !frame.terminal && prior && frame.steps.at(-1) === prior && model && prior.pendingRetry !== undefined) {
        // The real host reuses its assistant ID across retries. Only the explicit witness permits it.
        prior.retryAttempt = prior.pendingRetry
        prior.pendingRetry = undefined
        prior.model = model
        prior.parts.clear(); prior.textStarts.clear()
        prior.ended = undefined; prior.failed = undefined
      } else if (!frame || frame.terminal || !assistantMessageID || !model || prior
        || frame.steps.some(step => step.pendingRetry !== undefined || !step.ended && !step.failed)) {
        fail("invalid-step-start")
      } else {
        const step: Step = { id: assistantMessageID, afterOwnDelivery: frame.delivered.length > 0, model, parts: new Map(), textStarts: new Set(), calls: new Map(), retryAttempt: 1 }
        steps.set(step.id, step); frame.steps.push(step)
      }
      continue
    }
    if (event.type === "session.retry.scheduled") {
      const step = currentStep(event)
      const attempt = event.data.attempt
      if (!step || frame!.steps.at(-1) !== step || step.ended || step.failed === "aborted"
        || step.pendingRetry !== undefined || attempt === undefined || attempt !== step.retryAttempt + 1 || !event.data.errorType) {
        fail("unmatched-retry")
      } else step.pendingRetry = attempt
      continue
    }
    if (event.type.startsWith("session.step.") || event.type.startsWith("session.text.")
      || event.type.startsWith("session.reasoning.") || event.type.startsWith("session.tool.")) {
      const step = currentStep(event)
      if (!step) continue
      if (step.pendingRetry !== undefined) { fail("retry-not-restarted"); continue }
      if (step.ended || step.failed) { fail("event-after-step-terminal"); continue }
      if (event.type === "session.text.started") {
        const ordinal = event.data.ordinal
        if (ordinal === undefined || step.textStarts.has(ordinal)) fail("invalid-text-start")
        else step.textStarts.add(ordinal)
      } else if (event.type === "session.text.ended") {
        const { ordinal, text } = event.data
        if (ordinal === undefined || text === undefined || !step.textStarts.has(ordinal) || step.parts.has(ordinal)) fail("invalid-text-part")
        else step.parts.set(ordinal, text)
      } else if (event.type === "session.step.ended") {
        if (step.textStarts.size !== step.parts.size) fail("missing-text-end")
        if (!event.data.finish || !finishes.has(event.data.finish)) fail("unknown-step-finish")
        step.ended = event
      } else if (event.type === "session.step.failed") {
        if (!event.data.errorType) fail("missing-step-error")
        step.failed = event.data.errorType ?? "unknown"
      } else if (event.type === "session.tool.called") {
        if (!event.data.callID || frame!.calls.has(event.data.callID)) fail("invalid-tool-call")
        else { frame!.calls.add(event.data.callID); step.calls.set(event.data.callID, "called") }
      } else if (event.type === "session.tool.success" || event.type === "session.tool.failed" || event.type === "session.tool.progress") {
        const callID = event.data.callID
        if (!callID || step.calls.get(callID) !== "called") fail("unmatched-tool-event")
        else if (event.type !== "session.tool.progress") {
          if (event.type === "session.tool.failed" && !event.data.errorType) fail("missing-tool-error")
          step.calls.set(callID, event.type === "session.tool.success" ? "success" : "failed")
        }
      } else if (!["session.step.streamed", "session.text.delta", "session.reasoning.started", "session.reasoning.delta",
        "session.reasoning.ended", "session.tool.input.started", "session.tool.input.delta", "session.tool.input.ended",
      ].includes(event.type)) {
        fail("unknown-step-event")
      }
      continue
    }
    if (terminals.has(event.type)) {
      if (!frame || frame.terminal) { fail("unmatched-execution-terminal"); continue }
      if (frame.steps.some(step => step.pendingRetry !== undefined)) fail("retry-not-restarted")
      if (frame.steps.some(step => [...step.calls.values()].includes("called"))) fail("unfinished-tool-call")
      if (frame.steps.some(step => !step.ended && !step.failed)) fail("unfinished-step")
      if (event.type === "session.execution.failed" && !event.data.errorType) fail("missing-execution-error")
      frame.terminal = event
    } else if (event.type.startsWith("session.execution.")) {
      fail("unknown-execution-event")
    } else if (event.type.startsWith("session.retry.")) {
      fail("unknown-retry-event")
    }
  }

  if (issue) return uncertain(issue)
  const last = frame?.steps.at(-1)
  const facts = {
    ...base,
    ...(frame ? { startEventID: frame.start, delivered: [...frame.delivered] } : {}),
    ...(frame?.terminal ? { terminalEventID: frame.terminal.id } : {}),
    ...(last ? { assistantMessageID: last.id, model: { ...last.model }, observedSteps: frame!.steps.length } : {}),
    ...(frame && frame.calls.size > 0 ? { observedToolCalls: frame.calls.size } : {}),
  }
  const terminal = frame?.terminal
  if (stopped && terminal?.type !== "session.execution.interrupted" && terminal?.type !== "session.execution.failed") {
    // Local intent suppresses stale success; it is not an acknowledgement from the host.
    return { ...facts, status: "pending", reason: "stop-pending" }
  }
  if (!terminal) return { ...facts, status: "pending" }
  if (!frame!.delivered.length) return { ...facts, status: "control-only" }
  if (terminal.type === "session.execution.interrupted") return { ...facts, status: "interrupted", reason: "host-interrupted" }
  if (terminal.type === "session.execution.failed") return { ...facts, status: "error", reason: terminal.data.errorType }
  if (!last) return uncertain("missing-assistant-step")
  if ([...expected].some(id => !delivered.has(id))) return { ...facts, status: "pending", reason: "input-not-delivered" }
  const failed = frame!.steps.find(step => step.failed)
  if (failed) return { ...facts, status: failed.failed === "aborted" ? "interrupted" : "error", reason: failed.failed }
  const ownedSteps = frame!.steps.filter(step => step.afterOwnDelivery)
  if (completion !== undefined && ownedSteps.length === 0) return uncertain("missing-owned-assistant-step")
  if (last.ended?.data.finish === "tool-calls") return uncertain("unfinished-assistant-turn")
  const stepText = (step: Step) => [...step.parts].sort(([a], [b]) => a - b).map(([, part]) => part).join("")
  // Native keeps the last nonempty assistant message WITHIN the current turn.
  // Both explicit Native policies retain it; omitted policy preserves legacy P0 behavior.
  const text = completion !== undefined
    ? [...ownedSteps].reverse().map(stepText).find(value => value.length > 0) ?? ""
    : stepText(last)
  if (text.length > 1_048_576) return uncertain("output-too-large")
  if (text.length === 0 && completion !== "turn") return { ...facts, status: "error", reason: "empty-assistant-output" }
  const ended = frame!.steps.map(step => step.ended!.data)
  const tokenKeys = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const
  const tokens: NonNullable<OwnedChildOutcome["tokens"]> = {}
  for (const key of tokenKeys) {
    if (ended.every(data => data.tokens?.[key] !== undefined)) {
      const total = ended.reduce((sum, data) => sum + data.tokens![key]!, 0)
      if (Number.isSafeInteger(total)) tokens[key] = total
    }
  }
  const cost = ended.every(data => data.cost !== undefined) ? ended.reduce((sum, data) => sum + data.cost!, 0) : undefined
  return {
    ...facts, status: "completed", text,
    ...(Object.keys(tokens).length ? { tokens } : {}),
    ...(cost !== undefined && Number.isFinite(cost) ? { cost } : {}),
  }
}
