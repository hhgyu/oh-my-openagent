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
export const observationRecordSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("host"), id: text, event: safeChildEventSchema }).strict().refine(value => value.id === value.event.id, "Host event identity mismatch"),
  z.object({ kind: z.literal("input"), id: text, inboxID: text }).strict(),
  z.object({ kind: z.literal("stop"), id: text }).strict(),
  z.object({ kind: z.literal("primary"), id: text, model: observedModelSchema }).strict(),
  z.object({ kind: z.literal("auxiliary"), id: text, requestKind: z.enum(["title", "generate", "compaction"]) }).strict(),
  z.object({ kind: z.literal("uncertain"), id: text, reason: z.string().min(1).max(128) }).strict(),
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

/** Project only safe fields, never stringify raw provider errors, inputs or outputs. */
export function normalizeOwnedChildEvent(raw: unknown, sessionID: string): SafeChildEvent | undefined {
  if (!raw || typeof raw !== "object") throw new Error("Invalid host event envelope")
  const event = raw as Record<string, any>
  const data = event.data && typeof event.data === "object" ? event.data : {}
  if (data.sessionID !== sessionID && event.durable?.aggregateID !== sessionID) return undefined
  if (data.sessionID !== undefined && event.durable?.aggregateID !== undefined && data.sessionID !== event.durable.aggregateID) throw new Error("Host event session identity mismatch")
  const value: Record<string, unknown> = {}
  for (const key of ["assistantMessageID", "inboxID", "model", "agent", "ordinal", "finish", "cost", "title"] as const) if (data[key] !== undefined) value[key] = data[key]
  if (data.model) value.model = { id: data.model.id, providerID: data.model.providerID, ...(data.model.variant === undefined ? {} : { variant: data.model.variant }) }
  if (data.tokens) value.tokens = Object.fromEntries(["input", "output", "reasoning", "cacheRead", "cacheWrite"].filter(key => data.tokens[key] !== undefined).map(key => [key, data.tokens[key]]))
  if (event.type === "session.text.ended") value.text = data.text
  if (event.type === "session.retry.scheduled" && data.attempt !== undefined) value.attempt = data.attempt
  if (data.error && typeof data.error.type === "string") value.errorType = data.error.type
  if (data.item && typeof data.item.type === "string") value.inputKind = data.item.type
  if (typeof event.type === "string" && event.type.startsWith("session.tool.")) {
    if (data.id !== undefined) value.callID = data.id
    if (data.name !== undefined) value.name = data.name
    if (data.executed !== undefined) value.executed = data.executed
  }
  return safeChildEventSchema.parse({ id: event.id, type: event.type, created: event.created, sessionID, durable: event.durable, data: value })
}
