// One resident sidecar's shared state (V2 port of omo-senpi `sidecar-core.ts`). The record adds no
// locking of its own: every transition runs under the per-session mutex `serialized`.

import type { RecallCandidate, RecallNudge } from "@oh-my-opencode/memory-core"
import {
  createAcceptedNudgeCooldown,
  type AcceptedNudgeCooldown,
  type KibitzerReseedInput,
  type KibitzerWakeLease,
} from "@oh-my-opencode/memory-core/recall-sidecar"
import {
  KIBITZER_RESEED_FRACTION,
  KIBITZER_SIDECAR_MAX_TOKENS,
  KIBITZER_WAKE_DEADLINE_MS,
  KIBITZER_WAKE_TOOL_BUDGET,
  type KibitzerChild,
  type KibitzerChildTurnReport,
  type KibitzerSidecarOptions,
  type KibitzerSidecarState,
  type KibitzerSidecarTimers,
} from "./contract"
import {
  createKibitzerEventStream,
  type KibitzerEvent,
  type KibitzerEventDigest,
  type KibitzerEventStream,
} from "./events"
import type { KibitzerWakeAbort } from "./outcome"

export interface Payload {
  readonly events: readonly KibitzerEvent[]
  readonly digest?: KibitzerEventDigest
  readonly candidates: readonly RecallCandidate[]
  readonly cursors?: { readonly first: number; readonly last: number }
}

export interface Envelope {
  readonly text: string
  readonly payload: Payload
  readonly steered: boolean
  consumed: boolean
}

export interface Child {
  readonly handle: KibitzerChild
  readonly generation: number
  /** Corpus-verified paths the child found through `memory` search; nudge-eligible for its lifetime. */
  readonly searched: Set<string>
  usageTokens: number | undefined
  charsSent: number
}

/** Per-wake tool budget; every call id is charged once whichever path sees it first. */
export interface WakeBudget {
  readonly limit: number
  used: number
  readonly charged: Map<string, boolean>
}

export interface Turn {
  readonly wake: number
  readonly generation: number
  readonly maxItems: number
  readonly startedAt: number
  readonly totalDeadlineAt: number
  readonly accepted: RecallNudge[]
  readonly budget: WakeBudget
  readonly envelopes: Envelope[]
  lease: KibitzerWakeLease | undefined
  slotWaitMs: number
  candidateCount: number
  toolStarts: number
  toolEnds: number
  abort: KibitzerWakeAbort | undefined
  deadline: unknown
  report: KibitzerChildTurnReport | undefined
  settled: Promise<void>
}

export interface SidecarCore {
  readonly sessionId: string
  readonly options: KibitzerSidecarOptions
  readonly now: () => number
  readonly random: () => number
  readonly timers: KibitzerSidecarTimers
  readonly toolBudget: number
  readonly wakeDeadlineMs: number
  readonly reseedAtTokens: number
  readonly cooldown: AcceptedNudgeCooldown
  readonly stream: KibitzerEventStream
  state: KibitzerSidecarState
  child: Child | undefined
  activeTurn: Turn | undefined
  wakeSeq: number
  generations: number
  consecutiveFailures: number
  backoffTimer: unknown
  closing: boolean
  admission: AbortController | undefined
  pendingReseed: Omit<KibitzerReseedInput, "maxItems" | "toolBudget"> | undefined
  taskSummary: string | undefined
  carry: Payload[]
  readonly offered: Set<string>
  readonly surfaced: Set<string>
  readonly offeredAtWake: Map<string, number>
  readonly delivered: Set<string>
  /** The CURRENT wake's slots; tool calls read them at call time. */
  accepted: RecallNudge[]
  budget: WakeBudget
  /** Child disposals in flight (closing a child is host I/O); shutdown joins them. */
  readonly disposals: Set<Promise<void>>
  serialized<T>(task: () => Promise<T>): Promise<T>
  whenIdle(): Promise<void>
  warn(message: string, details?: Record<string, unknown>): void
}

export function createWakeBudget(limit: number): WakeBudget {
  return { limit, used: 0, charged: new Map() }
}

export function chargeBudget(budget: WakeBudget, callId: string): boolean {
  const known = budget.charged.get(callId)
  if (known !== undefined) return known
  const allowed = budget.used < budget.limit
  if (allowed) budget.used += 1
  budget.charged.set(callId, allowed)
  return allowed
}

export function createSidecarCore(options: KibitzerSidecarOptions): SidecarCore {
  const now = options.now ?? Date.now
  const toolBudget = options.toolBudget ?? KIBITZER_WAKE_TOOL_BUDGET
  let chain: Promise<unknown> = Promise.resolve()
  const core: SidecarCore = {
    sessionId: options.sessionId,
    options,
    now,
    random: options.random ?? Math.random,
    timers: options.timers ?? RUNTIME_TIMERS,
    toolBudget,
    wakeDeadlineMs: options.wakeDeadlineMs ?? KIBITZER_WAKE_DEADLINE_MS,
    reseedAtTokens: Math.floor((options.sidecarMaxTokens ?? KIBITZER_SIDECAR_MAX_TOKENS) * KIBITZER_RESEED_FRACTION),
    cooldown: createAcceptedNudgeCooldown({ now }),
    stream: createKibitzerEventStream({ now, ...(options.eventCaps === undefined ? {} : { caps: options.eventCaps }) }),
    state: "idle",
    child: undefined,
    activeTurn: undefined,
    wakeSeq: 0,
    generations: 0,
    consecutiveFailures: 0,
    backoffTimer: undefined,
    closing: false,
    admission: undefined,
    pendingReseed: undefined,
    taskSummary: undefined,
    carry: [],
    offered: new Set(),
    surfaced: new Set(),
    offeredAtWake: new Map(),
    delivered: new Set(),
    accepted: [],
    budget: createWakeBudget(toolBudget),
    disposals: new Set(),
    serialized<T>(task: () => Promise<T>): Promise<T> {
      const run = chain.then(task, task)
      chain = run.catch(() => undefined)
      return run
    },
    async whenIdle() {
      for (;;) {
        await chain
        const turn = core.activeTurn
        if (turn === undefined) break
        await turn.settled
      }
      await Promise.allSettled([...core.disposals])
    },
    warn(message, details = {}) {
      options.warn?.(message, { sessionId: options.sessionId, ...details })
    },
  }
  return core
}

const RUNTIME_TIMERS: KibitzerSidecarTimers = {
  set(callback, ms) {
    const handle = setTimeout(callback, ms)
    handle.unref?.()
    return handle
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
