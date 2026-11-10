import { log } from "@oh-my-opencode/utils"

import type { TaskRecord, TaskStatus } from "../state"
import { buildCompletionDetails, buildCompletionMessage } from "./notification"
import { routeCompletion, shouldNotifyRecord } from "./routing"
import type {
  CompletionDetails,
  CompletionDeliverySource,
  CompletionNotifier,
  CompletionNotifierDeps,
  CompletionNotifierStore,
  CompletionRequest,
  DeliveredDecision,
  FlushInput,
  FlushResult,
  NotifyResult,
  ParentNotifier,
  ParentNotifierMessage,
  ParentState,
  ReconcileUnnotifiedNotificationsInput,
  RecordDeliveryFailureInput,
  RoutingDecision,
} from "./types"

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "error", "cancelled", "interrupted", "lost"])
const MAX_SCHEDULED_RETRIES = 8
const RETRY_BASE_MS = 500
const RETRY_MAX_MS = 30_000
const RETRY_JITTER_MS = 200

type BufferedEntry = {
  readonly task_id: string
  readonly epoch: number
  readonly details: CompletionDetails
}

export function createCompletionNotifier(deps: CompletionNotifierDeps): CompletionNotifier {
  if (deps.notifier.enqueueWithSource !== undefined) return createSourceCompletionNotifier(deps)
  const buffered = new Map<string, BufferedEntry[]>()
  const scheduledRetries = new Map<string, () => void>()
  const scheduledRetryCounts = new Map<string, number>()
  const schedule = deps.schedule ?? defaultSchedule
  const getParentState = deps.getParentState ?? (() => ({ kind: "idle" }))
  const getCurrentSessionId = deps.getCurrentSessionId ?? (() => undefined)

  function finishRetryChain(entry: BufferedEntry): void {
    const key = retryKey(entry)
    const cancel = scheduledRetries.get(key)
    scheduledRetries.delete(key)
    scheduledRetryCounts.delete(key)
    cancel?.()
  }

  function scheduleRetry(entry: BufferedEntry): void {
    const key = retryKey(entry)
    if (scheduledRetries.has(key)) return
    const retryNumber = (scheduledRetryCounts.get(key) ?? 0) + 1
    if (retryNumber > MAX_SCHEDULED_RETRIES) {
      // Exhausted the backoff ladder: drop the retry state so it does not leak for the lifetime of
      // the process. A later reconcile or notifyTerminal for the same epoch will restart fresh.
      finishRetryChain(entry)
      return
    }
    scheduledRetryCounts.set(key, retryNumber)
    const cancel = schedule(() => {
      scheduledRetries.delete(key)
      runScheduledRetry(entry)
    }, retryDelay(retryNumber))
    scheduledRetries.set(key, cancel)
  }

  function runScheduledRetry(entry: BufferedEntry): void {
    const fresh = deps.store.load(entry.task_id)
    if (fresh === null) return finishRetryChain(entry)
    if (fresh.notification.run_epoch !== entry.epoch) return finishRetryChain(entry)
    if (!TERMINAL_STATUSES.has(fresh.status)) return finishRetryChain(entry)
    if (!shouldNotifyRecord(fresh)) return finishRetryChain(entry)
    if (fresh.notification.notified_epoch >= entry.epoch) return finishRetryChain(entry)

    const decision = routeCompletion(getParentState())
    if (fresh.parent_session_id !== getCurrentSessionId()) return finishRetryChain(entry)
    if (decision.kind === "buffer") {
      pushBuffered(buffered, fresh.parent_session_id, entry)
      finishRetryChain(entry)
      return
    }

    const delivered = deliverWithRetry(deps.notifier, buildDeliveryMessage([entry.details], decision))
    if (delivered.ok) {
      finishRetryChain(entry)
      persistNotified(deps.store, fresh.task_id, entry.epoch)
      return
    }
    scheduleRetry(entry)
  }

  function deliverRecord(record: TaskRecord, details: CompletionDetails, parentState: ParentState): NotifyResult {
    const entry = { task_id: record.task_id, epoch: record.notification.run_epoch, details }
    const decision = routeCompletion(parentState)
    if (decision.kind === "buffer") {
      pushBuffered(buffered, record.parent_session_id, entry)
      return { kind: "buffered", reason: decision.reason }
    }

    const delivered = deliverWithRetry(deps.notifier, buildDeliveryMessage([details], decision))
    if (delivered.ok) {
      finishRetryChain(entry)
      persistNotified(deps.store, record.task_id, entry.epoch)
      return { kind: "delivered", decision: deliveredDecision(decision) }
    }
    recordFailure(deps.store, record.task_id, entry.epoch, delivered.error)
    scheduleRetry(entry)
    return { kind: "failed" }
  }

  function notifyTerminal(request: CompletionRequest): NotifyResult {
    if (!request.runInBackground) return { kind: "skipped", reason: "sync-task" }
    const record = deps.store.load(request.record.task_id) ?? request.record
    if (!TERMINAL_STATUSES.has(record.status)) return { kind: "skipped", reason: "not-terminal" }
    if (!shouldNotifyRecord(record)) return { kind: "skipped", reason: "non-notifying-terminal" }

    if (record.notification.notified_epoch >= record.notification.run_epoch) {
      return { kind: "skipped", reason: "already-notified" }
    }

    const details = buildDetails(record, request.tokens)
    return deliverRecord(record, details, request.parentState)
  }

  // The omo-senpi adapter enqueues into a shared idle-injection coordinator, so a returning enqueue
  // only means QUEUED: the batched flush can still fail, and a /reload retires the coordinator and
  // hands the whole window back as delivery failures. persistNotified already ran for those records,
  // and reconcileUnnotifiedNotifications skips anything with notified_epoch >= run_epoch - so unless
  // the epoch is rolled back here, a child that finished inside the batch window before a reload is
  // recorded as notified and NO path ever redelivers it. Roll back, stamp the failure (the audit
  // trail), and re-enter the normal retry ladder.
  function recordDeliveryFailure(input: RecordDeliveryFailureInput): void {
    for (const taskId of input.taskIds) {
      const fresh = deps.store.load(taskId)
      if (fresh === null) continue
      if (!TERMINAL_STATUSES.has(fresh.status)) continue
      if (!shouldNotifyRecord(fresh)) continue
      const epoch = fresh.notification.run_epoch
      unpersistNotified(deps.store, taskId, epoch)
      recordFailure(deps.store, taskId, epoch, input.error)
      scheduleRetry({ task_id: taskId, epoch, details: buildDetails(fresh) })
    }
  }

  function flushBuffered(input: FlushInput): FlushResult {
    const entries = buffered.get(input.sessionId)
    if (entries === undefined || entries.length === 0) return { kind: "empty" }
    buffered.delete(input.sessionId)

    if (input.replaced) {
      for (const entry of entries) dropEntry(deps.store, entry)
      return { kind: "dropped", count: entries.length }
    }

    const message: ParentNotifierMessage = {
      ...buildCompletionMessage(entries.map((entry) => entry.details)),
      triggerTurn: true,
    }
    const delivered = deliverWithRetry(deps.notifier, message)
    if (!delivered.ok) {
      for (const entry of entries) recordEntryFailure(deps.store, entry, delivered.error)
      return { kind: "failed", count: entries.length }
    }
    for (const entry of entries) persistEntry(deps.store, entry)
    return { kind: "flushed", count: entries.length }
  }

  function bufferedCount(sessionId: string): number {
    return buffered.get(sessionId)?.length ?? 0
  }

  // Crash recovery: the in-memory buffer dies with the process, so on session start every
  // terminal child of THIS session that still owes a notification goes through the normal
  // delivery path (dedupe identity stays (task_id, run_epoch)). Two populations owe one:
  // (a) notify_on_terminal records whose latest run_epoch was never recorded notified, and
  // (b) legacy pre-upgrade records with an in-flight failed delivery (notification_failed_epoch
  // set) so their retries survive the upgrade.
  function reconcileUnnotifiedNotifications(input: ReconcileUnnotifiedNotificationsInput): void {
    const listed = deps.store.list()
    for (const record of listed.records) {
      const epoch = record.notification.run_epoch
      if (record.parent_session_id !== input.sessionId) continue
      if (record.notification.notified_epoch >= epoch) continue
      if (!TERMINAL_STATUSES.has(record.status)) continue
      if (!shouldNotifyRecord(record)) continue
      if (!owesNotification(record)) continue
      // A LIVE in-memory buffered entry already owns delivery of this (task_id, run_epoch) - the
      // next flush delivers it. Reconcile only recovers notifications whose buffer died with the
      // process; delivering here too would double-notify (chaos inv1).
      if (hasBuffered(buffered, record.parent_session_id, record.task_id, epoch)) continue
      deliverRecord(record, buildDetails(record), input.parentState)
    }
  }

  function owesNotification(record: TaskRecord): boolean {
    return record.notify_on_terminal || record.notification.notification_failed_epoch !== undefined
  }

  function buildDetails(record: TaskRecord, tokens?: number): CompletionDetails {
    return buildCompletionDetails(record, {
      ...(tokens === undefined ? {} : { tokens }),
      ...(deps.stateDir === undefined ? {} : { stateDir: deps.stateDir }),
    })
  }

  return {
    notifyTerminal,
    recordDeliveryFailure,
    flushBuffered,
    reconcileUnnotifiedNotifications,
    reconcileFailedNotifications: reconcileUnnotifiedNotifications,
    bufferedCount,
  }
}

