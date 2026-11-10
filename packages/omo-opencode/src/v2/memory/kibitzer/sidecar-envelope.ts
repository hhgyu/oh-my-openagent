// From buffered events and candidates to the input of one envelope (V2 port of omo-senpi
// `sidecar-envelope.ts`): carried payloads merge ahead of the fresh batch, events by seq and
// candidates by first sight, shaped for memory-core's `sidecar-prompt` renderers.

import type { RecallCandidate } from "@oh-my-opencode/memory-core"
import type { KibitzerSidecarEnvelopeInput, KibitzerSidecarEvent } from "@oh-my-opencode/memory-core/recall-sidecar"
import type { KibitzerEvent, KibitzerEventBatch, KibitzerEventDigest } from "./events"
import type { Payload, SidecarCore } from "./sidecar-core"

export function payloadOf(batch: KibitzerEventBatch, candidates: readonly RecallCandidate[]): Payload {
  return { events: batch.events, ...(batch.digest === undefined ? {} : { digest: batch.digest }), candidates, ...(batch.cursors === undefined ? {} : { cursors: batch.cursors }) }
}

/** Oldest carried payloads first, then the fresh batch: events by seq, candidates by first sight. */
export function merge(parts: readonly Payload[]): Payload {
  const bySeq = new Map<number, KibitzerEvent>()
  const byPath = new Map<string, RecallCandidate>()
  let digest: KibitzerEventDigest | undefined
  let first: number | undefined
  let last: number | undefined
  for (const part of parts) {
    for (const event of part.events) bySeq.set(event.seq, event)
    for (const candidate of part.candidates) if (!byPath.has(candidate.path)) byPath.set(candidate.path, candidate)
    digest ??= part.digest
    if (part.cursors !== undefined) {
      first = first === undefined ? part.cursors.first : Math.min(first, part.cursors.first)
      last = last === undefined ? part.cursors.last : Math.max(last, part.cursors.last)
    }
  }
  return {
    events: [...bySeq.values()].sort((left, right) => left.seq - right.seq),
    ...(digest === undefined ? {} : { digest }),
    candidates: [...byPath.values()],
    ...(first === undefined || last === undefined ? {} : { cursors: { first, last } }),
  }
}

export function envelopeInput(core: SidecarCore, payload: Payload, maxItems: number, withTask: boolean): KibitzerSidecarEnvelopeInput {
  return {
    sessionId: core.sessionId, maxItems, toolBudget: core.toolBudget, events: payload.events.map(sidecarEvent), candidates: payload.candidates,
    ...(payload.digest === undefined ? {} : {
      digest: { text: payload.digest.line, cursorFrom: payload.digest.firstCursor, cursorTo: payload.digest.lastCursor, folded: payload.digest.count },
    }),
    ...(withTask && core.taskSummary !== undefined ? { taskSummary: core.taskSummary } : {}),
  }
}

function sidecarEvent(event: KibitzerEvent): KibitzerSidecarEvent {
  switch (event.kind) {
    case "prompt":
    case "assistant": return { cursor: event.cursor, kind: event.kind, text: event.body }
    case "tool_call": return { cursor: event.cursor, kind: event.kind, ...(event.tool === undefined ? {} : { tool: event.tool }), args: event.body }
    case "tool_result": return { cursor: event.cursor, kind: event.kind, ...(event.tool === undefined ? {} : { tool: event.tool }), resultHead: event.body }
    default: return event.kind satisfies never
  }
}
