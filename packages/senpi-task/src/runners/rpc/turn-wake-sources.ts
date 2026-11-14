// Wake sources a child's own session lifecycle publishes as raw `extension_event` records on the
// handle-level event stream of both runners (senpi#3208 emits them through `pi.rpc.emit`, so they
// never touch the permission-shaped extension channel). A turn that ended on a terminal provider
// error is only "terminal with no live continuation" when none of these owns the session: a goal's
// recovery timer (`goal_continuation_timer_state`) or a terminal monitor's live watches
// (`terminal_monitor_state` / `terminal_monitor_ended`). Lifetimes differ: goal timers belong to
// the turn that armed them and are cleared when a new turn begins (`resetTurn`); terminal monitors
// live for the whole session, so only the engine's own state records (a zero-count snapshot, a
// monitor-ended notice) clear them - a monitor armed in an earlier turn still protects a later one.

import { createWakeSourceLedger } from "../turn-settlement-core"

export type TurnWakeSources = {
  readonly observe: (record: unknown) => void
  readonly hasLiveWakeSources: () => boolean
  /** A new turn began: goal timers belonged to the turn that armed them. Session-lifetime sources (terminal monitors) survive. */
  readonly resetTurn: () => void
}

type WakeSourceRecord = { readonly name?: unknown; readonly data?: unknown }

function asWakeSourceRecord(record: unknown): WakeSourceRecord | undefined {
  if (typeof record !== "object" || record === null) return undefined
  return record as WakeSourceRecord
}

function isExtensionEventNamed(record: WakeSourceRecord, name: string): boolean {
  return record.name === name
}

function goalTimerKind(data: unknown): { readonly armed: boolean; readonly kind: string } | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const armed = (data as { readonly armed?: unknown }).armed
  if (typeof armed !== "boolean") return undefined
  const kind = (data as { readonly kind?: unknown }).kind
  return { armed, kind: typeof kind === "string" && kind.length > 0 ? kind : "" }
}

function monitorActiveCount(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const count = (data as { readonly activeCount?: unknown }).activeCount
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : undefined
}

export function createTurnWakeSources(): TurnWakeSources {
  // Goal continuation timers are turn-scoped, one entry per ARMED kind (`monitor`, `userGrace`,
  // senpi#3319's `providerRetry`, ...): an armed timer of ANY kind is a live wake, and an
  // `armed: false` clears only its own kind so a stale disarm never cancels a timer another kind
  // still holds. Terminal monitor watches are session-scoped.
  const ledger = createWakeSourceLedger()

  const trackMonitorSnapshot = (data: unknown): void => {
    const count = monitorActiveCount(data)
    if (count === undefined) return
    if (count === 0) {
      ledger.replaceSession([])
      return
    }
    const items =
      typeof data === "object" && data !== null ? (data as { readonly monitors?: unknown }).monitors : undefined
    if (!Array.isArray(items)) return
    const seen: string[] = []
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue
      const id = (item as { readonly id?: unknown }).id
      if (typeof id === "string" && id.length > 0) seen.push(id)
    }
    ledger.replaceSession(seen)
  }

  return {
    observe(record) {
      const event = asWakeSourceRecord(record)
      if (event === undefined || typeof event.name !== "string") return
      if (isExtensionEventNamed(event, "goal_continuation_timer_state")) {
        const timer = goalTimerKind(event.data)
        if (timer !== undefined) {
          if (timer.armed) ledger.armTurn(timer.kind)
          else ledger.disarmTurn(timer.kind)
        }
        return
      }
      if (isExtensionEventNamed(event, "terminal_monitor_state")) {
        trackMonitorSnapshot(event.data)
        return
      }
      if (isExtensionEventNamed(event, "terminal_monitor_ended")) {
        const id =
          typeof event.data === "object" && event.data !== null
            ? (event.data as { readonly id?: unknown }).id
            : undefined
        if (typeof id === "string") ledger.endSession(id)
      }
    },
    hasLiveWakeSources: ledger.hasLive,
    resetTurn: ledger.resetTurn,
  }
}
