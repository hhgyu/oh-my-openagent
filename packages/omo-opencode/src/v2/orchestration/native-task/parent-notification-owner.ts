import { randomUUID } from "node:crypto"
import { buildCompletionMessage, shouldNotifyRecord } from "@oh-my-opencode/senpi-task/task-operations"
// Narrow temporary pure support edge: SAME canonical formatter already loaded by notifier.
import { createCompletionNotifier, IdleInjectionCoordinator, type CompletionDeliverySource, type ParentNotifierMessage, type AdmissionItem, type IdleInjectionMessage } from "@oh-my-opencode/senpi-task/task-operations"
import type { TaskRecord, TaskRecordStore, TaskManager } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { CompletionIntentEnvelope, CompletionIntentJournal, CompletionIntent, CompletionLogicalSource } from "../../host/completion-intent-journal"
import type { OwnedTaskHost } from "./owned-runner"
import type { SessionBackendApi } from "../../host/session-backend"
import type { createParentBindings, VerifiedParentBinding } from "./parent-binding"
import type { createParentNotificationAuthorityIssuer, AcceptedNotificationTask } from "./parent-notification-authority"
import type { ParentCompletionChannel } from "./completion-store"

export interface ParentNotificationOwnerHost {
  readonly session: Pick<OwnedTaskHost["session"], "hook" | "synthetic" | "wait"> & Pick<SessionBackendApi, "get">
  readonly tool: Pick<OwnedTaskHost["tool"], "hook">
  readonly event: OwnedTaskHost["event"]
}
export interface ParentNotificationOwnerOptions {
  readonly ctx: ParentNotificationOwnerHost
  readonly baseStore: TaskRecordStore
  readonly stateDir: string
  readonly bindings: ReturnType<typeof createParentBindings>
  readonly binding: VerifiedParentBinding
  readonly issuer: ReturnType<typeof createParentNotificationAuthorityIssuer>
  readonly journal: CompletionIntentJournal
  readonly receiver: CompletionIntentEnvelope["receiver"]
  readonly taskFor: (record: TaskRecord) => AcceptedNotificationTask | undefined
  readonly ownsTerminal: (record: TaskRecord) => boolean
  readonly wasBackground: TaskManager["wasBackground"]
  readonly registerSource: (source: CompletionDeliverySource) => void
  readonly onTerminal?: (record: TaskRecord) => void
}
export interface ParentNotificationOwner {
  readonly channel: ParentCompletionChannel
  initialize(): Promise<void>
  requestReconcile(): void
  stop(): void
  join(): Promise<void>
  close(): Promise<void>
  diagnostics(): Readonly<Record<string, unknown>>
}

type WireJson = null | boolean | number | string | WireJson[] | { [key: string]: WireJson }
/** Project a wire value without stringify coercion. Only optional OBJECT undefined is omitted. */
function wire(value: unknown, ancestors = new Set<object>(), depth = 0, budget = { nodes: 0, characters: 0 }): WireJson {
  if (depth > 24 || ++budget.nodes > 50_000) throw Error("Completion wire nesting/node limit")
  if (typeof value === "string") { if ((budget.characters += value.length) > 2_097_152) throw Error("Completion wire size limit"); return value }
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "object" || ancestors.has(value)) throw Error("Unsupported completion wire value")
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw Error("Unsupported completion wire prototype")
  ancestors.add(value)
  try {
    const result: { [key: string]: WireJson } = {}
    if (Array.isArray(value)) {
      if (value.length > 50_000 || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) throw Error("Unsupported completion wire array")
      const array: WireJson[] = []
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (!descriptor || !("value" in descriptor)) throw Error("Completion wire getter/hole")
        array.push(wire(descriptor.value, ancestors, depth + 1, budget))
      }
      return array
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || key.length > 4096 || ["__proto__", "prototype", "constructor"].includes(key)) throw Error("Unsupported completion wire key")
      if ((budget.characters += key.length) > 2_097_152) throw Error("Completion wire key size limit")
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw Error("Completion wire descriptor")
      if (descriptor.value !== undefined) result[key] = wire(descriptor.value, ancestors, depth + 1, budget)
    }
    return result
  } finally { ancestors.delete(value) }
}
type RunBinding = Awaited<ReturnType<ParentNotificationOwnerOptions["issuer"]["bindCurrentOwnedRun"]>>
type WorkKind = "initialize" | "hook" | "prepare" | "transport" | "receipt" | "batch" | "wake-wait" | "wake-flush"
type Prepared = { task: AcceptedNotificationTask; epoch: number; run: RunBinding }
type Member = { source: CompletionDeliverySource; logical: CompletionLogicalSource; task: AcceptedNotificationTask; run: RunBinding }
type Item = { id: string; key: string; message: ParentNotifierMessage; members: Member[];
  state: "queued" | "flushing" | "accepted" | "uncertain" | "failed" | "held"; invoked: boolean;
  intent?: CompletionIntent; ack?: { id: string; sessionID: string }; error?: unknown; needsRepair: boolean;
  callback?: PromiseWithResolvers<void>; callbacksJoined?: boolean; superseded?: Item }

