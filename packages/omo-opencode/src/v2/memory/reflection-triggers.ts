// Automatic reflection triggers (plan S7g), porting omo-senpi `trigger-wiring.ts` onto OpenCode 2 hooks:
// - `agent_end` + `agent_settled` -> `experimental.idle`, after the transcript journal reconciled the
//   turn (that reconcile is the step accounting: memory-core counts every assistant row with text as a
//   completed step). The idle payload carries no outcome, so the turn's last assistant message is read
//   through `session.context`, the journal's own source: an error (aborted or failed), a `finish` of
//   `error`, a retry still in flight, or no assistant answer after the last user message all skip the
//   settle exactly as Senpi's `aborted` / `willRetry` / missing-outcome checks do;
// - accepted `session_compact` -> `session.compaction.ended` records `pendingCompaction`; nothing launches
//   from it. The NEXT successful settle evaluates `compaction_accepted` (memory-core persists
//   `pending_compaction`), clears the flag, then evaluates `settled`;
// - disabled reflection clears the flag and evaluates nothing, as Senpi's `enabled === false` branch does;
// - every settle first runs the stale reflection-lock check (Senpi `onSettled` stale holder), whatever the
//   turn's outcome or the reflection setting.
// Senpi only evaluates sessions with accepted user input (`userActivity.has`); here that is a real prompt
// seen this process. Owned children (facts, Kibitzer, reflection) never trigger. The work runs detached,
// serialized per session, so the host hook is never blocked; `close` stops new work and awaits the rest.

import type { ReflectionEvent, ReservationResult } from "@oh-my-opencode/memory-core"
import type * as Plugin from "@opencode/plugin/promise/plugin"
import { describeError, type BoundMemorySession } from "./binding"
import type { MemoryLogger } from "./config"
import { reflectionSettings } from "./reflection-run-store"

type SessionMessage = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number]

export interface ReflectionTriggerDeps {
  /** The binding of a root session; `undefined` for children and unbound sessions. */
  readonly resolve: (sessionID: string) => Promise<BoundMemorySession | undefined>
  readonly session: Pick<Plugin.Context["session"], "context">
  /** The reflection component's `evaluate` (reservation + detached launch of an active run). */
  readonly evaluate: (bound: BoundMemorySession, event: ReflectionEvent) => Promise<ReservationResult | null>
  /** Senpi's per-turn stale reflection-lock check (`recoverStaleHolderAfterTurn`), run on every settled turn. */
  readonly onTurnSettled?: (bound: BoundMemorySession) => Promise<void>
  /** Senpi `userActivity.has`: the session took real user input this process. */
  readonly hasUserActivity: (sessionID: string) => boolean
  readonly isOwnedSession: (sessionID: string) => boolean
  readonly logger: MemoryLogger
}

export interface ReflectionTriggers {
  /** `experimental.idle`, called after the journal reconcile of that idle; never blocks. */
  onIdle(sessionID: string): void
  /** `session.compaction.ended`: records the pending compaction for the next settle. */
  onCompaction(sessionID: string): void
  /** Resolves once every evaluation started so far has finished. */
  settled(): Promise<void>
  /** Stops new evaluations and awaits the started ones. */
  close(): Promise<void>
}

/**
 * Senpi's settle outcome for an idle turn: the last assistant message after the last user message must
 * have ended cleanly. `retry` with no completion time is a retry still scheduled (`willRetry`).
 */
function turnSettledSuccessfully(messages: readonly SessionMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message === undefined || message.type === "user") return false
    if (message.type !== "assistant") continue
    if (message.error !== undefined || message.finish === "error") return false
    return message.retry === undefined || message.time.completed !== undefined
  }
  return false
}

export function createReflectionTriggers(deps: ReflectionTriggerDeps): ReflectionTriggers {
  const pendingCompaction = new Set<string>()
  const chains = new Map<string, Promise<void>>()
  let closed = false

  const eligible = (sessionID: string): boolean =>
    !closed && !deps.isOwnedSession(sessionID) && deps.hasUserActivity(sessionID)

  async function settle(sessionID: string): Promise<void> {
    if (closed) return
    const bound = await deps.resolve(sessionID)
    if (bound === undefined || closed) return
    await deps.onTurnSettled?.(bound)
    if (closed) return
    if (!turnSettledSuccessfully(await deps.session.context({ sessionID }))) return
    if (closed) return
    if (!reflectionSettings(bound).enabled) {
      pendingCompaction.delete(sessionID)
      return
    }
    if (pendingCompaction.has(sessionID)) {
      await deps.evaluate(bound, { kind: "compaction_accepted" })
      pendingCompaction.delete(sessionID)
    }
    if (closed) return
    await deps.evaluate(bound, { kind: "settled", success: true })
  }

  function schedule(sessionID: string): void {
    const previous = chains.get(sessionID) ?? Promise.resolve()
    const next = previous
      .then(() => settle(sessionID))
      .catch((error: unknown) => {
        deps.logger.warn("memory reflection trigger failed", { sessionID, error: describeError(error) })
      })
    chains.set(sessionID, next)
    void next.finally(() => {
      if (chains.get(sessionID) === next) chains.delete(sessionID)
    })
  }

  async function settled(): Promise<void> {
    while (chains.size > 0) await Promise.allSettled([...chains.values()])
  }

  return {
    onIdle(sessionID) {
      if (eligible(sessionID)) schedule(sessionID)
    },
    onCompaction(sessionID) {
      if (eligible(sessionID)) pendingCompaction.add(sessionID)
    },
    settled,
    async close() {
      closed = true
      await settled()
      pendingCompaction.clear()
    },
  }
}
