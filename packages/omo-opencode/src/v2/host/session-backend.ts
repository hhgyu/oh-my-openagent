import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionLease, SessionScopes, SessionToolPolicy } from "./session-state"
import { hasJoinedSessionCancellation } from "./session-cancellation"
import type { ParkingDescriptor, ParkingObservedInfo } from "./child-parking"
import { createChildParking } from "./child-parking-custody"
import { isHostSessionAbsent } from "./session-absence"

type Domain = Context["session"]
type Input<K extends "create" | "prompt" | "synthetic"> = NonNullable<Parameters<Domain[K]>[0]>
export interface SessionReference extends ParkingObservedInfo {
  readonly id: SessionLease["sessionID"]
  readonly parentID?: SessionLease["sessionID"]
  readonly location: { readonly directory: string }
}
/** Public Context methods, projected only where the backend needs a session identity. */
export interface SessionBackendApi {
  create(input: Input<"create">, options?: { signal?: AbortSignal }): Promise<SessionReference>
  get(input: { sessionID: string }, options?: { signal?: AbortSignal }): Promise<SessionReference>
  list(input?: Parameters<Domain["list"]>[0], options?: { signal?: AbortSignal }): Promise<{ data: readonly SessionReference[]; cursor: { next?: string | null; previous?: string | null } }>
  prompt(input: Input<"prompt">, options?: { signal?: AbortSignal }): Promise<{ id: string; sessionID: string }>
  synthetic(input: Input<"synthetic">, options?: { signal?: AbortSignal }): Promise<{ id: string; sessionID: string }>
  interrupt: Domain["interrupt"]
  wait: Domain["wait"]
  remove: Domain["remove"]
  context: Domain["context"]
  instructions: Domain["instructions"]
  /** Required only by durable parking; its own child permissions/metadata, never global config. */
  update?: Domain["update"]
}
export interface ChildLocator {
  readonly format: 1
  readonly backendID: string
  readonly location: string
  readonly hostVersion: string
  readonly parentID: SessionLease["sessionID"]
  readonly sessionID: SessionLease["sessionID"]
  readonly generation: number
}
export interface ChildRecord {
  readonly key: string
  readonly owner: string
  readonly revision: number
  readonly locator: ChildLocator
  readonly phase: "creating" | "staged" | "admitting" | "accepted" | "uncertain" | "closing" | "closed"
  readonly admission: "none" | "pending" | "accepted" | "uncertain"
  readonly inboxID?: string
  readonly receipts: Readonly<Record<string, "pending" | "accepted" | "uncertain">>
  /** Adapter-owned Native run selection, never a host execution ID or consumption receipt. */
  readonly turn?: OwnedTurnDescriptor
  /** Durable parking intent/receipt. Parked is NOT closed; absent on records that never parked. */
  readonly parking?: ParkingDescriptor
}
export interface OwnedTurnDescriptor { readonly nativeEpoch: number; readonly observationKey: string; readonly firstInputID?: string }
/**
 * Required durable storage. claim is atomic: refuse a live competing owner and
 * fence a verified dead-owner takeover. Existing claims MUST increase revision,
 * even for the same owner. initial means insert-only and MUST reject existing keys.
 * write must compare owner AND revision.
 * Implementations must reject stale writes, never silently overwrite custody.
 */
export interface ChildJournal {
  claim(key: string, owner: string, initial?: ChildRecord): Promise<ChildRecord>
  read(key: string): Promise<ChildRecord | undefined>
  write(previous: ChildRecord, next: ChildRecord): Promise<void>
  /** Same-stack durable commit for observation-capable local journals. */
  writeSync?(previous: ChildRecord, next: ChildRecord): undefined
  /** Optional synchronous exact-row fence for event persistence. Async reads cannot substitute. */
  assertCurrent?(expected: ChildRecord): undefined
}
export interface ChildHandle { readonly locator: ChildLocator; readonly lease: SessionLease }
const borrowedParents = new WeakMap<object, { lease: SessionLease; policy: SessionToolPolicy; assertCurrent(): void }>()
const borrowedParentBrand: unique symbol = Symbol("borrowed owned child parent")
export interface BorrowedChildParent { readonly [borrowedParentBrand]: true }
export function readBorrowedChildParent(value: BorrowedChildParent) {
  const issued = borrowedParents.get(value)
  if (!issued) throw new Error("Unissued borrowed child parent")
  issued.assertCurrent()
  return issued
}
export interface AdmissionReceipt {
  readonly state: "accepted"
  readonly inboxID: string
  /** Admission is confirmed; whether model work consumed it is not known here. */
  readonly consumption: "unconfirmed"
}
export interface ChildInterruptionReceipt {
  readonly state: "answered"
  readonly interrupted: boolean
  readonly settlement: "unconfirmed"
}
export interface ChildDetachmentReceipt { readonly state: "detached"; readonly locator: ChildLocator }
export class SessionBackendError extends Error {
  constructor(readonly code: "unavailable" | "foreign" | "stopped" | "conflict" | "uncertain" | "state", message: string, readonly locator?: ChildLocator, options?: ErrorOptions) {
    super(message, options); this.name = "SessionBackendError"
  }
}
export interface SessionBackendOptions {
  readonly backendID: string
  readonly owner: string
  readonly parent: SessionLease
  readonly scopes: SessionScopes
  readonly policy: SessionToolPolicy
  readonly gate: { assertActive(lease: SessionLease): void }
  readonly journal: ChildJournal
  readonly beforeLeaseRetire?: (child: ChildHandle, intent: "end" | "detach" | "dispose") => Promise<void>
  /** Detach parks this child durably: join() must revoke and JOIN original guard/producer work. */
  readonly parking?: { join(child: ChildHandle): Promise<void> }
}
interface Entry { record: ChildRecord; handle?: ChildHandle; busy: boolean; detached?: boolean; cleanupRecovery?: boolean; readers?: Set<Promise<unknown>>; borrowingClosed?: boolean; retirement?: Promise<void>; retirementComplete?: boolean }

