import type { Context } from "@opencode/plugin/promise/plugin"
import type { SessionLease, SessionScopes, SessionToolPolicy } from "./session-state"

type Domain = Context["session"]
type Input<K extends "create" | "prompt" | "synthetic"> = NonNullable<Parameters<Domain[K]>[0]>
export interface SessionReference {
  readonly id: SessionLease["sessionID"]
  readonly parentID?: SessionLease["sessionID"]
  readonly location: { readonly directory: string }
}
/** Public Context methods, projected only where the backend needs a session identity. */
export interface SessionBackendApi {
  create(input: Input<"create">, options?: { signal?: AbortSignal }): Promise<SessionReference>
  get(input: { sessionID: string }, options?: { signal?: AbortSignal }): Promise<SessionReference>
  list(input?: Parameters<Domain["list"]>[0]): Promise<{ data: readonly SessionReference[]; cursor: { next?: string | null; previous?: string | null } }>
  prompt(input: Input<"prompt">, options?: { signal?: AbortSignal }): Promise<{ id: string; sessionID: string }>
  synthetic(input: Input<"synthetic">, options?: { signal?: AbortSignal }): Promise<{ id: string; sessionID: string }>
  interrupt: Domain["interrupt"]
  wait: Domain["wait"]
  remove: Domain["remove"]
  context: Domain["context"]
  instructions: Domain["instructions"]
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
}
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
  /** Optional synchronous exact-row fence for event persistence. Async reads cannot substitute. */
  assertCurrent?(expected: ChildRecord): void
}
export interface ChildHandle { readonly locator: ChildLocator; readonly lease: SessionLease }
export interface AdmissionReceipt {
  readonly state: "accepted"
  readonly inboxID: string
  /** Admission is confirmed; whether model work consumed it is not known here. */
  readonly consumption: "unconfirmed"
}
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
}
interface Entry { record: ChildRecord; handle?: ChildHandle; busy: boolean }

