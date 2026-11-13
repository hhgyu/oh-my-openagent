// One dream request, ported from omo-senpi `components/memory/dream-trigger-fire.ts` `fireDream`:
//   1. the memory-core gates (`./dream-gates`), probing the dream ledger and, for `idle` only, the unreflected volume;
//   2. the selection: none for `pressure`, the explicit ids of a manual request, else the scored auto
//      selection over the identity's journals (memory-core `./dream-selection`);
//   3. one reflection snapshot per selected conversation; a non-pressure dream with nothing unreflected
//      stops with `no_unreflected_content`;
//   4. `ReflectionReservationStore.tryReserve({trigger: "dream", origin, ...})`: a parked identity refuses
//      automatic dreams, a busy slot queues the request as pending, and the run that wins the active slot
//      is handed to `launch` (the reflection runner, which enforces `targetDoc`).
// Senpi's drain signal and deadline are not ported: V2 has no shutdown origin (parity P-29).

import {
  TranscriptJournal,
  type CapturedConversation,
  type DreamOrigin,
  type ReflectionReservationStore,
  type ReservedRun,
} from "@oh-my-opencode/memory-core"
import { join } from "node:path"
import type { BoundMemorySession } from "./binding"
import {
  evaluateDreamGates,
  readLastDreamAtMs,
  type DreamGateRejection,
  type DreamTriggerSettings,
} from "@oh-my-opencode/memory-core/dream-gates"
import {
  computeUnreflectedVolumeFast,
  loadConversations,
  selectLoadedConversations,
  type DreamSelectorOptions,
} from "@oh-my-opencode/memory-core/dream-selection"

/** The origins a V2 host can raise: OpenCode 2 has no shutdown event (parity P-29). */
export type V2DreamOrigin = Exclude<DreamOrigin, "shutdown">

export interface DreamRequest {
  readonly focus?: string
  readonly conversationIds?: readonly string[]
  readonly targetDoc?: string
}

export type DreamFireOutcome =
  | { readonly fired: true; readonly runId: string; readonly status: "active" | "pending" }
  | {
      readonly fired: false
      readonly rejection: DreamGateRejection | "no_unreflected_content" | "no_session" | "parked"
    }

interface DreamFireInput {
  readonly bound: BoundMemorySession
  readonly origin: V2DreamOrigin
  readonly settings: DreamTriggerSettings
  readonly request: DreamRequest
  readonly store: Pick<ReflectionReservationStore, "tryReserve">
  readonly now: () => number
  /** Starts the run that won the active slot; must not throw. */
  readonly launch: (run: ReservedRun) => void
}

export async function fireDream(input: DreamFireInput): Promise<DreamFireOutcome> {
  const { bound, origin, settings, request, now } = input
  const transcriptsDir = bound.paths.transcripts
  const selector: DreamSelectorOptions = {
    transcriptsDir,
    currentConversationId: bound.sessionID,
    autoSelectMax: settings.autoSelectMax,
    autoSelectMaxBytes: settings.autoSelectMaxChars,
    now: () => new Date(now()),
  }
  const decision = await evaluateDreamGates(origin, settings, {
    nowMs: now(),
    lastDreamAtMs: () => readLastDreamAtMs(bound.paths.runtime),
    unreflectedBytes: () =>
      origin === "pressure" || request.conversationIds !== undefined
        ? Promise.resolve(0)
        : computeUnreflectedVolumeFast(selector),
  })
  if (!decision.allowed) return { fired: false, rejection: decision.rejection }
  const selected =
    origin === "pressure"
      ? []
      : (request.conversationIds ??
        selectLoadedConversations(
          await loadConversations(transcriptsDir, Math.max(settings.autoSelectMax * 4, 8)),
          selector,
          request.focus === undefined ? {} : { focus: request.focus },
        ).conversationIds)
  const conversationIds: string[] = []
  const snapshots: CapturedConversation[] = []
  for (const conversationId of selected) {
    const snapshot = await new TranscriptJournal({
      journalDir: join(transcriptsDir, conversationId),
    }).captureReflectionSnapshot()
    if (snapshot === null) continue
    conversationIds.push(conversationId)
    snapshots.push({ conversationId, snapshot })
  }
  if (origin !== "pressure" && conversationIds.length === 0)
    return { fired: false, rejection: "no_unreflected_content" }
  const result = await input.store.tryReserve({
    trigger: "dream",
    origin,
    conversationIds,
    snapshots,
    ...(request.focus === undefined ? {} : { focus: request.focus }),
    ...(request.targetDoc === undefined ? {} : { targetDoc: request.targetDoc }),
  })
  if (result.status === "parked") return { fired: false, rejection: "parked" }
  if (result.status === "active") input.launch(result.run)
  return { fired: true, runId: result.run.runId, status: result.status }
}