export function createSessionBackend(host: { app: Context["app"]; location: { directory: string }; session: SessionBackendApi }, options: SessionBackendOptions) {
  const { scopes, parent, journal } = options
  const entries = new Map<string, Entry>()
  const issued = new WeakMap<ChildHandle, Entry>()
  const pending = new Set<Promise<unknown>>()
  const lifetime = new AbortController()
  const requestSignal = (child?: ChildHandle) => AbortSignal.any([parent.signal, lifetime.signal, ...(child ? [child.lease.signal] : [])])
  let disposed = false, preparingDisposal = false
  let disposal: Promise<void> | undefined
  function cancellable() {
    if (!hasJoinedSessionCancellation(host.session)) throw new SessionBackendError("unavailable", "Session operation requires a joined cancellation-capable Effect port")
  }
  function active() {
    if (disposed || preparingDisposal) throw new SessionBackendError("stopped", "Session backend disposed")
    scopes.assert(parent); options.gate.assertActive(parent)
  }
  function track<T>(operation: () => Promise<T>): Promise<T> {
    const promise = operation(); pending.add(promise)
    void promise.finally(() => pending.delete(promise)).catch(() => {})
    return promise
  }
  function validate(locator: ChildLocator, recovering = false) {
    if (locator.format !== 1 || locator.backendID !== options.backendID || locator.parentID !== parent.sessionID || locator.location !== host.location.directory || (!recovering && locator.generation !== parent.generation) || locator.hostVersion !== host.app.version) {
      throw new SessionBackendError("foreign", "Child locator does not belong to this host generation", locator)
    }
  }
  function identity(info: SessionReference, locator: ChildLocator) {
    if (info.id !== locator.sessionID || info.parentID !== locator.parentID || info.location.directory !== locator.location) throw new SessionBackendError("foreign", "Host session identity differs from owned child", locator)
  }
  async function fence(entry: Entry) {
    const stored = await journal.read(entry.record.key)
    if (!stored || stored.owner !== options.owner || stored.revision !== entry.record.revision || stored.locator.sessionID !== entry.record.locator.sessionID) throw new SessionBackendError("conflict", "Child custody fence lost", entry.record.locator)
    validate(stored.locator)
  }
  function phase(entry: Entry): ChildRecord["phase"] { return entry.record.phase }
  function requireSynchronousResult(result: unknown, locator: ChildLocator): undefined {
    if (result !== undefined) {
      // An invalid async dependency may finish later; consume rejection only. Never
      // await it, advance the local row, or treat it as synchronous authority.
      if ((result !== null && typeof result === "object") || typeof result === "function") void Promise.resolve(result).catch(() => {})
      throw new SessionBackendError("unavailable", "Child journal synchronous capability must return undefined", locator)
    }
    return undefined
  }
  async function checkpoint(entry: Entry, patch: Partial<Pick<ChildRecord, "phase" | "admission" | "inboxID" | "receipts" | "locator" | "parking">>) {
    const previous = entry.record
    const next = { ...previous, ...patch, revision: previous.revision + 1 }
    if (journal.writeSync) requireSynchronousResult(journal.writeSync(previous, next), previous.locator)
    else await journal.write(previous, next)
    entry.record = next
  }
  function checkpointTurn(child: ChildHandle, turn: OwnedTurnDescriptor | undefined, priorAdmission?: Pick<ChildRecord, "phase" | "admission" | "inboxID">): ChildRecord {
    const entry = lookup(child)
    controlLive(child, entry)
    if (entry.busy) throw new SessionBackendError("state", "Child operation already in flight", child.locator)
    if (!journal.assertCurrent || !journal.writeSync) throw new SessionBackendError("unavailable", "Owned turn requires synchronous journal custody", child.locator)
    if (turn && (!Number.isSafeInteger(turn.nativeEpoch) || turn.nativeEpoch < 0 || typeof turn.observationKey !== "string" || !turn.observationKey || turn.observationKey.length > 512
      || turn.firstInputID !== undefined && (typeof turn.firstInputID !== "string" || !turn.firstInputID || turn.firstInputID.length > 4096)
      || Object.keys(turn).some(key => !["nativeEpoch", "observationKey", "firstInputID"].includes(key)))) throw new SessionBackendError("state", "Invalid owned turn descriptor", child.locator)
    requireSynchronousResult(journal.assertCurrent(entry.record), child.locator)
    const next = { ...entry.record, ...priorAdmission, revision: entry.record.revision + 1 }
    if (turn) next.turn = Object.freeze({ ...turn })
    else Reflect.deleteProperty(next, "turn")
    if (priorAdmission?.inboxID === undefined && priorAdmission) Reflect.deleteProperty(next, "inboxID")
    requireSynchronousResult(journal.writeSync(entry.record, next), child.locator)
    entry.record = next
    return structuredClone(next)
  }
  function handle(entry: Entry): ChildHandle {
    const lease = scopes.open(entry.record.locator.sessionID, options.policy)
    const value = Object.freeze({ locator: Object.freeze({ ...entry.record.locator }), lease })
    entry.handle = value; issued.set(value, entry)
    return value
  }
  function lookup(child: ChildHandle) {
    const entry = issued.get(child)
    if (!entry || entry.detached) throw new SessionBackendError("foreign", "Unknown or detached child handle")
    validate(child.locator)
    return entry
  }
  function beforeRetire(entry: Entry, intent: "end" | "detach" | "dispose"): Promise<void> {
    if (!options.beforeLeaseRetire || !entry.handle || entry.retirementComplete) return Promise.resolve()
    entry.borrowingClosed = true
    if (entry.retirement) return entry.retirement
    const work = Promise.resolve().then(() => {
      const handle = entry.handle
      if (!options.beforeLeaseRetire || !handle) throw new SessionBackendError("state", "Lease retirement hook or child handle vanished before retirement")
      return options.beforeLeaseRetire(handle, intent)
    }).then(() => { entry.retirementComplete = true })
    entry.retirement = work
    void work.catch(() => { if (entry.retirement === work) entry.retirement = undefined })
    return work
  }
  async function cleanup(entry: Entry) {
    if (entry.detached || entry.record.phase === "closed") return
    await beforeRetire(entry, "end")
    await fence(entry)
    await checkpoint(entry, { phase: "closing" })
    try {
      const info = await host.session.get({ sessionID: entry.record.locator.sessionID })
      identity(info, entry.record.locator)
      if (entry.handle && !entry.handle.lease.signal.aborted) scopes.retire(entry.handle.lease)
      await fence(entry)
      await host.session.interrupt({ sessionID: info.id, resume: false })
      await fence(entry)
      await host.session.wait({ sessionID: info.id })
      await fence(entry)
      await host.session.remove({ sessionID: info.id })
      await checkpoint(entry, { phase: "closed" })
    } catch (cause) {
      if (isHostSessionAbsent(cause, entry.record.locator.sessionID)) {
        // The host already removed this exact child (OpenCode removes a removed parent's children
        // with it). Removal is the outcome cleanup exists to reach, so this closed receipt is genuine.
        if (entry.handle && !entry.handle.lease.signal.aborted) scopes.retire(entry.handle.lease)
        await checkpoint(entry, { phase: "closed" })
        return
      }
      await checkpoint(entry, { phase: "uncertain" })
      throw new SessionBackendError("uncertain", "Child cleanup uncertain; custody retained", entry.record.locator, { cause })
    }
  }
  async function readiness(signal?: AbortSignal) {
    active()
    signal?.throwIfAborted()
    if (host.app.version !== "2.2.6") throw new SessionBackendError("unavailable", "Child backend requires verified OpenCode 2.2.6")
    const info = await host.session.get({ sessionID: parent.sessionID }, { signal: signal ? AbortSignal.any([requestSignal(), signal]) : requestSignal() })
    active()
    signal?.throwIfAborted()
    if (info.id !== parent.sessionID || info.location.directory !== host.location.directory) throw new SessionBackendError("foreign", "Parent session and trusted host location differ")
  }
  async function exclusive<T>(child: ChildHandle, operation: (entry: Entry) => Promise<T>) {
    const entry = lookup(child)
    if (entry.busy) throw new SessionBackendError("state", "Child operation already in flight", child.locator)
    entry.busy = true
    try { await fence(entry); return await operation(entry) } finally { entry.busy = false }
  }
  async function readLive<T>(child: ChildHandle, action: (signal: AbortSignal) => Promise<T>, reader = false): Promise<T> {
    if (reader) cancellable()
    const read = async (entry: Entry) => {
      active()
      scopes.assert(child.lease)
      await fence(entry)
      active(); scopes.assert(child.lease)
      const result = await action(requestSignal(child))
      active()
      scopes.assert(child.lease)
      await fence(entry)
      active(); scopes.assert(child.lease)
      return result
    }
    // Read-only requests do not block detach; retiring the lease cancels their real request.
    return reader ? readOnly(child, read) : exclusive(child, read)
  }
  function readOnly<T>(child: ChildHandle, operation: (entry: Entry) => Promise<T>): Promise<T> {
    const entry=lookup(child)
    const readers=entry.readers??=new Set()
    const promise=Promise.resolve().then(()=>operation(entry))
    readers.add(promise)
    void promise.finally(()=>readers.delete(promise)).catch(()=>{})
    return promise
  }
  function controlLive(child: ChildHandle, entry: Entry) {
    if (disposed) throw new SessionBackendError("stopped", "Session backend disposed")
    scopes.assert(parent); scopes.assert(child.lease)
    if (entry.detached || issued.get(child) !== entry || entry.handle !== child || entry.record.phase === "closed") throw new SessionBackendError("state", "Child control custody retired", child.locator)
  }
  function continueAdmission(child: ChildHandle, id: string, send: (signal: AbortSignal) => Promise<{ id: string; sessionID: string }>, kind: "prompt" | "synthetic", signal?: AbortSignal) {
    return track(() => exclusive(child, async entry => {
      active(); scopes.assert(child.lease); signal?.throwIfAborted()
      if (entry.record.phase !== "accepted") throw new SessionBackendError("state", "Child is not running", child.locator)
      parking.refuseInput(entry.record)
      // An existing receipt never grants a semantic same-payload/conflict verdict or a resend.
      if (!id || Object.hasOwn(entry.record.receipts, id)) throw new SessionBackendError("state", "Admission ID already reserved or empty", child.locator)
      if (Object.keys(entry.record.receipts).length >= 4096) throw new SessionBackendError("state", "Child admission ledger full; retire this child", child.locator)
      await checkpoint(entry, { phase: "admitting", admission: "pending", inboxID: id, receipts: { ...entry.record.receipts, [id]: "pending" } })
      try {
        active(); scopes.assert(child.lease)
        const request = signal ? AbortSignal.any([requestSignal(child), signal]) : requestSignal(child)
        request.throwIfAborted()
        const receipt = await send(request)
        if (receipt.id !== id || receipt.sessionID !== child.locator.sessionID) throw new Error(`Foreign ${kind} receipt`)
        await checkpoint(entry, { phase: "accepted", admission: "accepted", receipts: { ...entry.record.receipts, [id]: "accepted" } })
        try { active(); scopes.assert(child.lease) } catch (cause) { await cleanup(entry); throw cause }
        return { state: "accepted" as const, inboxID: receipt.id, consumption: "unconfirmed" as const }
      } catch (cause) {
        if (phase(entry) === "admitting") {
          await checkpoint(entry, { phase: "uncertain", admission: "uncertain", receipts: { ...entry.record.receipts, [id]: "uncertain" } })
          throw new SessionBackendError("uncertain", "Admission receipt unknown; original input must not be replayed", child.locator, { cause })
        }
        throw cause
      }
    }))
  }
  function recover(key: string, cleanupRecovery: boolean, restoreParked = false): Promise<ChildHandle> {
    return track(async () => {
      await readiness()
      let entry = entries.get(key)
      if (entry && (!cleanupRecovery || !entry.cleanupRecovery || entry.handle || entry.busy || entry.detached)) throw new SessionBackendError("state", "Custody already loaded")
      if (entry) {
        const stored = await journal.read(key)
        if (!stored || stored.owner !== options.owner || stored.revision !== entry.record.revision || stored.locator.sessionID !== entry.record.locator.sessionID || stored.phase === "closed") throw new SessionBackendError("conflict", "Unissued cleanup custody fence lost", entry.record.locator)
        validate(stored.locator, true)
        // Claim only after the failed operation has fully settled, never while a real handle exists.
        if (entry.handle || entry.busy || entry.detached) throw new SessionBackendError("state", "Custody already loaded")
        entry.busy = true
      }
      try {
        const previous = await journal.read(key)
        // Only a caller holding a fresh restore approval may reacquire PARKED custody; it stays
        // input-refused until restoreParked verifies and lifts the host deny.
        if (!cleanupRecovery && previous && !(restoreParked && (previous.parking?.state === "parked" || previous.parking?.state === "restoring"))) parking.refuseInput(previous)
        const record = await journal.claim(key, options.owner)
        if (!previous || record.revision <= previous.revision) throw new SessionBackendError("conflict", "Recovery must acquire a newer durable fence")
        validate(record.locator, true)
        if (record.owner !== options.owner || record.phase === "closed") throw new SessionBackendError("state", "Custody unavailable for recovery", record.locator)
        entry = { record, busy: true, cleanupRecovery }; entries.set(key, entry)
        identity(await host.session.get({ sessionID: record.locator.sessionID }), record.locator)
        active()
        if (record.locator.generation !== parent.generation) {
          await checkpoint(entry, { locator: Object.freeze({ ...record.locator, generation: parent.generation }) })
        }
        // Never replay an original prompt, even if its transport receipt was lost.
        if (record.phase === "creating" || record.phase === "admitting" || record.phase === "closing") await checkpoint(entry, { phase: "uncertain", admission: record.admission === "pending" ? "uncertain" : record.admission })
        return handle(entry)
      } finally { if (entry) entry.busy = false }
    })
  }
  function detachChild(child: ChildHandle, park: boolean): Promise<ChildDetachmentReceipt> {
      if (!hasJoinedSessionCancellation(host.session)) return Promise.reject(new SessionBackendError("unavailable", "Session operation requires a joined cancellation-capable Effect port"))
      return track(() => exclusive(child, async entry => {
        controlLive(child, entry)
        await fence(entry); controlLive(child, entry)
        await beforeRetire(entry, "detach")
        const parked = park && options.parking ? await parking.park(entry, child) : undefined
        // Without parking no host call: revoke only this local issued handle and observer/reader lease.
        scopes.retire(child.lease)
        entry.detached = true
        issued.delete(child)
        // Join actual scoped request termination/finalizers, not a raced local rejection.
        await Promise.allSettled([...(entry.readers??[])])
        if(disposed)throw new SessionBackendError("stopped","Session backend disposed during detach")
        scopes.assert(parent)
        await fence(entry)
        if(disposed)throw new SessionBackendError("stopped","Session backend disposed during detach")
        scopes.assert(parent)
        if (parked) parking.issue(entry, child, parked)
        return { state: "detached", locator: child.locator }
      }))
    }
  const parking = createChildParking<Entry>({ session: host.session, journal, signal: requestSignal, identity,
    join: child => options.parking ? options.parking.join(child) : Promise.reject(new SessionBackendError("unavailable", "Parking join custody not configured", child.locator)),
    async live(child, entry) { controlLive(child, entry); await fence(entry); controlLive(child, entry) },
    checkpoint: (entry, value) => checkpoint(entry, { parking: value }) })
  const backend = {
    /** Observations must remain possible after the run gate stops, until custody retires. */
    observationGuard(child: ChildHandle): () => void {
      const entry = lookup(child)
      const assertCurrent = journal.assertCurrent
      if (typeof assertCurrent !== "function" || typeof journal.writeSync !== "function") throw new SessionBackendError("unavailable", "Observation requires synchronous child custody fence and checkpoint capabilities", child.locator)
      const guard = () => {
        if (disposed) throw new SessionBackendError("stopped", "Session backend disposed")
        scopes.assert(parent); scopes.assert(child.lease)
        validate(child.locator)
        if (issued.get(child) !== entry || entry.handle !== child || entry.record.phase === "closed") throw new SessionBackendError("conflict", "Observation child custody retired", child.locator)
        requireSynchronousResult(assertCurrent.call(journal, entry.record), child.locator)
      }
      guard()
      return guard
    },
    /** The backend's own current custody record. Pair with observationGuard, which proves the
     * stored row still equals it; never a substitute for that fence. */
    currentRecord(child: ChildHandle): ChildRecord { return lookup(child).record },
    borrowParent(child: ChildHandle): BorrowedChildParent {
      const entry = lookup(child)
      controlLive(child, entry)
      if (entry.borrowingClosed || preparingDisposal) throw new SessionBackendError("stopped", "Child parent borrowing is retiring", child.locator)
      const assertCurrent = backend.observationGuard(child)
      const policy = scopes.assert(child.lease).policy
      const value = Object.freeze({ [borrowedParentBrand]: true as const })
      borrowedParents.set(value, { lease: child.lease, policy, assertCurrent })
      return value
    },
    stage(input: { key: string; sessionID: SessionLease["sessionID"]; agent: string; model?: Input<"create">["model"]; permissions?: Input<"create">["permissions"] }, admission?: { signal?: AbortSignal }): Promise<ChildHandle> {
      return track(async () => {
        await readiness(admission?.signal)
        if (input.sessionID === parent.sessionID) throw new SessionBackendError("foreign", "A child cannot replace its parent scope")
        if (entries.has(input.key)) throw new SessionBackendError("state", "Child key already opened")
        const locator: ChildLocator = Object.freeze({ format: 1, backendID: options.backendID, location: host.location.directory, hostVersion: host.app.version, parentID: parent.sessionID, sessionID: input.sessionID, generation: parent.generation })
        const record = await journal.claim(input.key, options.owner, { key: input.key, owner: options.owner, revision: 0, locator, phase: "creating", admission: "none", receipts: {} })
        if (record.phase !== "creating" || record.owner !== options.owner || JSON.stringify(record.locator) !== JSON.stringify(locator)) throw new SessionBackendError("state", "Existing custody must be explicitly recovered", record.locator)
        const entry: Entry = { record, busy: true }; entries.set(input.key, entry)
        let creationInvoked = false
        try {
          active(); await fence(entry)
          const signal = admission?.signal ? AbortSignal.any([requestSignal(), admission.signal]) : requestSignal()
          signal.throwIfAborted()
          creationInvoked = true
          const info = await host.session.create({ id: input.sessionID, parentID: parent.sessionID, location: { directory: locator.location }, agent: input.agent, model: input.model, permissions: input.permissions }, { signal })
          identity(info, locator)
          await checkpoint(entry, { phase: "staged" })
          try { active(); signal.throwIfAborted() } catch (cause) { await cleanup(entry); throw new SessionBackendError("stopped", "Child arrived after Stop; no prompt admitted", locator, { cause }) }
          return handle(entry)
        } catch (cause) {
          if (entry.record.phase === "creating") {
            if (!creationInvoked) {
              // Only an unissued intent is retired: no host create was called and no
              // ChildHandle/TaskRecord owned_session was issued. This is not a host removal ACK.
              await checkpoint(entry, { phase: "closed" })
              throw new SessionBackendError("stopped", "Unissued child creation stopped before the host call", locator, { cause })
            }
            await checkpoint(entry, { phase: "uncertain" })
            throw new SessionBackendError("uncertain", "Creation uncertain; deterministic child locator retained", locator, { cause })
          }
          throw cause
        } finally { entry.busy = false }
      })
    },
    recover(key: string, options?: { readonly restoreParked?: boolean }): Promise<ChildHandle> { return recover(key, false, options?.restoreParked === true) },
    /** Fresh-action restore under exclusive custody. Install the new guard generation, producer
     * bindings and context policy FIRST; conflict keeps the host deny and refuses input. */
    restoreParked(child: ChildHandle, expectedAgent: string | undefined): Promise<void> {
      return track(() => exclusive(child, async entry => { controlLive(child, entry); await parking.restore(entry, child, expectedAgent) }))
    },
    /** Retry only this backend's fenced, unissued cleanup recovery. Issued handles never reopen. */
    recoverForCleanup(key: string): Promise<ChildHandle> { return recover(key, true) },
    begin(child: ChildHandle, input: { id: string; text: string }) {
      return track(() => exclusive(child, async entry => {
        active(); scopes.assert(child.lease)
        if (entry.borrowingClosed) throw new SessionBackendError("stopped", "Child input is retiring", child.locator)
        if (entry.record.phase !== "staged" || entry.record.admission !== "none") throw new SessionBackendError("state", "Child initial prompt cannot be replayed", child.locator)
        parking.refuseInput(entry.record)
        if (!input.id || Object.hasOwn(entry.record.receipts, input.id)) throw new SessionBackendError("state", "Admission ID already reserved or empty", child.locator)
        if (Object.keys(entry.record.receipts).length >= 4096) throw new SessionBackendError("state", "Child admission ledger full; retire this child", child.locator)
        await checkpoint(entry, { phase: "admitting", admission: "pending", inboxID: input.id, receipts: { ...entry.record.receipts, [input.id]: "pending" } })
        try {
          active(); scopes.assert(child.lease)
          const receipt = await host.session.prompt({ sessionID: child.locator.sessionID, id: input.id, text: input.text, resume: true }, { signal: requestSignal(child) })
          if (receipt.id !== input.id || receipt.sessionID !== child.locator.sessionID) throw new Error("Foreign admission receipt")
          await checkpoint(entry, { phase: "accepted", admission: "accepted", receipts: { ...entry.record.receipts, [input.id]: "accepted" } })
          try { active(); scopes.assert(child.lease) } catch (cause) { await cleanup(entry); throw new SessionBackendError("stopped", "Stop raced with admission; consumption is unknown", child.locator, { cause }) }
          return { state: "accepted" as const, inboxID: receipt.id, consumption: "unconfirmed" as const }
        } catch (cause) {
          if (phase(entry) === "admitting") {
            await checkpoint(entry, { phase: "uncertain", admission: "uncertain", receipts: { ...entry.record.receipts, [input.id]: "uncertain" } })
            throw new SessionBackendError("uncertain", "Admission receipt unknown; original input must not be replayed", child.locator, { cause })
          }
          throw cause
        }
      }))
    },
    synthetic(child: ChildHandle, input: Omit<Input<"synthetic">, "sessionID"> & { id: string }) {
      return continueAdmission(child, input.id, signal => host.session.synthetic({ ...input, sessionID: child.locator.sessionID }, { signal }), "synthetic")
    },
    promptContinuation(child: ChildHandle, input: Omit<Input<"prompt">, "sessionID"> & { id: string }, options?: { signal?: AbortSignal }) {
      return continueAdmission(child, input.id, signal => host.session.prompt({ ...input, sessionID: child.locator.sessionID }, { signal }), "prompt", options?.signal)
    },
    checkpointTurn(child: ChildHandle, turn: OwnedTurnDescriptor | undefined) { return checkpointTurn(child, turn) },
    /** One-use actual-call witness. Reserved IDs survive both known no-call and unknown delivery. */
    preparePromptContinuation(child: ChildHandle, input: Omit<Input<"prompt">, "sessionID"> & { id: string }, options?: { signal?: AbortSignal }) {
      const entry = lookup(child)
      active(); controlLive(child, entry)
      const captured = Object.freeze({ ...input }), signal = options?.signal, before = entry.record
      let used = false, invoked = false, settled = false
      return Object.freeze({
        invoked: () => invoked,
        send(): Promise<AdmissionReceipt> {
          if (used) return Promise.reject(new SessionBackendError("state", "Prepared prompt attempt already used", child.locator))
          used = true
          const work = continueAdmission(child, captured.id, request => {
            invoked = true
            return host.session.prompt({ ...captured, sessionID: child.locator.sessionID }, { signal: request })
          }, "prompt", signal)
          return work.finally(() => { settled = true })
        },
        restoreTurn(turn: OwnedTurnDescriptor | undefined): ChildRecord {
          if (!used || !settled || invoked) throw new SessionBackendError("state", "No settled private no-call witness", child.locator)
          if (Object.keys(entry.record.receipts).some(id => id !== captured.id && entry.record.receipts[id] !== before.receipts[id])) throw new SessionBackendError("conflict", "Another admission moved the prepared turn", child.locator)
          return checkpointTurn(child, turn, { phase: before.phase, admission: before.admission, ...(before.inboxID ? { inboxID: before.inboxID } : {}) })
        },
      })
    },
    wait(child: ChildHandle, signal?: AbortSignal) {
      return track(async () => {
        cancellable()
        return readOnly(child, async entry=>{
          active(); scopes.assert(child.lease); await fence(entry)
          await host.session.wait({ sessionID: child.locator.sessionID }, { signal: AbortSignal.any([requestSignal(child), ...(signal ? [signal] : [])]) })
          active(); scopes.assert(child.lease); await fence(entry)
        })
      })
    },
    /** Cleanup-only idle barrier. It grants no admission, consumption or model outcome,
     * and must remain usable after the run/admission gate closes. */
    waitForControlIdle(child: ChildHandle, signal?: AbortSignal): Promise<void> {
      return track(async () => {
        cancellable()
        return readOnly(child, async entry => {
          controlLive(child, entry); await fence(entry); controlLive(child, entry)
          await host.session.wait({ sessionID: child.locator.sessionID }, { signal: AbortSignal.any([requestSignal(child), ...(signal ? [signal] : [])]) })
          controlLive(child, entry); await fence(entry); controlLive(child, entry)
        })
      })
    },
    interrupt(child: ChildHandle): Promise<ChildInterruptionReceipt> {
      if (!hasJoinedSessionCancellation(host.session)) return Promise.reject(new SessionBackendError("unavailable", "Session operation requires a joined cancellation-capable Effect port"))
      return track(() => exclusive(child, async entry => {
        controlLive(child, entry)
        try {
          const info = await host.session.get({ sessionID: child.locator.sessionID }, { signal: requestSignal(child) })
          controlLive(child, entry); identity(info, child.locator)
          await fence(entry); controlLive(child, entry)
          const reply = await host.session.interrupt({ sessionID: info.id, resume: false }, { signal: requestSignal(child) })
          controlLive(child, entry)
          await fence(entry); controlLive(child, entry)
          if (!reply || typeof reply.interrupted !== "boolean") throw new Error("Unknown interruption acknowledgement")
          return { state: "answered", interrupted: reply.interrupted, settlement: "unconfirmed" }
        } catch (cause) {
          if (cause instanceof SessionBackendError && cause.code !== "uncertain") throw cause
          // Never overwrite a newer owner or rewrite accepted/pending admission receipts.
          try { controlLive(child, entry); await fence(entry); controlLive(child, entry); await checkpoint(entry, { phase: "uncertain" }) } catch { /* Lost custody cannot checkpoint uncertainty. */ }
          throw new SessionBackendError("uncertain", "Child interruption acknowledgement uncertain; no retry or settlement implied", child.locator, { cause })
        }
      }))
    },
    /** Local-only release of a CONFLICTED parked child: no host write, no END, no receipt. Its
     * conflict descriptor stays durable and the guard claim stays unretired for explicit END. */
    relinquishConflict(child: ChildHandle): Promise<ChildDetachmentReceipt> {
      if (lookup(child).record.parking?.state !== "conflict") return Promise.reject(new SessionBackendError("state", "Only conflicted parking custody may be relinquished", child.locator))
      return detachChild(child, false)
    },
    detach(child: ChildHandle): Promise<ChildDetachmentReceipt> { return detachChild(child, true) },
    currentContext(child: ChildHandle): ReturnType<Domain["context"]> {
      return track(() => readLive(child, signal => host.session.context({ sessionID: child.locator.sessionID }, { signal }), true))
    },
    instructions(child: ChildHandle): {
      list(): ReturnType<Domain["instructions"]["entry"]["list"]>
      put(key: string, value: Parameters<Domain["instructions"]["entry"]["put"]>[0]["value"]): ReturnType<Domain["instructions"]["entry"]["put"]>
      remove(key: string): ReturnType<Domain["instructions"]["entry"]["remove"]>
    } {
      lookup(child)
      return {
        list: () => track(() => readLive(child, signal => host.session.instructions.entry.list({ sessionID: child.locator.sessionID }, { signal }), true)),
        put: (key: string, value: Parameters<Domain["instructions"]["entry"]["put"]>[0]["value"]) =>
          track(() => readLive(child, signal => host.session.instructions.entry.put({ sessionID: child.locator.sessionID, key, value }, { signal }))),
        remove: (key: string) => track(() => readLive(child, signal => host.session.instructions.entry.remove({ sessionID: child.locator.sessionID, key }, { signal }))),
      }
    },
    /** Host listing is genuine and location-filtered, not a claim of child ownership. */
    list() {
      return track(async()=>{
        cancellable()
        await readiness()
        const result = await host.session.list({ directory: host.location.directory, parentID: parent.sessionID }, { signal: requestSignal() })
        active()
        return result
      })
    },
    close(child: ChildHandle) { return track(() => exclusive(child, cleanup)) },
    /** Read-only probe: true only when the host answers that this exact child session no longer
     * exists. It grants nothing; a caller still closes custody through `close`. */
    hostRemoved(child: ChildHandle): Promise<boolean> {
      return track(async () => {
        lookup(child); scopes.assert(parent)
        try { await host.session.get({ sessionID: child.locator.sessionID }, { signal: requestSignal() }); return false }
        catch (cause) { if (isHostSessionAbsent(cause, child.locator.sessionID)) return true; throw cause }
      })
    },
    /** Adopt only a real durable CLOSED receipt after independent cleanup reacquired this exact child. */
    confirmClosed(child: ChildHandle): Promise<void> {
      return track(async () => {
        const entry = lookup(child)
        scopes.assert(parent)
        const actual = await journal.read(entry.record.key)
        if (!actual || actual.owner !== options.owner || actual.phase !== "closed" || actual.revision < entry.record.revision
          || actual.locator.sessionID !== child.locator.sessionID) throw new SessionBackendError("conflict", "Exact closed child receipt unavailable", child.locator)
        validate(actual.locator, true)
        entry.record = actual
      })
    },
    dispose(): Promise<void> {
      if (disposal) return disposal
      const perform = (): Promise<void> => {
      disposed = true
      lifetime.abort(new Error("Session backend disposed"))
      // Interrupt cancellable readers immediately; joining wait before retirement
      // would deadlock disposal behind an indefinitely active child.
      for (const entry of entries.values()) {
        if (!entry.detached && entry.handle && !entry.handle.lease.signal.aborted) scopes.retire(entry.handle.lease)
      }
      return (async () => {
        await Promise.allSettled([...pending])
        const results = await Promise.allSettled([...entries.values()].filter(entry => !entry.detached && entry.record.phase !== "closed").map(cleanup))
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Child custody remains uncertain after disposal")
      })()

      }
      if (!options.beforeLeaseRetire) { disposal = perform(); return disposal }
      preparingDisposal = true
      const work = Promise.resolve().then(async () => {
        for (const entry of entries.values()) if (!entry.detached && entry.record.phase !== "closed") await beforeRetire(entry, "dispose")
        await perform()
      })
      disposal = work
      void work.catch(() => { if (!disposed && disposal === work) { disposal = undefined; preparingDisposal = false } })
      return work
    },
    /** Opaque backend-minted receipt, only after a verified park AND a completed detach. */
    parkedReceipt(child: ChildHandle): object | undefined { return parking.receipt(child) },
    /** Validates an ORIGINAL receipt for this exact issued child; DTOs/markers cannot mint one. */
    assertParked(receipt: object, child: object): void { parking.assertParked(receipt, child) },
    unavailable(operation: "full-history" | "inbox" | "durable-log"): never { throw new SessionBackendError("unavailable", `${operation} requires an explicitly bound public client; Context does not provide it`) },
  }
  return backend
}
