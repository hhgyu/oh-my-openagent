// Automatic dream origins (plan S7h), porting omo-senpi `dream-trigger.ts` and
// `pressure-dream-admission.ts` onto OpenCode 2 hooks:
// - idle: Senpi's in-extension timer armed on `agent_settled` -> an unref'd timer of `dream.idle_minutes`
//   armed on `experimental.idle` for a bound root session with real user input (`idle_minutes` 0 never
//   arms); `input` / `agent_start` / `session_compact` resets -> the `prompt` hook and the `compaction`
//   hook clear it; `session_shutdown` / `session_abort` -> component close cancels every timer. When it
//   fires, Senpi's `isIdle() && !hasPendingMessages()` probe becomes a read of the session transcript: the
//   last user-or-assistant message must be a completed assistant message, else the fire is dropped. The
//   gates (`dream-gates.ts`) are evaluated again inside the request, so a dream that became too soon or
//   disabled since arming does not run;
// - pressure: Senpi's status refresh at bind -> `onBound`: the committed `system/` estimate at or above the
//   soft target requests a `pressure` dream when the session already took user input, else it is deferred
//   to the first settled turn (Senpi `deferOrRequest` / `requestDeferred`);
// - shutdown: none (parity P-29).
// Fires run detached and tracked; `close` stops new work and awaits the started requests.

import type * as Plugin from "@opencode/plugin/promise/plugin"
import { describeError, type BoundMemorySession } from "./binding"
import type { MemoryLogger } from "./config"
import type { DreamFireOutcome } from "./dream-fire"
import type { DreamTriggerSettings } from "@oh-my-opencode/memory-core/dream-gates"
import type { V2DreamOrigin } from "./dream-fire"
import type { MemoryChildTimers } from "./memory-child-port"

type SessionMessage = Awaited<ReturnType<Plugin.Context["session"]["context"]>>[number]

interface DreamTriggerDeps {
  readonly resolve: (sessionID: string) => Promise<BoundMemorySession | undefined>
  readonly session: Pick<Plugin.Context["session"], "context">
  readonly request: (bound: BoundMemorySession, origin: Exclude<V2DreamOrigin, "manual">) => Promise<DreamFireOutcome>
  readonly settings: (bound: BoundMemorySession) => DreamTriggerSettings
  /** The bind-time pressure probe (`dream-budget.ts` `underSystemTokenPressure`). */
  readonly pressure: (bound: BoundMemorySession) => Promise<boolean>
  readonly hasUserActivity: (sessionID: string) => boolean
  readonly isOwnedSession: (sessionID: string) => boolean
  readonly logger: MemoryLogger
  readonly timers?: MemoryChildTimers
}

const unrefTimers: MemoryChildTimers = {
  set(callback, ms) {
    const handle = setTimeout(callback, ms)
    handle.unref()
    return handle
  },
  clear(handle) {
    if (handle !== undefined) clearTimeout(handle as Parameters<typeof clearTimeout>[0])
  },
}

/** Senpi's idle probe on the transcript: no user input after the last answer, which itself completed. */
function sessionStillIdle(messages: readonly SessionMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message === undefined || message.type === "user") return false
    if (message.type === "assistant") return message.time.completed !== undefined
  }
  return false
}

export function createDreamTriggers(deps: DreamTriggerDeps) {
  const timers = deps.timers ?? unrefTimers
  const armed = new Map<string, unknown>()
  // Bumped by every prompt and compaction, so an idle whose bind resolved after a newer prompt never arms.
  const epochs = new Map<string, number>()
  const deferredPressure = new Set<string>()
  const work = new Set<Promise<void>>()
  let closed = false

  const eligible = (sessionID: string): boolean => !closed && !deps.isOwnedSession(sessionID) && deps.hasUserActivity(sessionID)

  function track(task: () => Promise<unknown>): void {
    const promise = task().then(() => undefined, (error: unknown) => { deps.logger.warn("memory dream trigger failed", { error: describeError(error) }) })
    work.add(promise)
    void promise.finally(() => { work.delete(promise) })
  }

  function clear(sessionID: string): void {
    epochs.set(sessionID, (epochs.get(sessionID) ?? 0) + 1)
    const handle = armed.get(sessionID)
    if (handle === undefined) return
    armed.delete(sessionID)
    timers.clear(handle)
  }

  function fire(sessionID: string, handle: unknown): void {
    if (armed.get(sessionID) !== handle) return
    armed.delete(sessionID)
    track(async () => {
      const bound = closed ? undefined : await deps.resolve(sessionID)
      if (bound === undefined || closed || armed.has(sessionID)) return
      if (!sessionStillIdle(await deps.session.context({ sessionID })) || closed || armed.has(sessionID)) return
      await deps.request(bound, "idle")
    })
  }

  async function arm(sessionID: string): Promise<void> {
    const epoch = epochs.get(sessionID) ?? 0
    const bound = await deps.resolve(sessionID)
    if (bound === undefined || !eligible(sessionID) || (epochs.get(sessionID) ?? 0) !== epoch) return
    if (deferredPressure.delete(sessionID)) await deps.request(bound, "pressure")
    const idleMinutes = deps.settings(bound).idleMinutes
    if (closed || idleMinutes <= 0 || (epochs.get(sessionID) ?? 0) !== epoch) return
    const previous = armed.get(sessionID)
    if (previous !== undefined) timers.clear(previous)
    const handle: unknown = timers.set(() => { fire(sessionID, handle) }, idleMinutes * 60_000)
    armed.set(sessionID, handle)
  }

  async function settled(): Promise<void> {
    while (work.size > 0) await Promise.allSettled([...work])
  }

  return {
    /** `experimental.idle`, after the journal reconcile of that idle: requests a deferred pressure dream, then arms. */
    onIdle(sessionID: string): void {
      if (eligible(sessionID)) track(() => arm(sessionID))
    },
    /** The `prompt` hook: the session is busy again. */
    onPrompt: clear,
    /** The `compaction` hook. */
    onCompaction: clear,
    /** Bind-time pressure probe; deferred until the first settled turn when no user input arrived yet. */
    onBound(bound: BoundMemorySession): void {
      if (closed || deps.isOwnedSession(bound.sessionID)) return
      track(async () => {
        if (!(await deps.pressure(bound)) || closed) return
        if (deps.hasUserActivity(bound.sessionID)) await deps.request(bound, "pressure")
        else deferredPressure.add(bound.sessionID)
      })
    },
    settled,
    async close(): Promise<void> {
      closed = true
      for (const handle of armed.values()) timers.clear(handle)
      armed.clear()
      deferredPressure.clear()
      await settled()
    },
  }
}