export function createSessionBackend(host: { app: Context["app"]; location: { directory: string }; session: SessionBackendApi }, options: SessionBackendOptions) {
  const { scopes, parent, journal } = options
  const entries = new Map<string, Entry>()
  const issued = new WeakMap<ChildHandle, Entry>()
  const pending = new Set<Promise<unknown>>()
  const lifetime = new AbortController()
  const requestSignal = (child?: ChildHandle) => AbortSignal.any([parent.signal, lifetime.signal, ...(child ? [child.lease.signal] : [])])
  let disposed = false
  let disposal: Promise<void> | undefined
  function active() {
    if (disposed) throw new SessionBackendError("stopped", "Session backend disposed")
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
    if (!stored || stored.owner !== options.owner || stored.revision !== entry.record.revision) throw new SessionBackendError("conflict", "Child custody fence lost", entry.record.locator)
    validate(stored.locator)
  }
  function phase(entry: Entry): ChildRecord["phase"] { return entry.record.phase }
  async function checkpoint(entry: Entry, patch: Partial<Pick<ChildRecord, "phase" | "admission" | "inboxID" | "receipts" | "locator">>) {
    const previous = entry.record
    const next = { ...previous, ...patch, revision: previous.revision + 1 }
    await journal.write(previous, next)
    entry.record = next
  }
  function handle(entry: Entry): ChildHandle {
    const lease = scopes.open(entry.record.locator.sessionID, options.policy)
    const value = Object.freeze({ locator: Object.freeze({ ...entry.record.locator }), lease })
    entry.handle = value; issued.set(value, entry)
    return value
  }
  function lookup(child: ChildHandle) {
    const entry = issued.get(child)
    if (!entry) throw new SessionBackendError("foreign", "Unknown child handle")
    validate(child.locator)
    return entry
  }
  async function cleanup(entry: Entry) {
    if (entry.record.phase === "closed") return
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
      await checkpoint(entry, { phase: "uncertain" })
      throw new SessionBackendError("uncertain", "Child cleanup uncertain; custody retained", entry.record.locator, { cause })
    }
  }
  async function readiness() {
    active()
    if (host.app.version !== "2.2.6") throw new SessionBackendError("unavailable", "Child backend requires verified OpenCode 2.2.6")
    const info = await host.session.get({ sessionID: parent.sessionID }, { signal: requestSignal() })
    active()
    if (info.id !== parent.sessionID || info.location.directory !== host.location.directory) throw new SessionBackendError("foreign", "Parent session and trusted host location differ")
  }
  async function exclusive<T>(child: ChildHandle, operation: (entry: Entry) => Promise<T>) {
    const entry = lookup(child)
    if (entry.busy) throw new SessionBackendError("state", "Child operation already in flight", child.locator)
    entry.busy = true
    try { await fence(entry); return await operation(entry) } finally { entry.busy = false }
  }
  function readLive<T>(child: ChildHandle, action: () => Promise<T>): Promise<T> {
    return exclusive(child, async () => {
      active()
      scopes.assert(child.lease)
      const result = await action()
      active()
      scopes.assert(child.lease)
      return result
    })
  }
  const backend = {
    /** Observations must remain possible after the run gate stops, until custody retires. */
    observationGuard(child: ChildHandle): () => void {
      const entry = lookup(child)
      const assertCurrent = journal.assertCurrent
      if (!assertCurrent) throw new SessionBackendError("unavailable", "Observation requires a synchronous child custody fence", child.locator)
      const guard = () => {
        if (disposed) throw new SessionBackendError("stopped", "Session backend disposed")
        scopes.assert(parent); scopes.assert(child.lease)
        validate(child.locator)
        if (issued.get(child) !== entry || entry.handle !== child || entry.record.phase === "closed") throw new SessionBackendError("conflict", "Observation child custody retired", child.locator)
        assertCurrent.call(journal, entry.record)
      }
      guard()
      return guard
    },
    stage(input: { key: string; sessionID: SessionLease["sessionID"]; agent: string; model?: Input<"create">["model"]; permissions?: Input<"create">["permissions"] }): Promise<ChildHandle> {
      return track(async () => {
        await readiness()
        if (input.sessionID === parent.sessionID) throw new SessionBackendError("foreign", "A child cannot replace its parent scope")
        if (entries.has(input.key)) throw new SessionBackendError("state", "Child key already opened")
        const locator: ChildLocator = Object.freeze({ format: 1, backendID: options.backendID, location: host.location.directory, hostVersion: host.app.version, parentID: parent.sessionID, sessionID: input.sessionID, generation: parent.generation })
        const record = await journal.claim(input.key, options.owner, { key: input.key, owner: options.owner, revision: 0, locator, phase: "creating", admission: "none", receipts: {} })
        if (record.phase !== "creating" || record.owner !== options.owner || JSON.stringify(record.locator) !== JSON.stringify(locator)) throw new SessionBackendError("state", "Existing custody must be explicitly recovered", record.locator)
        const entry: Entry = { record, busy: true }; entries.set(input.key, entry)
        try {
          active(); await fence(entry)
          const info = await host.session.create({ id: input.sessionID, parentID: parent.sessionID, location: { directory: locator.location }, agent: input.agent, model: input.model, permissions: input.permissions }, { signal: requestSignal() })
          identity(info, locator)
          await checkpoint(entry, { phase: "staged" })
          try { active() } catch (cause) { await cleanup(entry); throw new SessionBackendError("stopped", "Child arrived after Stop; no prompt admitted", locator, { cause }) }
          return handle(entry)
        } catch (cause) {
          if (entry.record.phase === "creating") {
            await checkpoint(entry, { phase: "uncertain" })
            throw new SessionBackendError("uncertain", "Creation uncertain; deterministic child locator retained", locator, { cause })
          }
          throw cause
        } finally { entry.busy = false }
      })
    },
    recover(key: string): Promise<ChildHandle> {
      return track(async () => {
        await readiness()
        if (entries.has(key)) throw new SessionBackendError("state", "Custody already loaded")
        const previous = await journal.read(key)
        const record = await journal.claim(key, options.owner)
        if (!previous || record.revision <= previous.revision) throw new SessionBackendError("conflict", "Recovery must acquire a newer durable fence")
        validate(record.locator, true)
        if (record.owner !== options.owner || record.phase === "closed") throw new SessionBackendError("state", "Custody unavailable for recovery", record.locator)
        const entry: Entry = { record, busy: false }; entries.set(key, entry)
        identity(await host.session.get({ sessionID: record.locator.sessionID }), record.locator)
        active()
        if (record.locator.generation !== parent.generation) {
          await checkpoint(entry, { locator: Object.freeze({ ...record.locator, generation: parent.generation }) })
        }
        // Never replay an original prompt, even if its transport receipt was lost.
        if (record.phase === "creating" || record.phase === "admitting" || record.phase === "closing") await checkpoint(entry, { phase: "uncertain", admission: record.admission === "pending" ? "uncertain" : record.admission })
        return handle(entry)
      })
    },
    begin(child: ChildHandle, input: { id: string; text: string }) {
      return track(() => exclusive(child, async entry => {
        active(); scopes.assert(child.lease)
        if (entry.record.phase !== "staged" || entry.record.admission !== "none") throw new SessionBackendError("state", "Child initial prompt cannot be replayed", child.locator)
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
      return track(() => exclusive(child, async entry => {
        active(); scopes.assert(child.lease)
        if (entry.record.phase !== "accepted") throw new SessionBackendError("state", "Child is not running", child.locator)
        // All admissions, including continuation, are fenced and never retried automatically.
        if (!input.id || Object.hasOwn(entry.record.receipts, input.id)) throw new SessionBackendError("state", "Admission ID already reserved or empty", child.locator)
        if (Object.keys(entry.record.receipts).length >= 4096) throw new SessionBackendError("state", "Child admission ledger full; retire this child", child.locator)
        await checkpoint(entry, { phase: "admitting", admission: "pending", inboxID: input.id, receipts: { ...entry.record.receipts, [input.id]: "pending" } })
        try {
          active(); scopes.assert(child.lease)
          const receipt = await host.session.synthetic({ ...input, sessionID: child.locator.sessionID }, { signal: requestSignal(child) })
          if (receipt.id !== input.id || receipt.sessionID !== child.locator.sessionID) throw new Error("Foreign synthetic receipt")
          await checkpoint(entry, { phase: "accepted", admission: "accepted", receipts: { ...entry.record.receipts, [input.id]: "accepted" } })
          try { active(); scopes.assert(child.lease) } catch (cause) { await cleanup(entry); throw cause }
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
    wait(child: ChildHandle, signal?: AbortSignal) {
      return track(async () => {
        const entry = lookup(child)
        active(); scopes.assert(child.lease); await fence(entry)
        await host.session.wait({ sessionID: child.locator.sessionID }, { signal: AbortSignal.any([child.lease.signal, parent.signal, ...(signal ? [signal] : [])]) })
        active(); scopes.assert(child.lease); await fence(entry)
      })
    },
    currentContext(child: ChildHandle): ReturnType<Domain["context"]> {
      return track(() => readLive(child, () => host.session.context({ sessionID: child.locator.sessionID })))
    },
    instructions(child: ChildHandle): {
      list(): ReturnType<Domain["instructions"]["entry"]["list"]>
      put(key: string, value: Parameters<Domain["instructions"]["entry"]["put"]>[0]["value"]): ReturnType<Domain["instructions"]["entry"]["put"]>
      remove(key: string): ReturnType<Domain["instructions"]["entry"]["remove"]>
    } {
      lookup(child)
      return {
        list: () => track(() => readLive(child, () => host.session.instructions.entry.list({ sessionID: child.locator.sessionID }))),
        put: (key: string, value: Parameters<Domain["instructions"]["entry"]["put"]>[0]["value"]) =>
          track(() => readLive(child, () => host.session.instructions.entry.put({ sessionID: child.locator.sessionID, key, value }))),
        remove: (key: string) => track(() => readLive(child, () => host.session.instructions.entry.remove({ sessionID: child.locator.sessionID, key }))),
      }
    },
    /** Host listing is genuine and location-filtered, not a claim of child ownership. */
    async list() {
      await readiness()
      const result = await host.session.list({ directory: host.location.directory, parentID: parent.sessionID })
      active()
      return result
    },
    close(child: ChildHandle) { return track(() => exclusive(child, cleanup)) },
    dispose(): Promise<void> {
      if (disposal) return disposal
      disposed = true
      lifetime.abort(new Error("Session backend disposed"))
      // Interrupt cancellable readers immediately; joining wait before retirement
      // would deadlock disposal behind an indefinitely active child.
      for (const entry of entries.values()) {
        if (entry.handle && !entry.handle.lease.signal.aborted) scopes.retire(entry.handle.lease)
      }
      disposal = (async () => {
        await Promise.allSettled([...pending])
        const results = await Promise.allSettled([...entries.values()].filter(entry => entry.record.phase !== "closed").map(cleanup))
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Child custody remains uncertain after disposal")
      })()
      return disposal
    },
    unavailable(operation: "full-history" | "inbox" | "durable-log"): never { throw new SessionBackendError("unavailable", `${operation} requires an explicitly bound public client; Context does not provide it`) },
  }
  return backend
}