// Every delivered notification stamps triggerTurn:true; the omo-senpi adapter routes it through the
// idle-injection coordinator, which batches ALL ready notifications into ONE injection steered into
// the running turn at the next tool-call boundary (unconditional-steer contract).
function buildDeliveryMessage(
  details: readonly CompletionDetails[],
  decision: Exclude<RoutingDecision, { kind: "buffer" }>,
): ParentNotifierMessage {
  void decision
  const base = buildCompletionMessage(details)
  return { ...base, triggerTurn: true }
}

function deliveredDecision(decision: Exclude<RoutingDecision, { kind: "buffer" }>): DeliveredDecision {
  return decision.kind === "wake" ? "wake" : "deliver_streaming"
}

function defaultSchedule(fn: () => void, delayMs: number): () => void {
  const timer = setTimeout(fn, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

function retryDelay(retryNumber: number): number {
  const exponent = Math.min(retryNumber - 1, 8)
  const backoffMs = RETRY_BASE_MS * 2 ** exponent
  const jitterMs = Math.floor(Math.random() * RETRY_JITTER_MS)
  return Math.min(RETRY_MAX_MS, backoffMs + jitterMs)
}

function retryKey(entry: BufferedEntry): string {
  return `${entry.task_id}:${entry.epoch}`
}

function hasBuffered(buffered: Map<string, BufferedEntry[]>, sessionId: string, taskId: string, epoch: number): boolean {
  return (buffered.get(sessionId) ?? []).some((entry) => entry.task_id === taskId && entry.epoch === epoch)
}

function deliverWithRetry(
  notifier: ParentNotifier,
  message: ParentNotifierMessage,
): { readonly ok: true } | { readonly ok: false; readonly error: unknown } {
  const first = tryEnqueue(notifier, message)
  if (first.ok) return first
  return tryEnqueue(notifier, message)
}

function tryEnqueue(
  notifier: ParentNotifier,
  message: ParentNotifierMessage,
): { readonly ok: true } | { readonly ok: false; readonly error: unknown } {
  try {
    notifier.enqueue(message)
    return { ok: true }
  } catch (error) {
    return { ok: false, error }
  }
}

// W1-V F5: defense-in-depth dedupe. The notified_epoch guard only rejects ALREADY-PERSISTED
// notifications; a buffered entry is not persisted until flush, so two notifyTerminal calls for the
// same terminal (task_id, epoch) before a flush would otherwise buffer - and later deliver - twice.
function pushBuffered(buffered: Map<string, BufferedEntry[]>, sessionId: string, entry: BufferedEntry): void {
  const existing = buffered.get(sessionId) ?? []
  if (existing.some((buffered) => buffered.task_id === entry.task_id && buffered.epoch === entry.epoch)) return
  existing.push(entry)
  buffered.set(sessionId, existing)
}

// Epoch-only bookkeeping: a conditional mutate re-reads fresh inside the record lock and patches
// ONLY the notification epochs, leaving every other field untouched, so a concurrent
// residency/host_pid claim written by reconcile is never clobbered by a stale whole-record replace.
function persistNotified(store: CompletionNotifierStore, taskId: string, epoch: number): void {
  store.mutate(taskId, (fresh) =>
    fresh.notification.notified_epoch >= epoch
      ? fresh
      : { ...fresh, notification: { ...fresh.notification, notified_epoch: epoch } },
  )
}

// Undo an optimistic persistNotified for an epoch that turned out undelivered. Lowering it to
// epoch - 1 (never raising it) is what makes reconcileUnnotifiedNotifications see the record as still
// owing a notification; -1 is the never-notified sentinel, so epoch 0 rolls back to it exactly.
function unpersistNotified(store: CompletionNotifierStore, taskId: string, epoch: number): void {
  store.mutate(taskId, (fresh) =>
    fresh.notification.notified_epoch < epoch
      ? fresh
      : { ...fresh, notification: { ...fresh.notification, notified_epoch: epoch - 1 } },
  )
}

function recordFailure(store: CompletionNotifierStore, taskId: string, epoch: number, error: unknown): void {
  store.appendEvent(taskId, { type: "notification_failed", payload: { epoch, error: String(error) } })
  store.mutate(taskId, (fresh) =>
    fresh.notification.notified_epoch >= epoch || fresh.notification.notification_failed_epoch === epoch
      ? fresh
      : { ...fresh, notification: { ...fresh.notification, notification_failed_epoch: epoch } },
  )
  log("senpi-task completion delivery failed", { taskId, epoch })
}

function persistEntry(store: CompletionNotifierStore, entry: BufferedEntry): void {
  persistNotified(store, entry.task_id, entry.epoch)
}

function recordEntryFailure(store: CompletionNotifierStore, entry: BufferedEntry, error: unknown): void {
  if (store.load(entry.task_id) !== null) recordFailure(store, entry.task_id, entry.epoch, error)
}

function dropEntry(store: CompletionNotifierStore, entry: BufferedEntry): void {
  store.appendEvent(entry.task_id, { type: "notification_dropped", payload: { epoch: entry.epoch } })
  log("senpi-task completion dropped for replaced session", { taskId: entry.task_id, epoch: entry.epoch })
}

// This engine is allocated only for the explicit deferred-source port. The legacy engine above
// retains its original enqueue/optimistic bookkeeping contract and scheduling order.
function createSourceCompletionNotifier(deps: CompletionNotifierDeps): CompletionNotifier {
  type Entry = BufferedEntry & { readonly parent: string; readonly createdAt: string; readonly root: string }
  type Owner = {
    readonly entry: Entry
    readonly decision: DeliveredDecision
    readonly source: CompletionDeliverySource
    readonly attempt: number
    enqueuing: boolean
    disposition?: { readonly kind: "accepted" } | { readonly kind: "failed"; readonly error: unknown }
    mutationDone: boolean
    auditDone: boolean
    settled: boolean
  }
  const pending = new Map<string, Owner>()
  const buffered = new Map<string, { readonly entry: Entry; readonly reason: "compacting" | "session_switching" | "session_shutdown" }>()
  const retries = new Map<string, () => void>()
  const counts = new Map<string, number>()
  let nextAttempt = 0
  const schedule = deps.schedule ?? defaultSchedule
  const key = (entry: Entry): string => JSON.stringify([entry.task_id, entry.epoch, entry.parent])
  const eligible = (record: TaskRecord, entry: Entry): boolean => record.task_id === entry.task_id
    && record.parent_session_id === entry.parent && record.notification.run_epoch === entry.epoch
    && record.created_at === entry.createdAt && record.root_session_id === entry.root
    && TERMINAL_STATUSES.has(record.status) && shouldNotifyRecord(record)
  const fresh = (entry: Entry): TaskRecord | null => {
    const record = deps.store.load(entry.task_id)
    return record !== null && eligible(record, entry) ? record : null
  }
  function detach(entry: Entry): void {
    const id = key(entry), cancel = retries.get(id)
    cancel?.()
    // Keep the exact cleanup handle when cancellation throws. Never pretend it was joined.
    if (retries.get(id) === cancel) retries.delete(id)
  }
  function finish(entry: Entry): void { detach(entry); counts.delete(key(entry)) }
  function active(owner: Owner): boolean { return pending.get(key(owner.entry)) === owner && !owner.settled }
  function release(owner: Owner, accepted: boolean): void {
    if (!active(owner)) return
    pending.delete(key(owner.entry))
    owner.settled = true
    if (accepted) finish(owner.entry)
  }
  function retry(entry: Entry): void {
    const id = key(entry)
    if (pending.has(id) || retries.has(id)) return
    const count = (counts.get(id) ?? 0) + 1
    if (count > MAX_SCHEDULED_RETRIES) { finish(entry); return }
    counts.set(id, count)
    retries.set(id, schedule(() => {
      retries.delete(id)
      if (pending.has(id)) return
      const record = fresh(entry)
      if (record === null || record.notification.notified_epoch >= entry.epoch
        || entry.parent !== deps.getCurrentSessionId?.()) { finish(entry); return }
      deliver(entry, deps.getParentState?.() ?? { kind: "idle" })
    }, retryDelay(count)))
  }
  function settle(owner: Owner): void {
    if (!active(owner) || owner.enqueuing || owner.disposition === undefined) return
    const entry = owner.entry
    if (owner.disposition.kind === "accepted") {
      // Latch accepted BEFORE I/O. Even a physical write followed by throw retains this owner.
      deps.store.mutate(entry.task_id, record => {
        if (!active(owner) || !eligible(record, entry)) return record
        return record.notification.notified_epoch >= entry.epoch ? record
          : { ...record, notification: { ...record.notification, notified_epoch: entry.epoch } }
      })
      release(owner, true)
      return
    }
    if (!owner.mutationDone) {
      let stamped = false
      deps.store.mutate(entry.task_id, record => {
        if (!active(owner) || !eligible(record, entry) || record.notification.notified_epoch >= entry.epoch) return record
        stamped = true
        return record.notification.notification_failed_epoch === entry.epoch ? record
          : { ...record, notification: { ...record.notification, notification_failed_epoch: entry.epoch } }
      })
      if (!stamped) { release(owner, true); return }
      owner.mutationDone = true
    }
    if (!owner.auditDone) {
      // Audit is a separate, retained historical obligation, not an atomic delivery journal.
      // A newer epoch/parent does not erase historical audit custody. Do not recreate a removed
      // task log, or attach history to a detectably replaced task. This store has no incarnation
      // token: identical-ID/created_at/root delete-and-recreate is not observable through this port.
      const error = owner.disposition.error
      deps.store.mutate(entry.task_id, record => {
        if (!active(owner) || record.task_id !== entry.task_id
          || record.created_at !== entry.createdAt || record.root_session_id !== entry.root) return record
        // Read-only use of the SAME FileStore lock as remove/tombstone; returning this exact object
        // skips writeRecord. A separate load followed by append could recreate a concurrently removed log.
        deps.store.appendEvent(entry.task_id, { type: "notification_failed", payload: {
          epoch: entry.epoch, parent_session_id: entry.parent, attempt: owner.attempt, error: String(error),
        } })
        owner.auditDone = true // Actual append returned, even if later cache/lock return throws.
        return record
      })
      if (!owner.auditDone) throw new Error("Completion failure audit remains pending for removed or replaced source")
    }
    const record = fresh(entry)
    release(owner, false)
    if (record === null || record.notification.notified_epoch >= entry.epoch) finish(entry)
    else retry(entry)
  }
  function reserve(entry: Entry, decision: DeliveredDecision): Owner | undefined {
    const id = key(entry)
    // Every reservation rechecks custody, including after earlier cleanup callbacks reentered.
    if (pending.has(id)) return undefined
    let owner: Owner
    const source: CompletionDeliverySource = Object.freeze({
      taskId: entry.task_id, runEpoch: entry.epoch, parentSessionId: entry.parent,
      accepted: () => {
        if (!active(owner) || owner.disposition?.kind === "failed") return
        owner.disposition ??= { kind: "accepted" }
        settle(owner)
      },
      notDelivered: (error: unknown) => {
        if (!active(owner) || owner.disposition?.kind === "accepted") return
        owner.disposition ??= { kind: "failed", error }
        settle(owner)
      },
    })
    owner = { entry, decision, source, attempt: ++nextAttempt, enqueuing: true, mutationDone: false, auditDone: false, settled: false }
    pending.set(id, owner)
    return owner
  }
  type Dispatch = { readonly count: number; readonly pending: boolean; readonly failed: boolean }
  function dispatch(entries: readonly Entry[], message: ParentNotifierMessage, decision: DeliveredDecision): Dispatch {
    let candidates = [...entries]
    let currentMessage = message
    function select(next: Entry[]): void {
      if (next.length !== candidates.length) currentMessage = { ...buildCompletionMessage(next.map(entry => entry.details)), triggerTurn: true }
      candidates = next
    }
    function revalidate(owners: readonly Owner[] = []): void {
      const next = candidates.filter(entry => {
        const ours = (): boolean => { const owner = pending.get(key(entry)); return owner === undefined || owners.includes(owner) }
        if (!ours()) return false // Never finish, delete or replace another dispatch's custody.
        const record = fresh(entry)
        if (!ours()) return false
        if (record !== null && record.notification.notified_epoch < entry.epoch) return true
        if (!pending.has(key(entry))) { finish(entry); buffered.delete(key(entry)) }
        return false
      })
      select(next)
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      // A definitive host refusal may synchronously advance epoch/parent. Attempt2 is a NEW
      // handoff, not permission to reuse obsolete provenance from before that callback.
      revalidate()
      if (candidates.length === 0) return { count: 0, pending: false, failed: true }
      const owners: Owner[] = []
      try {
        // Reserve the ENTIRE batch before any cancellation callback can reenter. Reserving only
        // the first slot would let a nested flush hand off the still-unreserved remainder.
        for (const entry of candidates) { const owner = reserve(entry, decision); if (owner !== undefined) owners.push(owner) }
        select(owners.map(owner => owner.entry))
        for (const owner of owners) detach(owner.entry)
      }
      catch (error) {
        // No source reached the host; retry the retained failed cleanup handle next time.
        for (const owner of owners) release(owner, false)
        throw error
      }
      // Custom cancellation callbacks may also change the actual store before submission.
      revalidate(owners)
      const sending = owners.filter(owner => candidates.includes(owner.entry))
      for (const owner of owners) {
        if (!sending.includes(owner)) release(owner, true)
        buffered.delete(key(owner.entry))
      }
      if (sending.length === 0) return { count: 0, pending: false, failed: true }
      let threw = false, failure: unknown
      try { deps.notifier.enqueueWithSource!(currentMessage, sending.map(owner => owner.source)) }
      catch (error) { threw = true; failure = error }
      for (const owner of sending) owner.enqueuing = false
      if (threw && sending.every(owner => owner.disposition === undefined)) {
        if (attempt === 0) {
          for (const owner of sending) release(owner, false)
          continue
        }
        for (const owner of sending) owner.source.notDelivered(failure)
        return { count: sending.length, pending: sending.some(active), failed: true }
      }
      // Drain outside the host catch: bookkeeping exceptions NEVER cause another submission.
      for (const owner of sending) settle(owner)
      if (threw) throw failure // Contract violation after receipt; retain disposition, no resend.
      return { count: sending.length, pending: sending.some(active),
        failed: sending.some(owner => owner.disposition?.kind === "failed") }
    }
    throw new Error("Unreachable completion dispatch")
  }
  function entryOf(record: TaskRecord, tokens?: number): Entry {
    return { task_id: record.task_id, epoch: record.notification.run_epoch, parent: record.parent_session_id,
      createdAt: record.created_at, root: record.root_session_id,
      details: buildCompletionDetails(record, { ...(tokens === undefined ? {} : { tokens }),
        ...(deps.stateDir === undefined ? {} : { stateDir: deps.stateDir }) }) }
  }
  function custody(record: TaskRecord): NotifyResult | undefined {
    const id = JSON.stringify([record.task_id, record.notification.run_epoch, record.parent_session_id])
    const owner = pending.get(id)
    if (owner !== undefined) return { kind: "pending", decision: owner.decision }
    const held = buffered.get(id)
    if (held !== undefined) return { kind: "buffered", reason: held.reason }
    return undefined
  }
  function deliver(entry: Entry, parentState: ParentState): NotifyResult {
    const record = fresh(entry)
    if (record === null) { finish(entry); return { kind: "failed" } }
    const held = custody(record)
    if (held !== undefined) return held
    if (record.notification.notified_epoch >= entry.epoch) { finish(entry); return { kind: "skipped", reason: "already-notified" } }
    const decision = routeCompletion(parentState)
    if (decision.kind === "buffer") {
      detach(entry)
      buffered.set(key(entry), { entry, reason: decision.reason })
      return { kind: "buffered", reason: decision.reason }
    }
    const result = dispatch([entry], buildDeliveryMessage([entry.details], decision), deliveredDecision(decision))
    return result.pending ? { kind: "pending", decision: deliveredDecision(decision) }
      : result.failed ? { kind: "failed" } : { kind: "delivered", decision: deliveredDecision(decision) }
  }
  function notifyTerminal(request: CompletionRequest): NotifyResult {
    // The request snapshot may locate retained bookkeeping after removal, never issue new actuation.
    const record = deps.store.load(request.record.task_id)
    const held = custody(record ?? request.record)
    if (held !== undefined) return held
    if (!request.runInBackground) return { kind: "skipped", reason: "sync-task" }
    if (record === null) return { kind: "failed" }
    if (!TERMINAL_STATUSES.has(record.status)) return { kind: "skipped", reason: "not-terminal" }
    if (!shouldNotifyRecord(record)) return { kind: "skipped", reason: "non-notifying-terminal" }
    if (record.notification.notified_epoch >= record.notification.run_epoch) return { kind: "skipped", reason: "already-notified" }
    return deliver(entryOf(record, request.tokens), request.parentState)
  }
  function flushBuffered(input: FlushInput): FlushResult {
    const held = [...buffered.values()].filter(item => item.entry.parent === input.sessionId && !pending.has(key(item.entry)))
    if (held.length === 0) return { kind: "empty" }
    if (input.replaced) {
      for (const item of held) {
        if (fresh(item.entry) !== null) dropEntry(deps.store, item.entry)
        buffered.delete(key(item.entry)) // Only after required bookkeeping completes.
        finish(item.entry)
      }
      return { kind: "dropped", count: held.length }
    }
    const entries = held.filter(item => {
      if (pending.has(key(item.entry))) return false // Reentrant flush must not replace custody.
      const record = fresh(item.entry)
      if (record !== null && record.notification.notified_epoch < item.entry.epoch) return true
      buffered.delete(key(item.entry)); finish(item.entry)
      return false
    }).map(item => item.entry)
    if (entries.length === 0) return { kind: "empty" }
    // reserve() occurs synchronously before host entry; remove buffered ownership only in that entry
    // handoff, without allowing an observable reentrant ownership gap.
    const message: ParentNotifierMessage = { ...buildCompletionMessage(entries.map(entry => entry.details)), triggerTurn: true }
    const result = dispatch(entries, message, "wake")
    if (result.count === 0) return { kind: "empty" }
    return { kind: result.pending ? "pending" : result.failed ? "failed" : "flushed", count: result.count }
  }
  function reconcileUnnotifiedNotifications(input: ReconcileUnnotifiedNotificationsInput): void {
    for (const record of deps.store.list().records) {
      if (record.parent_session_id !== input.sessionId) continue
      if (custody(record) !== undefined) continue
      if (record.notification.notified_epoch >= record.notification.run_epoch || !TERMINAL_STATUSES.has(record.status)
        || !shouldNotifyRecord(record) || !(record.notify_on_terminal || record.notification.notification_failed_epoch !== undefined)) continue
      deliver(entryOf(record), input.parentState)
    }
  }
  return { notifyTerminal, flushBuffered, reconcileUnnotifiedNotifications,
    reconcileFailedNotifications: reconcileUnnotifiedNotifications,
    // Retained solely for compatibility; source-aware hosts must settle their exact receipt instead.
    recordDeliveryFailure: () => { throw new Error("Deferred completion delivery requires its issued source receipt") },
    bufferedCount: sessionId => [...buffered.values()].filter(item => item.entry.parent === sessionId).length }
}
