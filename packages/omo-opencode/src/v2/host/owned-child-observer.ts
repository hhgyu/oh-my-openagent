import type { Context } from "@opencode/plugin/promise/plugin"
import { randomUUID } from "node:crypto"
import type { ChildHandle } from "./session-backend"
import { normalizeOwnedChildEvent, observedModelSchema, type ObservationRecord, type OwnedChildObservationStore, type OwnedChildOutcome } from "./owned-child-observation-types"
import { projectOwnedChildOutcome } from "./owned-child-outcome"

type Host = Pick<Context, "session" | "event">
export interface OwnedChildObserverOptions {
  readonly key: string
  readonly child: ChildHandle
  readonly guard: () => void
  readonly store: OwnedChildObservationStore
  /** Install the actual task title as the public pre-input event barrier. */
  readonly title: string
  readonly timeoutMs?: number
  /** Observer lifetime, not the run gate: Stop must remain observable. */
  readonly signal?: AbortSignal
}
export interface OwnedChildObserver {
  expectInput(inboxID: string): void
  markStopping(): void
  outcome(): OwnedChildOutcome
  waitForOutcome(signal?: AbortSignal): Promise<OwnedChildOutcome>
  dispose(): Promise<void>
}

/** Internal real-host port; no task tools or automatic orchestration registration. */
export async function createOwnedChildObserver(ctx: Host, options: OwnedChildObserverOptions): Promise<OwnedChildObserver> {
  if (!options.title.trim() || options.title.length > 4096) throw new Error("Observation requires a bounded task title")
  const timeout = options.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error("Invalid observation readiness timeout")
  options.guard()
  const bound = options.store.bind({ key: options.key, locator: options.child.locator, guard: options.guard })
  const controller = new AbortController()
  const registrations: { dispose(): Promise<void> | void }[] = []
  const waiters = new Set<(result: OwnedChildOutcome) => void>()
  let fault: string | undefined, disposed = false, disposal: Promise<void> | undefined
  let expectedInput = false, readySeen = false
  let readyResolve!: () => void, readyReject!: (error: Error) => void
  const ready = new Promise<void>((yes, no) => { readyResolve = yes; readyReject = no })
  // A startup failure can reject before title installation has returned.
  void ready.catch(() => {})
  let setupDone!: () => void
  const setup = new Promise<void>(yes => { setupDone = yes })
  let pump: Promise<void> = Promise.resolve()
  const uncertain = (): OwnedChildOutcome => ({ status: "uncertain", reason: fault ?? "observer-disposed", delivered: [], consumption: "unconfirmed" })
  function outcome(): OwnedChildOutcome {
    if (fault || disposed) return uncertain()
    try { return projectOwnedChildOutcome(bound.snapshot()) }
    catch { fail("observation-store-unavailable"); return uncertain() }
  }
  function notify() {
    const result = outcome()
    if (result.status === "pending" || result.status === "control-only") return
    for (const settle of [...waiters]) settle(result)
  }
  function fail(reason: string) {
    if (!fault) {
      fault = reason
      try { bound.invalidate(reason) } catch { /* Old bindings cannot downgrade their replacement. */ }
    }
    readyReject(new Error(reason))
    controller.abort(new Error(reason))
    for (const settle of [...waiters]) settle(uncertain())
  }
  function append(record: ObservationRecord) {
    if (disposed || fault) throw new Error("Child observer is unavailable")
    try { bound.append(record) } catch { fail("observation-append-failed"); throw new Error("Child observation could not be persisted") }
    notify()
  }
  async function register(promise: Promise<{ dispose(): Promise<void> | void }>) {
    const handle = await promise
    if (disposed || fault) await handle.dispose()
    else registrations.push(handle)
  }
  const signals = [options.child.lease.signal, ...(options.signal ? [options.signal] : [])]
  const lifetime = AbortSignal.any(signals)
  function onAbort() { fail("observation-lifetime-ended"); void dispose().catch(() => {}) }
  lifetime.addEventListener("abort", onAbort, { once: true })
  async function dispose(): Promise<void> {
    if (disposal) return disposal
    disposed = true
    fail("observer-disposed")
    lifetime.removeEventListener("abort", onAbort)
    disposal = (async () => {
      await setup
      await pump
      const results = await Promise.allSettled(registrations.splice(0).map(handle => Promise.resolve().then(() => handle.dispose())))
      if (results.some(result => result.status === "rejected")) throw new Error("Observer hook cleanup incomplete")
    })()
    return disposal
  }
  const readinessTimer = setTimeout(() => fail("observation-readiness-timeout"), timeout)
  try {
    if (lifetime.aborted) throw new Error("Observation lifetime already ended")
    await register(ctx.session.hook("model.request", request => {
      if (disposed || fault || request.sessionID !== options.child.locator.sessionID) return
      try {
        if (request.kind === "primary") append({ kind: "primary", id: randomUUID(), model: observedModelSchema.parse(request.model) })
        else append({ kind: "auxiliary", id: randomUUID(), requestKind: request.kind })
      } catch { fail("model-observation-unavailable") }
    }))
    if (disposed || fault) throw new Error("Observation setup stopped")
    pump = (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          if (disposed || fault) break
          const event = normalizeOwnedChildEvent(raw, options.child.locator.sessionID)
          if (!event) continue
          // Full text is carried by text.ended; transient deltas cannot prove a result.
          if (!event.durable && event.type.endsWith(".delta")) continue
          append({ kind: "host", id: event.id, event })
          if (!readySeen && event.durable) { readySeen = true; readyResolve() }
        }
        if (!disposed && !fault) fail("observation-stream-ended")
      } catch { if (!disposed && !fault) fail("observation-stream-failed") }
    })()
    // onActivity is not invoked by the 2.2.6 direct Promise plugin adapter.
    // An observed owned event, rather than wait() or a sleep, establishes readiness.
    options.guard()
    await ctx.session.update({ sessionID: options.child.locator.sessionID, title: options.title }, { signal: controller.signal })
    options.guard()
    await ready
    clearTimeout(readinessTimer)
    if (disposed || fault) throw new Error("Observation setup stopped")
    options.guard()
    setupDone()
    return {
      expectInput(inboxID) {
        append({ kind: "input", id: `input:${inboxID}`, inboxID })
        expectedInput = true
      },
      markStopping() { append({ kind: "stop", id: randomUUID() }) },
      outcome,
      waitForOutcome(signal) {
        if (!expectedInput) return Promise.reject(new Error("Record the expected owned input before waiting"))
        if (signal?.aborted) return Promise.reject(signal.reason)
        const current = outcome()
        if (current.status !== "pending" && current.status !== "control-only") return Promise.resolve(current)
        return new Promise<OwnedChildOutcome>((resolve, reject) => {
          const settle = (result: OwnedChildOutcome) => { waiters.delete(settle); signal?.removeEventListener("abort", abort); resolve(result) }
          const abort = () => { waiters.delete(settle); signal?.removeEventListener("abort", abort); reject(signal?.reason) }
          waiters.add(settle)
          signal?.addEventListener("abort", abort, { once: true })
          if (signal?.aborted) abort()
          else notify()
        })
      },
      dispose,
    }
  } catch (error) {
    clearTimeout(readinessTimer)
    fail("observation-setup-failed")
    setupDone()
    await dispose()
    throw error
  }
}
