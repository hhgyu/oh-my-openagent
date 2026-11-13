// The V2 resident Kibitzer's public contract: the same defaults and wake semantics as the Senpi
// sidecar (`omo-senpi/.../kibitzer/sidecar-contract.ts`), expressed over a host-neutral child port
// instead of a senpi-task ChildHandle. The child port is implemented over the shared memory child port
// (`../memory-child-port.ts`) in `child-port.ts`; tests drive the lifecycle through a scripted port.

import type { RecallCandidate, RecallNudge } from "@oh-my-opencode/memory-core"
import type { KibitzerWakeSlot, WakeSilenceReason } from "@oh-my-opencode/memory-core/recall-sidecar"
import type { MemoryChild, MemoryChildTimers, MemoryChildTurnReport } from "../memory-child-port"
import type { KibitzerEventCaps } from "./events"
import type { KibitzerWakeOutcome } from "./outcome"

/** `memory.recall.tool_budget` default: child tool calls one wake may spend before it is cut off. */
export const KIBITZER_WAKE_TOOL_BUDGET = 8
/** Quiet period every steer re-arms; a wake that has not settled in this long is aborted. */
export const KIBITZER_WAKE_DEADLINE_MS = 90_000
/** Hard ceiling on ONE wake measured from its admission; no re-arm may pass it. */
export const KIBITZER_WAKE_MAX_TOTAL_MS = 300_000
/** `memory.recall.sidecar_max_tokens` default. */
export const KIBITZER_SIDECAR_MAX_TOKENS = 48_000
/** The child is replaced once its context estimate reaches this share of `sidecarMaxTokens`. */
export const KIBITZER_RESEED_FRACTION = 0.6
/** A path offered this many wakes ago without a nudge is carried into the reseed as rejected. */
export const KIBITZER_REJECTED_AFTER_WAKES = 3

export type KibitzerSidecarState = "idle" | "turn_running" | "reseeding" | "backoff" | "disposed"

/** Injectable timers: production uses unref'd runtime timers; tests fire them by hand. */
export type KibitzerSidecarTimers = MemoryChildTimers

/** How one child turn settled, read from the child's own transcript after it went idle. */
export type KibitzerChildTurnReport = MemoryChildTurnReport

/** One live resident child. Every input goes through the owner's gated admission paths. */
export type KibitzerChild = MemoryChild

/** `provider/model` (plus an optional host variant) the child is staged with. */
export interface KibitzerChildModel {
  readonly model: string
  readonly variant?: string
}

export type KibitzerModelPick =
  | { readonly kind: "resolved"; readonly model: KibitzerChildModel }
  | { readonly kind: "unavailable"; readonly category: string; readonly detail: string }

export interface KibitzerChildStartInput {
  readonly sessionId: string
  readonly generation: number
  /** The seed envelope, or the reseed envelope followed by the first wake envelope. */
  readonly prompt: string
  /** The model `resolveModel` picked for this seed. */
  readonly model?: KibitzerChildModel
}

/** Starts one resident child with its first turn already admitted. */
export interface KibitzerChildPort {
  /**
   * Picks the model for the next seed, asked before the wake takes a machine slot. An `unavailable`
   * pick skips the wake: no slot, no child, no backoff.
   */
  resolveModel?(): Promise<KibitzerModelPick>
  start(input: KibitzerChildStartInput): Promise<KibitzerChild>
  /** Releases everything the port owns for this sidecar (backend, journal). Idempotent. */
  close(): Promise<void>
}

export interface KibitzerSidecarOptions {
  readonly sessionId: string
  readonly port: KibitzerChildPort
  /** Hands re-validated nudges to delivery (ledger mark + pending nudges for the context hook). */
  readonly deliver: (
    nudges: readonly RecallNudge[],
    outcome: Pick<KibitzerWakeOutcome, "wake" | "generation">,
  ) => Promise<void>
  readonly onWake?: (outcome: KibitzerWakeOutcome) => void
  readonly wakeSlot: KibitzerWakeSlot
  readonly toolBudget?: number
  readonly wakeDeadlineMs?: number
  readonly sidecarMaxTokens?: number
  readonly eventCaps?: Partial<KibitzerEventCaps>
  readonly now?: () => number
  readonly random?: () => number
  readonly timers?: KibitzerSidecarTimers
  readonly warn?: (message: string, details?: Record<string, unknown>) => void
}

export interface KibitzerOfferInput {
  readonly candidates: readonly RecallCandidate[]
  /** The session's surfaced ledger as read for this batch; authoritative over the child. */
  readonly surfaced: ReadonlySet<string>
  readonly maxItems: number
  readonly taskSummary?: string
}

export type KibitzerBufferedReason = WakeSilenceReason | "backoff" | "slot_busy" | "disposed" | "model_unavailable"

export type KibitzerOfferResult =
  | { readonly action: "seeded"; readonly wake: number }
  | { readonly action: "followed_up"; readonly wake: number }
  | { readonly action: "steered"; readonly wake: number }
  | { readonly action: "buffered"; readonly reason: KibitzerBufferedReason }

/** What a Kibitzer tool call reads from the sidecar that owns the calling child. */
export interface KibitzerToolBinding {
  readonly parentSessionId: string
  readonly offered: ReadonlySet<string>
  readonly searched: Set<string>
  readonly surfaced: ReadonlySet<string>
  readonly maxItems: number
  readonly accepted: RecallNudge[]
  /** Charges one tool call against the current wake; false once the budget is spent. */
  charge(callId: string): boolean
  readonly budgetLimit: number
}
