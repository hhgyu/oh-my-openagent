import { z } from "zod"
import type { ChildLocator } from "./session-backend"

const text = z.string().min(1).max(4096)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const observedModelSchema = z.object({ providerID: text, id: text, variant: text.optional() }).strict()
const tokensSchema = z.object({ input: integer.optional(), output: integer.optional(), reasoning: integer.optional(), cacheRead: integer.optional(), cacheWrite: integer.optional() }).strict()
export const safeChildEventSchema = z.object({
  id: text, type: z.string().min(1).max(512), created: integer, sessionID: text,
  durable: z.object({ aggregateID: text, seq: integer, version: integer }).strict().optional(),
  data: z.object({
    assistantMessageID: text.optional(), inboxID: text.optional(), inputKind: z.string().max(128).optional(),
    model: observedModelSchema.optional(), agent: text.optional(), ordinal: integer.optional(),
    text: z.string().max(1_048_576).optional(), finish: z.string().max(128).optional(),
    errorType: z.string().max(128).optional(), attempt: integer.refine(value => value > 0).optional(), tokens: tokensSchema.optional(), cost: z.number().finite().nonnegative().optional(),
    callID: text.optional(), name: text.optional(), executed: z.boolean().optional(), title: z.string().max(4096).optional(),
  }).strict(),
}).strict().refine(event => event.data.text === undefined || event.type === "session.text.ended", "Text is only retained for final text parts")
export type ObservedModel = z.infer<typeof observedModelSchema>
export type SafeChildEvent = z.infer<typeof safeChildEventSchema>
const metadataIdentity = z.string().min(1).max(4096).regex(/^[^\s\x00-\x1f\x7f]+$/)
/** Parent hook facts, not host events: no timestamp, durable cursor or event ID. */
export const safeToolMetadataSchema = z.object({
  sessionID: metadataIdentity, messageID: metadataIdentity, callID: metadataIdentity,
  tool: z.string().min(1).max(512).regex(/^[A-Za-z0-9_.:-]+$/), status: z.enum(["completed", "error"]),
}).strict()
export type SafeToolMetadata = z.infer<typeof safeToolMetadataSchema>
export const toolMetadataRecordID = (value: SafeToolMetadata): string => `tool-metadata:${JSON.stringify([value.sessionID,value.messageID,value.callID])}`
export const observationRecordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("host"), id: text, event: safeChildEventSchema }).strict().refine(value => value.id === value.event.id, "Host event identity mismatch"),
  z.object({ kind: z.literal("input"), id: text, inboxID: text }).strict(),
  z.object({ kind: z.literal("stop"), id: text }).strict(),
  z.object({ kind: z.literal("primary"), id: text, model: observedModelSchema }).strict(),
  z.object({ kind: z.literal("auxiliary"), id: text, requestKind: z.enum(["title", "generate", "compaction"]) }).strict(),
  z.object({ kind: z.literal("uncertain"), id: text, reason: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("tool-metadata"), id: z.string().min(1).max(74_000), metadata: safeToolMetadataSchema }).strict().refine(value => value.id === toolMetadataRecordID(value.metadata), "Tool metadata identity mismatch"),
  z.object({ kind: z.literal("tool-metadata-gap"), id: text, reason: z.string().min(1).max(128) }).strict(),
])
export type ObservationRecord = z.infer<typeof observationRecordSchema>
export interface ObservationBinding { readonly key: string; readonly token: string; readonly locator: ChildLocator }
export interface ObservationSnapshot {
  readonly binding: ObservationBinding
  readonly records: readonly ObservationRecord[]
  readonly uncertainty: readonly string[]
}
export interface BoundChildObservation {
  readonly binding: ObservationBinding
  append(record: ObservationRecord): void
  snapshot(): ObservationSnapshot
  /** Only downgrades this still-current binding; never grants new custody. */
  invalidate(reason: string): void
}
export interface OwnedChildObservationStore {
  bind(input: { key: string; locator: ChildLocator; guard: () => void }): BoundChildObservation
  close(): void
}
export interface OwnedChildOutcome {
  readonly status: "pending" | "control-only" | "uncertain" | "completed" | "error" | "interrupted"
  /** Our frame references a real host start event. It is NOT a host executionID. */
  readonly startEventID?: string
  readonly terminalEventID?: string
  readonly assistantMessageID?: string
  readonly text?: string
  readonly model?: ObservedModel
  readonly reason?: string
  readonly delivered: readonly string[]
  readonly consumption: "unconfirmed"
  readonly observedSteps?: number
  readonly observedToolCalls?: number
  readonly tokens?: z.infer<typeof tokensSchema>
  readonly cost?: number
}

/** Safe parent-owned read view. It deliberately exposes no custody capability. */
export interface OwnedChildObservationView {
  readonly records: readonly ObservationRecord[]
  readonly uncertainty: readonly string[]
  readonly toolMetadata: {
    readonly scope: "model-loop-outer-calls"
    readonly coverage: "unavailable" | "partial" | "uncertain"
    readonly reasons: readonly string[]
    readonly joined: readonly SafeToolMetadata[]
  }
}

/** Plain property read with JavaScript semantics on any non-nullish value; nullish yields undefined. */
function field(value: unknown, key: string): unknown {
  return value === null || value === undefined ? undefined : Reflect.get(Object(value), key)
}

/** Project only safe fields, never stringify raw provider errors, inputs or outputs. */
export function normalizeOwnedChildEvent(raw: unknown, sessionID: string): SafeChildEvent | undefined {
  if (!raw || typeof raw !== "object") throw new Error("Invalid host event envelope")
  const event = raw as Record<string, unknown>
  const data = (event.data && typeof event.data === "object" ? event.data : {}) as Record<string, unknown>
  const aggregateID = field(event.durable, "aggregateID")
  if (data.sessionID !== sessionID && aggregateID !== sessionID) return undefined
  if (data.sessionID !== undefined && aggregateID !== undefined && data.sessionID !== aggregateID) throw new Error("Host event session identity mismatch")
  const value: Record<string, unknown> = {}
  for (const key of ["assistantMessageID", "inboxID", "model", "agent", "ordinal", "finish", "cost", "title"] as const) if (data[key] !== undefined) value[key] = data[key]
  const model = data.model
  if (model) {
    const variant = field(model, "variant")
    value.model = { id: field(model, "id"), providerID: field(model, "providerID"), ...(variant === undefined ? {} : { variant }) }
  }
  const tokens = data.tokens
  if (tokens) value.tokens = Object.fromEntries(["input", "output", "reasoning", "cacheRead", "cacheWrite"].filter(key => field(tokens, key) !== undefined).map(key => [key, field(tokens, key)]))
  if (event.type === "session.text.ended") value.text = data.text
  if (event.type === "session.retry.scheduled" && data.attempt !== undefined) value.attempt = data.attempt
  const errorType = data.error ? field(data.error, "type") : undefined
  if (typeof errorType === "string") value.errorType = errorType
  const inputKind = data.item ? field(data.item, "type") : undefined
  if (typeof inputKind === "string") value.inputKind = inputKind
  if (typeof event.type === "string" && event.type.startsWith("session.tool.")) {
    if (data.id !== undefined) value.callID = data.id
    if (data.name !== undefined) value.name = data.name
    if (data.executed !== undefined) value.executed = data.executed
  }
  return safeChildEventSchema.parse({ id: event.id, type: event.type, created: event.created, sessionID, durable: event.durable, data: value })
}
