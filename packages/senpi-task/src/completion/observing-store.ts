import type { CompletionNotifier, ParentState } from "./types"
import type { TaskRecord, TaskStatus, TaskTransition } from "../state/types"
import type { TaskRecordStore } from "../store/types"

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "error",
  "cancelled",
  "interrupted",
  "lost",
])

export interface CompletionBridgeDeps {
  readonly notifier: CompletionNotifier
  readonly parentState: () => ParentState
  readonly wasBackground: (taskId: string) => boolean
  readonly onTerminal?: (record: TaskRecord) => void
  /** Optional synchronous post-write channel policy, never actuation authority. */
  readonly ownsTerminal?: (record: TaskRecord) => boolean
  /** Unknown parent state/acceptance holds notification only; owned liveness still runs. */
  readonly notificationReady?: (record: TaskRecord) => boolean
  /**
   * The session this engine currently serves. A reconcile also marks OTHER sessions' crashed children
   * lost; only a child of this session may be notified here, or its own parent would never hear of it
   * (its notification would already be spent on the wrong session). Unknown means no lost notification.
   */
  readonly currentSessionId?: () => string | undefined
}

/**
 * W1-V F7: completion notification is driven by the STORE's terminal transition, never raw agent_end.
 * Wrap the store so that whenever a transition APPLIES a terminal status, notifyTerminal fires once
 * for that record. Reconciliation's `lost` mutation is intercepted too: bounded background
 * revival can finish after session_start's notification recovery has already returned.
 * Notification bookkeeping on an already-terminal record never creates another status edge.
 */
export function createCompletionObservingStore(backing: TaskRecordStore, deps: CompletionBridgeDeps): TaskRecordStore {
  function guardedTerminal(record: TaskRecord, taskId: string): void {
    const check = (predicate: (record: TaskRecord) => boolean): boolean => {
      const result: unknown = predicate.call(deps, record)
      if (typeof result !== "boolean") {
        // Retain the actual invalid value for its HOST owner. A synchronous store cannot
        // join an invalid asynchronous producer, and never awaits/coerces/detaches it.
        throw new TypeError("Terminal predicate must return a synchronous boolean", { cause: result })
      }
      return result
    }
    const owns = () => deps.ownsTerminal === undefined || check(deps.ownsTerminal)
    const ready = () => deps.notificationReady === undefined || check(deps.notificationReady)
    if (!owns()) return
    if (ready() && owns() && ready() && owns()) {
      const parentState = deps.parentState()
      const runInBackground = deps.wasBackground(taskId)
      if (owns() && ready() && owns()) deps.notifier.notifyTerminal({ record, parentState, runInBackground })
    }
    // Readiness/notifier callbacks may revoke this channel. Never use a cached true
    // ownership decision for a later effect; nested rows have independent locals.
    if (owns()) deps.onTerminal?.(record)
  }
  return {
    stateDir: backing.stateDir,
    save: (record) => backing.save(record),
    replace: (record) => backing.replace(record),
    mutate: (taskId, mutation) => {
      let becameTerminal = false
      const record = backing.mutate(taskId, (fresh) => {
        const next = mutation(fresh)
        // A fenced fail (a start the task host refused after the caller stopped waiting, #10042) ends
        // a run through mutate, not transition; the notifier's epoch fence keeps every edge exactly-once.
        becameTerminal = (TERMINAL_STATUSES.has(next.status) && !TERMINAL_STATUSES.has(fresh.status)
          && next.notification.run_epoch >= fresh.notification.run_epoch)
          || (TERMINAL_STATUSES.has(next.status) && next.notification.run_epoch > fresh.notification.run_epoch)
        return next
      })
      if (becameTerminal && record !== null && record.parent_session_id === deps.currentSessionId?.()) {
        if (deps.ownsTerminal !== undefined || deps.notificationReady !== undefined) guardedTerminal(record, taskId)
        else {
        deps.notifier.notifyTerminal({
          record,
          parentState: deps.parentState(),
          runInBackground: deps.wasBackground(taskId),
        })
        deps.onTerminal?.(record)
        }
      }
      return record
    },
    load: (taskId) => backing.load(taskId),
    list: () => backing.list(),
    appendEvent: (taskId, event) => backing.appendEvent(taskId, event),
    remove: (taskId) => backing.remove(taskId),
    transition: (taskId, transition) => {
      const result = backing.transition(taskId, transition)
      if (isTerminalApplied(result.applied, result.record.status, transition)) {
        if (deps.ownsTerminal !== undefined || deps.notificationReady !== undefined) guardedTerminal(result.record, taskId)
        else {
        deps.notifier.notifyTerminal({
          record: result.record,
          parentState: deps.parentState(),
          runInBackground: deps.wasBackground(taskId),
        })
        deps.onTerminal?.(result.record)
        }
      }
      return result
    },
    // TTL expunge is not a terminal transition - forward the two-phase store surface untouched so
    // lifecycle.cleanupExpiredRecords works through the wrapper (no notify on tombstone/expunge).
    tombstoneIfExpired: (taskId, shouldRetain, owner) => backing.tombstoneIfExpired(taskId, shouldRetain, owner),
    completeExpunge: (taskId, owner) => backing.completeExpunge(taskId, owner),
    listExpunging: () => backing.listExpunging(),
    loadExpunging: (taskId) => backing.loadExpunging(taskId),
    restoreExpunging: (taskId, owner) => backing.restoreExpunging(taskId, owner),
    readExpungeOwner: (taskId) => backing.readExpungeOwner(taskId),
    takeOverExpunging: (taskId, from, to) => backing.takeOverExpunging(taskId, from, to),
  }
}

function isTerminalApplied(applied: boolean, status: TaskStatus, transition: TaskTransition): boolean {
  // Residency bookkeeping transitions (evict/dispose/...) also touch terminal records but must not
  // re-notify; only the status-reaching transitions count.
  const statusChanging = transition.type === "complete" || transition.type === "fail" || transition.type === "cancel" || transition.type === "interrupt" || transition.type === "lose"
  return applied && statusChanging && TERMINAL_STATUSES.has(status)
}