/** Complete private receiving owner. Transport acceptance is NOT model consumption.
 * Shared journals/base stores and receiving bindings are closed by runtime AFTER this owner. */
export function createParentNotificationOwner(options: ParentNotificationOwnerOptions): ParentNotificationOwner {
  const receiver = Object.freeze({ ...options.receiver }), pending = new Map<Promise<unknown>, WorkKind>()
  const prepared = new Map<string, Prepared>(), items = new Map<string, Item>(), byKey = new Map<string, Item>()
  const sourceOwners = new WeakMap<CompletionDeliverySource, Item>(), history: { kind: string; error: unknown }[] = []
  const intentSources = new Map<string, Set<CompletionDeliverySource>>(), settledSources = new WeakSet<CompletionDeliverySource>()
  const registrations: { registration: { dispose(): Promise<void> }; disposed: boolean }[] = []
  const subscriptionStop = new AbortController(), transportStop = new AbortController(), wakeStop = new AbortController()
  const retries = new Set<{ callback: () => void; timer?: ReturnType<typeof setTimeout>; due: boolean }>()
  const batches = new Set<ReturnType<typeof setTimeout>>()
  let stopped = false, closed = false, initialized = false, initializing: Promise<void> | undefined, closing: Promise<void> | undefined
  let pump: Promise<void> | undefined, preparation: Promise<void> | undefined, dirty = true, activity = 0, childWork = 0, streamAlive = false
  let wakeWork: Promise<void> | undefined, wakeRequested = false, compacting = false
  let wakeController: AbortController | undefined
  let edge: { kind: "idle" | "streaming"; origin: "hook" | "public-quiescence"; epoch: number; open: boolean } | undefined
  let hookTail: Promise<void> = Promise.resolve()
  const note = (kind: string, error: unknown) => { history.push({ kind, error }) }
  function own<T>(kind: WorkKind, body: () => T | Promise<T>): Promise<T> {
    const promise = Promise.resolve().then(body)
    pending.set(promise, kind)
    void promise.then(() => pending.delete(promise), error => { note(kind, error); pending.delete(promise) })
    return promise
  }
  function known() { return !stopped && !compacting && streamAlive && edge?.open === true && edge.epoch === activity }
  function state() { if (!known() || !edge) throw Error("No current actual receiving window"); return { kind: edge.kind } }
  function current() {
    if (stopped) throw Error("Notification owner stopped")
    const parent = options.bindings.info(options.binding)
    if (options.bindings.get(receiver.sessionID) !== options.binding || parent.lease.sessionID !== receiver.sessionID
      || parent.rootSessionId !== receiver.rootSessionID || parent.lease.generation !== receiver.leaseGeneration) throw Error("Original notification receiver changed")
  }
  function ready(row: TaskRecord) {
    const value = prepared.get(row.task_id)
    return !!value && value.epoch === row.notification.run_epoch && options.taskFor(row) === value.task
      && row.parent_session_id === receiver.sessionID && row.root_session_id === receiver.rootSessionID
  }
  function ownsTerminal(row: TaskRecord) {
    const value: unknown = options.ownsTerminal(row)
    if (typeof value !== "boolean") throw new TypeError("Notification ownership must be synchronous boolean", { cause: value })
    return value
  }
  async function drain(windowOnly = false) {
    for (;;) {
      // Public parent wait can require this very hook to return. It and the
      // serialized wake window are joined by whole-owner close, never by a hook.
      const actual = [...pending].filter(([, kind]) => !windowOnly || !["hook", "initialize", "wake-wait", "wake-flush"].includes(kind)).map(([promise]) => promise)
      if (!actual.length) return
      await Promise.allSettled(actual)
    }
  }
  async function prepare() {
    if (stopped) return
    const seen = new Set<string>()
    for (const row of options.baseStore.list().records) {
      if (row.parent_session_id !== receiver.sessionID || row.root_session_id !== receiver.rootSessionID) continue
      seen.add(row.task_id)
      const task = options.taskFor(row), epoch = row.notification.run_epoch
      if (!task) { prepared.delete(row.task_id); continue }
      try {
        if (!ownsTerminal(row)) { prepared.delete(row.task_id); continue }
        const run = await options.issuer.bindCurrentOwnedRun(task), fresh = options.baseStore.load(row.task_id)
        if (stopped || !fresh || options.taskFor(fresh) !== task || fresh.notification.run_epoch !== epoch || !ownsTerminal(fresh)) continue
        prepared.set(row.task_id, { task, epoch, run })
      } catch (error) { prepared.delete(row.task_id); note("source-held", error) }
    }
    for (const id of prepared.keys()) if (!seen.has(id)) prepared.delete(id)
  }
  function requestReconcile() {
    dirty = true; wakeRequested = true
    if (stopped || preparation) return
    const work = own("prepare", prepare)
    preparation = work
    void work.finally(() => { if (preparation === work) preparation = undefined; startWakeIfRequested() }).catch(() => {})
  }
  function hasWakeCandidate() {
    return [...items.values()].some(item => item.needsRepair) || options.baseStore.list().records.some(row =>
      row.parent_session_id === receiver.sessionID && row.root_session_id === receiver.rootSessionID && options.taskFor(row)
      && shouldNotifyRecord(row) && (row.notify_on_terminal || row.notification.notification_failed_epoch !== undefined)
      && row.notification.notified_epoch < row.notification.run_epoch)
  }
  function startWakeIfRequested() {
    if (stopped || compacting || !initialized || !streamAlive || !wakeRequested || wakeWork || edge?.open) return
    // A due ORIGINAL Native retry already owns its candidate. Do not touch the
    // store on its timer edge before a fresh public observation has succeeded.
    if (![...retries].some(entry => entry.due) && !hasWakeCandidate()) { wakeRequested = false; return }
    wakeRequested = false
    const controller = new AbortController(), signal = AbortSignal.any([wakeStop.signal, controller.signal])
    wakeController = controller
    // own() reserves physical work before any original public request starts.
    const work = own("wake-wait", async () => {
      let epoch: number
      try {
        current(); signal.throwIfAborted()
        await options.ctx.session.wait({ sessionID: receiver.sessionID }, { signal })
        current(); signal.throwIfAborted()
        if (compacting) return
        // Busy-to-idle progress before wait resolves is expected. Only changes
        // after that observation can invalidate the following identity query.
        epoch = activity
        const actual = await options.ctx.session.get({ sessionID: receiver.sessionID }, { signal })
        current(); signal.throwIfAborted()
        if (compacting) return
        if (actual.id !== receiver.sessionID || actual.location.directory !== receiver.directory
          || receiver.sessionID === receiver.rootSessionID && actual.parentID !== undefined) throw Error("Fresh receiving identity differs")
        if (!streamAlive) return
        if (epoch !== activity) { wakeRequested = true; return }
      } catch (error) {
        // Cancellation retires readonly work, not a transport or its receipt.
        // The ORIGINAL request has settled before this handler can run.
        if (signal.aborted && Object.is(error, signal.reason)) return
        throw error
      }
      await window("idle", receiver.sessionID, epoch, signal)
    })
    wakeWork = work
    void work.finally(() => { if (wakeWork === work) { wakeWork = undefined; wakeController = undefined }; startWakeIfRequested() }).catch(() => {})
  }
  function reason(error: unknown) { return (error instanceof Error ? error.message || error.name : String(error)).slice(0, 4096) || "notification failure" }
  function stableReceiver(actual: CompletionIntent["receiver"]) {
    return actual.sessionID === receiver.sessionID && actual.rootSessionID === receiver.rootSessionID && actual.backendID === receiver.backendID
      && actual.directory === receiver.directory && actual.hostVersion === receiver.hostVersion
  }
  function write(item: Item, phase: CompletionIntent["phase"], bookkeeping: CompletionIntent["bookkeeping"] = "pending") {
    if (!item.intent) throw Error("Notification durable intent missing")
    const previous = options.journal.read(item.intent.intentID)
    if (!previous || previous.owner !== options.journal.owner || !stableReceiver(previous.receiver)) throw Error("Notification journal custody changed")
    if (previous.phase === phase && (previous.bookkeeping === bookkeeping || previous.bookkeeping === "complete")) { item.intent = previous; return }
    const { reason: _reason, acceptance: _acceptance, ...base } = previous
    const ack = item.ack
    if (phase === "accepted" && !ack) throw Error("Notification accepted phase has no synthetic ACK")
    const next: CompletionIntent = { ...base, revision: previous.revision + 1, phase, bookkeeping,
      ...(phase === "accepted" && ack ? { acceptance: { kind: "synthetic" as const, id: ack.id, sessionID: ack.sessionID } } : {}),
      ...(phase === "uncertain" || phase === "definitively_failed" ? { reason: reason(item.error) } : {}),
    }
    options.journal.writeSync(previous, next)
    item.intent = options.journal.read(previous.intentID)
  }
  function acceptedBookkeepingComplete(item: Item) {
    if (!item.intent) return false
    // Historical envelope membership is immutable. A subset receipt cannot declare
    // another still-unspent source complete, even when no new transport is required.
    return item.intent.sources.every(source => {
      const row = options.baseStore.load(source.taskId)
      if (!row || row.created_at !== source.createdAt || row.parent_session_id !== source.parentSessionId
        || row.root_session_id !== source.rootSessionId) return false
      return row.notification.run_epoch > source.nativeEpoch
        || row.notification.run_epoch === source.nativeEpoch && row.notification.notified_epoch >= source.nativeEpoch
    })
  }
  function logicalKey(source: CompletionLogicalSource) {
    return JSON.stringify([source.taskId, source.nativeEpoch, source.parentSessionId, source.rootSessionId, source.createdAt])
  }
  async function repair(item: Item) {
    if (item.state === "accepted") {
      if (!item.ack) throw Error("Original notification ACK not retained")
      write(item, "accepted")
      for (const member of item.members) { member.source.accepted(); settledSources.add(member.source) }
      if (acceptedBookkeepingComplete(item)) write(item, "accepted", "complete")
    } else if (item.state === "failed") {
      if (item.intent) write(item, "definitively_failed")
      for (const member of item.members) { member.source.notDelivered(item.error); settledSources.add(member.source) }
      if (item.intent && [...(intentSources.get(item.intent.intentID) ?? [])].every(source => settledSources.has(source))) write(item, "definitively_failed", "complete")
    } else if (item.state === "uncertain") write(item, "uncertain")
    item.needsRepair = false
    if (item.state === "accepted" || item.state === "failed") {
      items.delete(item.id)
      if (byKey.get(item.key) === item) byKey.delete(item.key)
      if (item.intent?.bookkeeping === "complete") intentSources.delete(item.intent.intentID)
    }
  }
  function settle(item: Item, succeeded: boolean, error?: unknown) {
    if (item.callbacksJoined) return
    item.callbacksJoined = true
    if (item.superseded && !item.invoked) { item.state = "failed"; item.error = Error("Original item superseded before submission") }
    else if (!succeeded && item.state === "accepted") item.error = error
    else if (!succeeded && item.state !== "accepted" && item.state !== "uncertain" && item.state !== "held") {
      item.state = item.invoked ? "uncertain" : "failed"; item.error = error
    }
    if (item.state === "held") { item.callback?.resolve(); return }
    item.needsRepair = true
    const work = own("receipt", () => repair(item))
    void work.catch(error => { item.error = error }).finally(() => item.callback?.resolve()).catch(() => {})
  }
  async function deliver(message: IdleInjectionMessage, admission: readonly AdmissionItem[], deliverAs: "steer" | "followUp") {
    const batch = admission.map(value => { const item = items.get(value.itemId); if (!item) throw Error("Unregistered canonical batch item"); return item })
    const members = batch.flatMap(item => item.members)
    if (!members.length) throw Error("Empty canonical notification source batch")
    const inputID = `msg_native_completion_${randomUUID().replaceAll("-", "")}`
    let intent: CompletionIntent | undefined, invoked = false, ack: { id: string; sessionID: string } | undefined
    try {
      current(); if (!known()) throw Error("Receiving state window ended before dispatch")
      for (const member of members) {
        const permit = await options.issuer.validateForDispatch(member.run, member.source)
        current(); if (!known()) throw Error("Receiving state changed during authority query")
        options.issuer.assertDispatchCurrent(permit)
      }
      const existing = members.map(member => options.journal.findBySource(member.logical)).filter((value): value is CompletionIntent => value !== undefined)
      if (existing.length) {
        // Never merge/rewrite a canonical envelope or spend another intent's ACK.
        const first = existing[0]
        if (!first) throw Error("Existing completion intent missing")
        if (existing.length !== members.length || existing.some(value => value.intentID !== first.intentID) || !stableReceiver(first.receiver)
          || members.some(member => !first.sources.some(source => logicalKey(source) === logicalKey(member.logical)))) {
          for (const item of batch) item.state = "held"
          throw Error("Mixed or foreign existing completion intent held")
        }
        if (first.phase === "accepted" && first.acceptance) {
          const claimed = first.owner === options.journal.owner ? first : await options.journal.claim(first.intentID)
          const repairPermits = []
          for (const member of members) repairPermits.push(await options.issuer.validateForDispatch(member.run, member.source))
          current(); if (!known()) throw Error("Receiving state changed during accepted repair validation")
          for (const permit of repairPermits) options.issuer.assertDispatchCurrent(permit)
          intentSources.set(claimed.intentID, new Set(members.map(member => member.source)))
          for (const item of batch) { item.intent = claimed; item.ack = { id: first.acceptance.id, sessionID: first.acceptance.sessionID }; item.state = "accepted" }
          return claimed.acceptance
        }
        for (const item of batch) { item.intent = first; item.state = "held" }
        throw Error("Existing queued/uncertain intent requires explicit recovered custody; no replay")
      }
      const projected = wire(message), projectedItems = wire(admission)
      intent = options.journal.insertQueued({ intentID: `completion:${randomUUID()}`, receiver,
        sources: members.map(member => {
          const owner = sourceOwners.get(member.source)
          if (!owner) throw Error("Notification source has no owning item")
          return { ...member.logical, provenance: { itemId: owner.id } }
        }),
        message: { canonical: projected, items: projectedItems, inputID, delivery: deliverAs === "followUp" ? "queue" : "steer" } })
      intentSources.set(intent.intentID, new Set(members.map(member => member.source)))
      for (const item of batch) item.intent = intent
      const lead = batch[0]
      if (!lead) throw Error("Notification batch is empty")
      write(lead, "dispatching"); intent = lead.intent
      for (const item of batch) item.intent = intent
      // Last same-stack fence. Edge closure never cancels an original accepted SDK promise.
      current(); if (!known()) throw Error("Receiving state window consumed before SDK call")
      const dispatchPermits = []
      for (const member of members) dispatchPermits.push(await options.issuer.validateForDispatch(member.run, member.source))
      current(); if (!known()) throw Error("Receiving state changed before SDK call")
      // A later member's query can revoke an earlier member. ALL permits are checked
      // in the same stack after the final await and immediately before transport.
      for (const permit of dispatchPermits) options.issuer.assertDispatchCurrent(permit)
      invoked = true; for (const item of batch) item.invoked = true
      if (!intent) throw Error("Notification durable intent missing")
      const result = await options.ctx.session.synthetic({ sessionID: receiver.sessionID, id: inputID, text: message.content,
        delivery: deliverAs === "followUp" ? "queue" : "steer", resume: true,
        metadata: { completionIntentID: intent.intentID, nativeItems: projectedItems } }, { signal: transportStop.signal })
      if (result.id !== inputID || result.sessionID !== receiver.sessionID || result.type !== "synthetic" || result.payload.text !== message.content) throw Error("Foreign notification admission ACK")
      ack = { id: result.id, sessionID: result.sessionID }
      for (const item of batch) { item.ack = ack; item.state = "accepted"; item.needsRepair = true }
      write(lead, "accepted")
      for (const item of batch) item.intent = lead.intent
      return result // Non-array legacy success ONLY after genuine ACK + durable accepted.
    } catch (error) {
      for (const item of batch) {
        if (item.state === "held" || item.state === "accepted") continue
        item.error = error; item.state = invoked ? "uncertain" : "failed"; item.invoked = invoked; item.needsRepair = true
        if (intent) item.intent = options.journal.read(intent.intentID) ?? intent
      }
      throw error
    }
  }
  const coordinator = new IdleInjectionCoordinator((message, delivery) => {
    const batch = delivery.items.map(value => items.get(value.itemId)).filter((value): value is Item => !!value)
    for (const item of batch) {
      item.state = "flushing"; item.callback = Promise.withResolvers<void>(); pending.set(item.callback.promise, "receipt")
      void item.callback.promise.finally(() => { if (item.callback) pending.delete(item.callback.promise) }).catch(() => {})
    }
    return own("transport", () => deliver(message, delivery.items, delivery.deliverAs))
  }, { onChildWorkChange(count) { childWork = count }, onReceiptError(error) { note("coordinator-receipt", error) },
    scheduleFlush(flush) { const timer = setTimeout(() => { batches.delete(timer); if (known()) void own("batch", flush).catch(() => {}) }, 0); batches.add(timer); return () => { clearTimeout(timer); batches.delete(timer) } } })
  function retry(callback: () => void, delay: number) {
    if (stopped) return () => {} // No new physical timer after quiescence.
    const entry: { callback: () => void; timer?: ReturnType<typeof setTimeout>; due: boolean } = { callback, due: false }
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (stopped) return
      entry.due = true
      // It can enqueue after this window's final flush while another original
      // proof is awaited. Preserve a catch-up request even on the known branch.
      dirty = true; wakeRequested = true
      if (known()) void own("prepare", () => { if (known()) { entry.due = false; retries.delete(entry); callback() } }).catch(() => {})
      else startWakeIfRequested()
    }, delay)
    retries.add(entry)
    return () => { if (entry.timer !== undefined) clearTimeout(entry.timer); entry.timer = undefined; retries.delete(entry) }
  }
  const notifier = createCompletionNotifier({ store: {
    load: id => options.baseStore.load(id), replace: row => options.baseStore.replace(row), mutate: (id, mutation) => options.baseStore.mutate(id, mutation),
    appendEvent: (id, event) => options.baseStore.appendEvent(id, event),
    list() { const actual = options.baseStore.list(); return { records: actual.records.filter(row => ready(row) && ownsTerminal(row)), diagnostics: actual.diagnostics } },
  }, schedule: retry, getParentState: state, getCurrentSessionId: () => receiver.sessionID, notifier: {
    enqueue() { throw Error("Owned notification requires exact deferred source") },
    enqueueWithSource(message, sources) {
      if (!sources.length || sources.length !== message.details.length || new Set(sources.map(source => source.taskId)).size !== sources.length
        || new Set(message.details.map(detail => detail.task_id)).size !== message.details.length) throw Error("Completion details/source identities differ")
      const members = new Map<string, Member>()
      for (const source of sources) {
        options.registerSource(source)
        const row = options.baseStore.load(source.taskId), value = row && prepared.get(row.task_id)
        if (!row || !value || !ready(row) || source.parentSessionId !== receiver.sessionID || source.runEpoch !== row.notification.run_epoch
          || sourceOwners.has(source) || !message.details.some(detail => detail.task_id === source.taskId)) throw Error("Unregistered or duplicate notification source")
        members.set(source.taskId, { source, task: value.task, run: value.run, logical: { taskId: row.task_id, nativeEpoch: source.runEpoch,
          parentSessionId: row.parent_session_id, rootSessionId: row.root_session_id, createdAt: row.created_at } })
      }
      for (const detail of message.details) {
        const member = members.get(detail.task_id)
        if (!member) throw Error("Unregistered or duplicate notification source")
        const key = `task-completion:${detail.task_id}`, id = randomUUID()
        const itemMessage = message.details.length === 1 ? message : { ...buildCompletionMessage([detail]), triggerTurn: message.triggerTurn }
        const item: Item = { id, key, message: itemMessage, members: [member], state: "queued", invoked: false, needsRepair: false }
        const prior = byKey.get(key); if (prior?.state === "queued") prior.superseded = item
        items.set(id, item); byKey.set(key, item); sourceOwners.set(member.source, item)
        const accepted = coordinator.enqueue({ key, itemId: id, source: "task-completion", customType: itemMessage.customType,
          content: itemMessage.content, display: itemMessage.display, details: [detail],
          runRef: detail.runRef ?? (detail.dag === undefined ? { kind: "task", id: detail.task_id } : { kind: "dag", id: detail.dag.run_id }),
          ...(detail.dag === undefined ? {} : { contextScoped: true }),
          onFlushed() { settle(item, true) }, onDeliveryFailed(error) { settle(item, false, error) } })
        if (!accepted) settle(item, false, Error("Coordinator refused notification after retirement"))
      }
    },
  } })
  async function window(kind: "idle" | "streaming", sessionID: string, quiescenceEpoch?: number, wakeSignal?: AbortSignal) {
    const previous = hookTail
    const work = own(quiescenceEpoch === undefined ? "hook" : "wake-flush", async () => {
      await previous.catch(() => {})
      if (stopped || compacting || wakeSignal?.aborted || sessionID !== receiver.sessionID) return
      try { current() } catch (error) { note("receiver-held", error); return }
      if (quiescenceEpoch !== undefined && quiescenceEpoch !== activity) { wakeRequested = true; return }
      const currentEdge = { kind, origin: quiescenceEpoch === undefined ? "hook" as const : "public-quiescence" as const, epoch: activity, open: true }; edge = currentEdge
      try {
        do {
          // New terminal/accepted bindings can arrive while an ORIGINAL preparation
          // is awaited. Catch those requests before the one canonical batch flush.
          // A held source does not dirty itself; no future terminal/backoff is awaited.
          dirty = false
          await prepare()
          for (const entry of [...retries]) if (entry.due && known()) { entry.due = false; retries.delete(entry); entry.callback() }
          if (known()) notifier.reconcileUnnotifiedNotifications({ sessionId: receiver.sessionID, parentState: state() })
          await drain(true)
        } while (known() && dirty)
        if (known()) coordinator.flushOnIdle()
        await drain(true)
      } catch (error) { note("hook-held", error) }
      finally {
        currentEdge.open = false; if (edge === currentEdge) edge = undefined
        if (currentEdge.origin === "hook" && !hasWakeCandidate()) wakeController?.abort(Error("Actual hook spent the readonly wake sources"))
        startWakeIfRequested()
      }
    })
    hookTail = work.catch(() => {})
    return work
  }
  async function disposeRegistrations() {
    const errors: unknown[] = []
    for (const entry of registrations) if (!entry.disposed) try { await entry.registration.dispose(); entry.disposed = true } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, "Owned notification registrations retained")
  }
  async function initialize() {
    if (initialized) return
    if (initializing) return initializing
    if (stopped) throw Error("Notification owner stopped before initialize")
    const work = (async () => {
      await disposeRegistrations()
      async function register(body: () => Promise<{ dispose(): Promise<void> }>) {
        if (stopped) return
        const registration = await own("initialize", body)
        registrations.push({ registration, disposed: false })
      }
      await register(() => options.ctx.session.hook("experimental.idle", input => window("idle", input.sessionID)))
      await register(() => options.ctx.tool.hook("execute.before", input => window("streaming", input.sessionID)))
      await register(() => options.ctx.tool.hook("execute.after", input => window("streaming", input.sessionID)))
      if (!pump) pump = Promise.resolve().then(async () => {
        streamAlive = true
        startWakeIfRequested()
        try { for await (const event of options.ctx.event.subscribe({ types: ["session.execution.started", "session.inbox.enqueued", "session.status", "session.compaction.started", "session.compaction.ended", "session.moved", "session.deleted"], signal: subscriptionStop.signal })) {
          const id = event.data.sessionID
          if (id === receiver.sessionID) {
            activity++
            if (event.type === "session.compaction.started") { compacting = true; wakeRequested = true }
            if (event.type === "session.compaction.ended") { compacting = false; wakeRequested = true }
            if (edge) { if (edge.origin === "public-quiescence") wakeRequested = true; edge.open = false }
            if (event.type === "session.compaction.ended") startWakeIfRequested()
          }
        } } catch (error) { if (!subscriptionStop.signal.aborted) note("event-gap", error) }
        finally { streamAlive = false; if (!subscriptionStop.signal.aborted) { activity++; if (edge) edge.open = false; wakeStop.abort(Error("Notification event stream ended")); note("event-gap", Error("Notification event subscription ended; state unknown")) } }
      })
      initialized = !stopped
      startWakeIfRequested()
    })()
    initializing = work
    void work.finally(() => { if (initializing === work) initializing = undefined }).catch(() => {})
    return work
  }
  function stop() { stopped = true; wakeStop.abort(Error("Notification readonly wake owner stopped")); if (edge) edge.open = false; options.issuer.stopIssuing() }
  async function join() {
    if (initializing) await initializing.catch(() => {})
    await drain()
    const failures = [...items.values()].filter(item => item.needsRepair)
    if (failures.length) throw new AggregateError(failures.map(item => item.error), "Owned notification bookkeeping retained")
  }
  async function close() {
    if (closed) return
    if (closing) return closing
    stop(); transportStop.abort(Error("Notification transport owner closing")); options.issuer.quiesce()
    const work = (async () => {
      if (initializing) await initializing.catch(() => {})
      for (const entry of [...retries]) { if (entry.timer !== undefined) clearTimeout(entry.timer); retries.delete(entry) }
      for (const timer of [...batches]) { clearTimeout(timer); batches.delete(timer) }
      coordinator.retire()
      await drain()
      for (const item of items.values()) if (item.needsRepair) await own("receipt", () => repair(item))
      await join()
      subscriptionStop.abort(); if (pump) await pump
      await disposeRegistrations(); await options.issuer.retire()
      closed = true
    })()
    closing = work
    void work.catch(() => { if (closing === work) closing = undefined })
    return work
  }
  return {
    initialize, requestReconcile, stop, join, close,
    channel: { binding: options.binding, parentSessionId: receiver.sessionID, rootSessionId: receiver.rootSessionID, notifier,
      parentState: () => known() ? state() : undefined,
      ownsTerminal, notificationReady: record => known() && ready(record),
      onTerminal(record) { options.onTerminal?.(record); requestReconcile() } },
    diagnostics() { return Object.freeze({ initialized, stopped, closed, pending: pending.size, retryTimers: retries.size, batchTimers: batches.size,
      childWork, knownWindow: known(), windowOrigin: edge?.origin, wakePending: !!wakeWork, wakeRequested, compacting, streamAlive, activity, dirty, queued: [...items.values()].filter(item => item.state === "queued").length,
      uncertain: [...items.values()].filter(item => item.state === "uncertain" || item.state === "held").length,
      retainedBookkeeping: [...items.values()].filter(item => item.needsRepair).length,
      failures: history.map(value => ({ kind: value.kind, error: reason(value.error) })) }) },
  }
}
