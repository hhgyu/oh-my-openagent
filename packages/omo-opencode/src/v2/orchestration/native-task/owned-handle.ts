import { randomUUID } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import {
  ChildObservationUncertain,
  type ManagedChildEvent,
  type ManagedChildHandle,
  type ManagedStartSpec,
  type TaskRecordStore,
  type OwnedSessionIdentity,
  type TaskRecord,
} from "@oh-my-opencode/senpi-task/manager-kernel"
import type { RunnerOutcome } from "@oh-my-opencode/orchestration-core/contracts/child-outcome"
import type { ChildHandle, createSessionBackend } from "../../host/session-backend"
import type { DurableChildJournal } from "../../host/child-journal"
import type { OwnedChildObserver } from "../../host/owned-child-observer"
import { retainedTurnCutOff } from "../../host/owned-child-outcome"
import { createOwnedEventProjection } from "./owned-events"
import { createOwnedManagedInput, ownedInputID } from "./managed-input"
import { createOwnedTurnTicket } from "./owned-turn"

type Backend = ReturnType<typeof createSessionBackend>
export interface OwnedTaskControl {
  readonly handle: ManagedChildHandle
  readonly child: ChildHandle
  readonly backend: Backend
  readonly observer: OwnedChildObserver
  prepareEnd(): Promise<void>
  begin(): { turnId: string; outcome: Promise<RunnerOutcome> }
  flush(): void
  end(): Promise<void>
  detach(): Promise<void>
  withInputSignal<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T>
  stopInputs(): Promise<void>
  inputDiagnostics(): ReturnType<ReturnType<typeof createOwnedManagedInput>["diagnostics"]>
  /** Arms the continuation of a turn a host restart (a process stop, a hard kill or a reload) cut
   * off: when Native reattaches this recovered child as a running task, `text` is delivered as a
   * fresh, observed turn of the new run, like Native `continueInterruptedTurn`. Nothing is sent when
   * the retained turn was not cut off (a finished or stopped turn). */
  continueAfterRestart(text: string): void
}
export async function createOwnedTaskHandle(input: {
  spec: ManagedStartSpec
  child: ChildHandle
  backend: Backend
  journal: DurableChildJournal
  observer: OwnedChildObserver
  store: TaskRecordStore
  journalKey: string
  stateDir: string
  openObserver?(key: string, signal: AbortSignal): Promise<OwnedChildObserver>
  closeRetained?(record: TaskRecord): Promise<void>
  firstInputAccepted?(): void
  readonly recovered?: boolean
}): Promise<OwnedTaskControl> {
  const { spec, child, backend, journal, store, journalKey } = input
  let observer = input.observer
  const initial = store.load(spec.taskId)
  if (!initial) throw new Error("Task record missing during owned binding")
  let epoch = initial.notification.run_epoch
  const recoveredTerminal =
    input.recovered === true &&
    !initial.killed &&
    initial.cancel_requested === undefined &&
    ["completed", "error", "interrupted"].includes(initial.status)
      ? Object.freeze({
          taskId: initial.task_id,
          createdAt: initial.created_at,
          parentSessionId: initial.parent_session_id,
          rootSessionId: initial.root_session_id,
          depth: initial.depth,
          status: initial.status,
          epoch,
          claim: initial.residency_claim,
        })
      : undefined
  let reference!: OwnedSessionIdentity,
    disposed = false,
    ended = false,
    started = false,
    busy = false
  let journalRow: Awaited<ReturnType<DurableChildJournal["read"]>>
  const guard = backend.observationGuard(child)
  async function synchronize() {
    guard()
    const row = await journal.read(journalKey)
    if (!row || row.owner !== journal.owner) throw new Error("Owned journal row unavailable")
    journal.assertCurrent(row)
    journalRow = row
    const claim = store.load(spec.taskId)?.residency_claim ?? randomUUID()
    reference = Object.freeze({
      ...child.locator,
      journalKey,
      journalOwner: row.owner,
      journalRevision: row.revision,
      runEpoch: epoch,
      residencyClaim: claim,
    })
    store.mutate(spec.taskId, (fresh) => {
      if (fresh.notification.run_epoch !== epoch || fresh.killed) throw new Error("Task run moved during owned binding")
      return {
        ...fresh,
        owned_session: reference,
        runner_kind: "owned-session",
        residency_claim: claim,
        child_session_id: child.locator.sessionID,
      }
    })
  }
  await synchronize()
  function assertOwned() {
    if (disposed) throw new Error("Owned task handle retired")
    guard()
    if (!journalRow) throw new Error("Owned journal snapshot missing")
    try {
      journal.assertCurrent(journalRow)
    } catch (error) {
      // This backend's OWN checkpoint (first-input admitting/accepted) can advance the row after
      // the snapshot, before the input port resynchronizes. guard() just proved the stored row
      // equals the backend's current record, so only that exact successor of the same custody is
      // accepted; any foreign or rewound row still fails.
      const latest = backend.currentRecord(child)
      if (
        latest.key !== journalRow.key ||
        latest.owner !== journalRow.owner ||
        latest.revision <= journalRow.revision ||
        JSON.stringify(latest.locator) !== JSON.stringify(journalRow.locator)
      )
        throw error
      journal.assertCurrent(latest)
    }
    const fresh = store.load(spec.taskId),
      current = fresh?.owned_session
    const closing = fresh?.fallback_closing_child?.owned_session
    const candidate = current?.journalKey === journalKey ? current : closing
    if (
      !fresh ||
      !candidate ||
      candidate.journalOwner !== reference.journalOwner ||
      candidate.journalRevision !== reference.journalRevision ||
      candidate.generation !== child.locator.generation ||
      candidate.sessionID !== child.locator.sessionID ||
      candidate.runEpoch !== epoch ||
      (current === candidate &&
        (fresh.notification.run_epoch !== candidate.runEpoch || fresh.residency_claim !== candidate.residencyClaim))
    )
      throw new Error("Owned task epoch or custody changed")
  }
  function retainedProjectionEpoch(): number {
    // These are our issued display keys, never host execution IDs or admission authority.
    // Reattach advances Native bookkeeping without giving retained frames new log identities.
    const prefix = `${spec.taskId}:`,
      original = journalKey.startsWith(prefix) ? journalKey.slice(prefix.length) : ""
    const key = journalRow?.turn?.observationKey ?? journalKey
    let value = original
    if (key !== journalKey) {
      const turnPrefix = `${journalKey}:turn:`
      const parts = key.startsWith(turnPrefix) ? key.slice(turnPrefix.length).split(":") : []
      if (parts.length !== 2 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[1]))
        throw new ChildObservationUncertain("owned-projection-key-invalid")
      value = parts[0]
    }
    const observedEpoch = Number(value)
    if (
      !/^(0|[1-9][0-9]*)$/.test(original) ||
      !/^(0|[1-9][0-9]*)$/.test(value) ||
      !Number.isSafeInteger(observedEpoch) ||
      observedEpoch > epoch
    )
      throw new ChildObservationUncertain("owned-projection-key-invalid")
    return observedEpoch
  }
  let projection = createOwnedEventProjection(spec.taskId, retainedProjectionEpoch(), input.stateDir, assertOwned)
  const listeners = new Set<(event: ManagedChildEvent) => void>(),
    transcript = new Set<(event: ManagedChildEvent) => void>()
  let seen = new Set<string>()
  let lastText: string | undefined, actualModel: { provider: string; id: string } | undefined
  let pumpFault: ChildObservationUncertain | undefined
  function flush() {
    if (busy) return
    assertOwned()
    const view = observer.observation()
    // Reprojecting is deterministic; own-log frame IDs reconcile lost append acknowledgements.
    for (const event of projection.events(view)) {
      const identity = projection.identity(event)
      if (identity === undefined) throw new ChildObservationUncertain("missing-projection-identity")
      // Event-level display persistence is idempotent even when identical prose occurs twice.
      for (const write of transcript) write(event)
      if (!seen.has(identity)) {
        seen.add(identity)
        const route = event.message as { provider?: string; model?: string } | undefined
        if (route?.provider && route.model) actualModel = { provider: route.provider, id: route.model }
        const message = event.message as { content?: { type: string; text: string }[] } | undefined
        const text = message?.content
          ?.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("")
        if (text) lastText = text
        for (const listener of listeners) listener(event)
      }
    }
  }
  let outcomeWait = new AbortController()
  const invocation = new AsyncLocalStorage<AbortSignal | undefined>()
  const preparation = new Set<AbortController>(),
    preparing = new Set<Promise<unknown>>(),
    ticketWork = new Set<Promise<unknown>>()
  const observers = new Set<OwnedChildObserver>([observer])
  let cleanupOnly = false
  function inputPort() {
    return createOwnedManagedInput({
      backend,
      child,
      assertOwned,
      expectInput: (id) => observer.expectInput(id),
      identify(nativeID) {
        assertOwned()
        store.mutate(spec.taskId, (fresh) => ({ ...fresh, last_effect_id: nativeID }))
      },
      synchronize,
      onUncertain() {
        pumpFault ??= new ChildObservationUncertain("input-admission-uncertain")
        outcomeWait.abort(pumpFault)
      },
    })
  }
  let managedInput = inputPort()
  const lifetime = new AbortController()
  const pump = (async () => {
    while (!lifetime.signal.aborted) {
      try {
        flush()
      } catch (error) {
        pumpFault = ChildObservationUncertain.is(error)
          ? error
          : new ChildObservationUncertain("owned-display-unavailable")
        outcomeWait.abort(pumpFault)
        break
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 20)
        function done() {
          clearTimeout(timer)
          lifetime.signal.removeEventListener("abort", done)
          resolve()
        }
        lifetime.signal.addEventListener("abort", done, { once: true })
      })
    }
  })()
  async function outcome(): Promise<RunnerOutcome> {
    const observing = observer,
      waiting = outcomeWait,
      port = managedInput
    const result = await observing.waitForOutcome(waiting.signal)
    await port.settled()
    if (observing !== observer) throw new ChildObservationUncertain("owned-turn-replaced")
    if (pumpFault) throw pumpFault
    try {
      assertOwned()
      flush()
    } catch (error) {
      throw ChildObservationUncertain.is(error)
        ? error
        : new ChildObservationUncertain("owned-outcome-custody-unavailable")
    }
    if (pumpFault) throw pumpFault
    if (result.status === "uncertain")
      throw new ChildObservationUncertain(result.reason ?? "observation-invalidated", result.startEventID)
    const model = result.model ? { model: `${result.model.providerID}/${result.model.id}` } : {}
    if (result.status === "completed") return { status: "completed", finalResponse: result.text ?? "", ...model }
    if (result.status === "interrupted") return { status: "interrupted", finalResponse: lastText, ...model }
    if (result.status === "cancelled") return { status: "cancelled" }
    if (result.status === "error")
      return {
        status: "error",
        failure: { kind: "child-turn-failed", message: result.reason ?? "host turn failed" },
        ...model,
      }
    throw new ChildObservationUncertain("missing-owned-terminal")
  }
  let current: Promise<RunnerOutcome> | undefined
  let admission: Promise<void> | undefined
  let controlTail: Promise<unknown> = Promise.resolve()
  let stopMarked = false
  let permanentEndRequested = false
  let ending: Promise<void> | undefined
  let inputGeneration = 0
  let restartContinuation: string | undefined
  function bindReattachedRun(before: TaskRecord, actual: TaskRecord): void {
    if (disposed || busy || ended || cleanupOnly) throw new Error("Owned reattach bookkeeping is unavailable")
    guard()
    if (!journalRow) throw new Error("Owned reattach journal snapshot missing")
    journal.assertCurrent(journalRow)
    const prior = before.owned_session,
      next = actual.owned_session
    const sameLocator = (value: OwnedSessionIdentity) =>
      value.format === child.locator.format &&
      value.backendID === child.locator.backendID &&
      value.location === child.locator.location &&
      value.parentID === child.locator.parentID &&
      value.sessionID === child.locator.sessionID &&
      value.generation === child.locator.generation &&
      value.hostVersion === child.locator.hostVersion &&
      value.journalKey === journalKey &&
      value.journalOwner === journal.owner
    if (
      before.task_id !== spec.taskId ||
      actual.task_id !== spec.taskId ||
      before.notification.run_epoch !== epoch ||
      actual.notification.run_epoch !== Math.max(epoch, before.burnt_epoch ?? 0) + 1 ||
      actual.status !== "running" ||
      actual.killed ||
      before.parent_session_id !== actual.parent_session_id ||
      actual.parent_session_id !== child.locator.parentID ||
      actual.child_session_id !== child.locator.sessionID ||
      before.root_session_id !== actual.root_session_id ||
      before.depth !== actual.depth ||
      before.residency_claim !== actual.residency_claim ||
      !prior ||
      !next ||
      !sameLocator(prior) ||
      !sameLocator(next) ||
      prior.runEpoch !== epoch ||
      prior.residencyClaim !== reference.residencyClaim ||
      next.residencyClaim !== prior.residencyClaim ||
      prior.journalRevision !== journalRow.revision ||
      next.journalRevision !== prior.journalRevision ||
      next.runEpoch !== actual.notification.run_epoch ||
      JSON.stringify(store.load(spec.taskId)) !== JSON.stringify(actual) ||
      (journalRow.turn && journalRow.turn.nativeEpoch !== epoch)
    )
      throw new Error("Canonical owned reattach receipt differs from current custody")
    // A turn a host restart cut off continues as a new observed turn of this run (Native
    // `continueInterruptedTurn`); the dead turn's observation uncertainty then names no turn of it.
    const continuation = restartContinuation
    restartContinuation = undefined
    const continuing =
      continuation !== undefined &&
      input.recovered === true &&
      !started &&
      current === undefined &&
      retainedTurnCutOff(observer.observation().records)
    // The Native operation has already published this epoch. Only that exact receipt may
    // advance bookkeeping; retained observation/projection/history are deliberately unchanged.
    busy = true
    try {
      const row = backend.checkpointTurn(child, {
        nativeEpoch: actual.notification.run_epoch,
        observationKey: journalRow.turn?.observationKey ?? journalKey,
        ...(journalRow.turn?.firstInputID ? { firstInputID: journalRow.turn.firstInputID } : {}),
      })
      epoch = actual.notification.run_epoch
      journalRow = row
      reference = Object.freeze({ ...next, journalRevision: row.revision })
      store.mutate(spec.taskId, (fresh) => {
        if (JSON.stringify(fresh) !== JSON.stringify(actual))
          throw new Error("Canonical owned reattach record moved during checkpoint")
        if (!continuing) return { ...fresh, owned_session: reference }
        const { observation_uncertain: _deadTurn, ...live } = fresh
        return { ...live, owned_session: reference }
      })
    } catch (error) {
      // Never roll back the actual Native publication. The same real record/journal
      // identity remains usable for independent permanent cleanup, not new input/grants.
      epoch = actual.notification.run_epoch
      cleanupOnly = true
      pumpFault = new ChildObservationUncertain("reattach-bookkeeping-unconfirmed")
      outcomeWait.abort(pumpFault)
      throw error
    } finally {
      busy = false
    }
    if (continuing) continueCutTurn(continuation)
  }
  /** Native `continueInterruptedTurn` for a recovered child whose turn a host restart cut off: the
   * retained observation of the dead turn stays uncertain, so the continuation is a NEW turn of the
   * run Native just published, observed under its own key from its own input. Its outcome is this
   * handle's outcome; a continuation that cannot be dispatched settles that outcome as uncertain
   * (never replayed), exactly like any unconfirmed owned input. */
  function continueCutTurn(text: string): void {
    const nativeID = `owned-restart-continuation:${spec.taskId}:${epoch}:${randomUUID()}`
    const hostID = ownedInputID(child.locator, nativeID),
      key = `${journalKey}:turn:${epoch}:${randomUUID()}`
    const work = controlTail.then(async () => {
      let fresh: OwnedChildObserver | undefined
      try {
        if (!input.openObserver) throw Error("Owned continuation observer port missing")
        fresh = await input.openObserver(key, lifetime.signal)
        observers.add(fresh)
        assertOwned()
      } catch {
        if (fresh) {
          observers.delete(fresh)
          await fresh.dispose().catch(() => {})
        }
        pumpFault = new ChildObservationUncertain("restart-continuation-unavailable")
        throw pumpFault
      }
      const prior = observer,
        priorInput = managedInput
      let attempt: ReturnType<Backend["preparePromptContinuation"]> | undefined
      busy = true
      try {
        const row = backend.checkpointTurn(child, { nativeEpoch: epoch, observationKey: key, firstInputID: hostID })
        journalRow = row
        reference = Object.freeze({ ...reference, journalRevision: row.revision })
        store.mutate(spec.taskId, (value) => {
          if (
            value.notification.run_epoch !== epoch ||
            value.residency_claim !== reference.residencyClaim ||
            value.killed
          )
            throw Error("Task run moved before its restart continuation")
          return { ...value, owned_session: reference, last_effect_id: nativeID }
        })
        observer = fresh
        projection = createOwnedEventProjection(spec.taskId, epoch, input.stateDir, assertOwned)
        seen = new Set()
        lastText = undefined
        actualModel = undefined
        pumpFault = undefined
        outcomeWait = new AbortController()
        stopMarked = false
        managedInput = inputPort()
        fresh.expectInput(hostID)
        attempt = backend.preparePromptContinuation(
          child,
          { id: hostID, text, delivery: "queue", resume: true },
          { signal: lifetime.signal },
        )
        await attempt.send()
        await synchronize()
      } catch {
        try {
          await synchronize()
        } catch {
          /* The local uncertainty below still settles the outcome. */
        }
        pumpFault = new ChildObservationUncertain(
          attempt?.invoked() ? "restart-continuation-admission-uncertain" : "restart-continuation-not-dispatched",
        )
        outcomeWait.abort(pumpFault)
        throw pumpFault
      } finally {
        busy = false
      }
      // The continuation is admitted: a failed retirement of the dead turn's observer cannot undo it.
      observers.delete(prior)
      await Promise.allSettled([priorInput.close(), prior.dispose()])
    })
    controlTail = work.catch(() => {})
    admission = work
    current = work.then(outcome)
    void current.catch(() => {})
  }
  function markStopping() {
    if (stopMarked || disposed || ended) return
    try {
      observer.markStopping()
      stopMarked = true
    } catch (error) {
      if (!permanentEndRequested) throw error
      // An explicit permanent end has durable Native cancellation intent and P0's
      // closing journal. A broken observer cannot supply Stop evidence; retain that
      // uncertainty while allowing the independent, fenced close/wait/remove path.
      pumpFault ??= new ChildObservationUncertain("stop-observation-unavailable")
    }
  }
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = controlTail.then(async () => {
      await admission?.catch(() => {})
      return await operation()
    })
    controlTail = next.catch(() => {})
    return next
  }
  function settledObservation(): boolean {
    const result = observer.outcome()
    if (result.status === "uncertain")
      throw new ChildObservationUncertain(result.reason ?? "observation-invalidated", result.startEventID)
    if (settledStatus(result.status)) return true
    // A local Stop suppresses completed. Its actual terminal reference still proves the
    // observed turn settled; returning from abort does NOT relabel that as host interruption.
    return (
      result.reason === "stop-pending" &&
      (result.delivered.length > 0 || result.continuation === true) &&
      !!result.terminalEventID &&
      observer
        .observation()
        .records.some(
          (row) =>
            row.kind === "host" &&
            row.id === result.terminalEventID &&
            ["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"].includes(
              row.event.type,
            ),
        )
    )
  }
  async function awaitObservedSettlement() {
    const signal = AbortSignal.timeout(10_000)
    while (!settledObservation()) {
      signal.throwIfAborted()
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    }
  }
  async function retire(detach: boolean) {
    if (disposed) return
    await managedInput.close()
    if (cleanupOnly && permanentEndRequested && !ended) {
      const record = await assertEndAuthority()
      if (!input.closeRetained) throw new Error("Permanent retained cleanup port missing")
      await input.closeRetained(record)
      await backend.confirmClosed(child)
      ended = true
    }
    if (detach && !ended) {
      // Lose local outcome ownership first, without claiming a Native terminal or pause ACK.
      // The actual observer and policy hook remain installed until the host is quiescent.
      pumpFault ??= new ChildObservationUncertain("observer-detached")
      outcomeWait.abort(pumpFault)
      busy = true
      try {
        await backend.interrupt(child) // Public interrupt explicitly uses resume:false.
        await synchronize()
        await backend.waitForControlIdle(child)
      } finally {
        busy = false
      }
    }
    lifetime.abort()
    await pump
    for (const owned of observers) {
      await owned.dispose()
      observers.delete(owned)
    }
    if (detach && !ended) await backend.detach(child)
    disposed = true
    listeners.clear()
    transcript.clear()
  }
  async function endNow() {
    const closingRecord = await assertEndAuthority()
    permanentEndRequested = true
    busy = true
    try {
      if (cleanupOnly && input.closeRetained) {
        await input.closeRetained(closingRecord)
        await backend.confirmClosed(child)
      } else await backend.close(child)
      ended = true
    } catch (error) {
      // A failed permanent end may already have retired its live child lease. Retain
      // independent real cleanup custody; never retry it as a runnable session.
      cleanupOnly = true
      pumpFault ??= new ChildObservationUncertain("owned-end-cleanup-unconfirmed")
      outcomeWait.abort(pumpFault)
      throw error
    } finally {
      if (!ended && !cleanupOnly) await synchronize()
      busy = false
    }
    await retire(false)
  }
  async function assertEndAuthority(): Promise<TaskRecord> {
    if (!cleanupOnly) {
      assertOwned()
      const record = store.load(spec.taskId)
      if (!record) throw Error("Owned task record is absent at end authority")
      return record
    }
    const before = store.load(spec.taskId),
      ref = before?.owned_session
    const actual = await journal.read(journalKey)
    if (
      !before ||
      !ref ||
      !actual ||
      actual.owner !== journal.owner ||
      ref.journalOwner !== journal.owner ||
      before.notification.run_epoch !== epoch ||
      ref.runEpoch !== epoch ||
      before.residency_claim !== ref.residencyClaim ||
      ref.sessionID !== child.locator.sessionID ||
      ref.parentID !== child.locator.parentID ||
      ref.location !== child.locator.location ||
      ref.backendID !== child.locator.backendID ||
      ref.generation !== child.locator.generation ||
      ref.hostVersion !== child.locator.hostVersion ||
      actual.locator.sessionID !== ref.sessionID ||
      actual.locator.parentID !== ref.parentID ||
      actual.locator.location !== ref.location ||
      actual.locator.backendID !== ref.backendID ||
      actual.locator.hostVersion !== ref.hostVersion ||
      actual.locator.generation < ref.generation ||
      actual.revision < ref.journalRevision
    )
      throw new Error("Owned cleanup-only custody unavailable")
    const fresh = store.load(spec.taskId)
    if (
      fresh?.notification.run_epoch !== epoch ||
      fresh.residency_claim !== ref.residencyClaim ||
      fresh.owned_session?.journalOwner !== ref.journalOwner
    )
      throw new Error("Owned cleanup-only record moved")
    return fresh
  }
  function end(): Promise<void> {
    if (ending) return ending
    const stopped = stopInputs()
    const next = serialize(async () => {
      await stopped
      return endNow()
    })
    ending = next
    void next.catch(() => {
      if (ending === next) ending = undefined
    })
    return next
  }
  function prepareFollowUp(prior: TaskRecord, nextEpoch: number) {
    if (
      preparation.size ||
      prior.task_id !== spec.taskId ||
      prior.notification.run_epoch !== epoch ||
      nextEpoch <= epoch
    )
      return Promise.reject(new Error("Owned turn preparation is already held or names a stale run"))
    const controller = new AbortController(),
      observerLifetime = new AbortController()
    const caller = invocation.getStore(),
      signal = AbortSignal.any([controller.signal, ...(caller ? [caller] : [])])
    preparation.add(controller)
    let published = false
    const abortSetup = () => {
      if (!published) observerLifetime.abort(signal.reason)
    }
    signal.addEventListener("abort", abortSetup)
    const work = serialize(async () => {
      signal.throwIfAborted()
      assertOwned()
      await managedInput.settled()
      await current
      if (!input.openObserver) throw new Error("Owned prior turn is not positively settled")
      const needsRecoveredBarrier = !!pumpFault || !settledStatus(observer.outcome().status)
      const matchesRecoveredTerminal = (record: TaskRecord | null) =>
        !!recoveredTerminal &&
        !!record &&
        epoch === recoveredTerminal.epoch &&
        prior.notification.run_epoch === recoveredTerminal.epoch &&
        record.task_id === recoveredTerminal.taskId &&
        record.created_at === recoveredTerminal.createdAt &&
        record.parent_session_id === recoveredTerminal.parentSessionId &&
        record.root_session_id === recoveredTerminal.rootSessionId &&
        record.depth === recoveredTerminal.depth &&
        record.status === recoveredTerminal.status &&
        record.notification.run_epoch === recoveredTerminal.epoch &&
        record.residency_claim === recoveredTerminal.claim &&
        !record.killed &&
        record.cancel_requested === undefined
      if (needsRecoveredBarrier) {
        if (!matchesRecoveredTerminal(store.load(spec.taskId)))
          throw new Error("Owned prior turn is not positively settled")
        // The actual private control and Native continuation already authorize this operation.
        // This wait supplies quiescence only; old history/outcome remains uncertain.
        await backend.waitForControlIdle(child, signal)
        signal.throwIfAborted()
        assertOwned()
        if (!matchesRecoveredTerminal(store.load(spec.taskId)))
          throw new Error("Recovered terminal identity moved during idle barrier")
      }
      const row = await journal.read(journalKey)
      signal.throwIfAborted()
      assertOwned()
      if (!row || (row.turn && row.turn.nativeEpoch !== epoch))
        throw new Error("Owned turn descriptor does not name the current run")
      journal.assertCurrent(row)
      if (
        needsRecoveredBarrier &&
        (!matchesRecoveredTerminal(store.load(spec.taskId)) ||
          row.phase !== "accepted" ||
          row.admission !== "accepted" ||
          !row.inboxID ||
          row.receipts[row.inboxID] !== "accepted")
      )
        throw new Error("Recovered terminal has no current accepted input ledger")
      const assertPreparedOwned = () => {
        assertOwned()
        if (needsRecoveredBarrier && !published) {
          if (!matchesRecoveredTerminal(store.load(spec.taskId)))
            throw new Error("Recovered terminal identity changed before new turn publication")
          journal.assertCurrent(row)
        }
      }
      const previous = {
        epoch,
        observer,
        projection,
        seen,
        lastText,
        actualModel,
        pumpFault,
        outcomeWait,
        managedInput,
        current,
        admission,
        stopMarked,
        reference,
        journalRow,
        cleanupOnly,
      }
      const key = `${journalKey}:turn:${nextEpoch}:${randomUUID()}`
      let fresh: OwnedChildObserver | undefined
      try {
        fresh = await input.openObserver(key, observerLifetime.signal)
        observers.add(fresh)
        signal.throwIfAborted()
        assertPreparedOwned()
        const nextObserver = fresh
        const finish = () => {
          preparation.delete(controller)
          signal.removeEventListener("abort", abortSetup)
        }
        const referenceFrom = (actual: typeof row, at: number, claim: string): OwnedSessionIdentity =>
          Object.freeze({
            ...child.locator,
            journalKey,
            journalOwner: actual.owner,
            journalRevision: actual.revision,
            runEpoch: at,
            residencyClaim: claim,
          })
        return createOwnedTurnTicket({
          prior,
          nextEpoch,
          child,
          backend,
          observer: nextObserver,
          observationKey: key,
          priorDescriptor: row.turn,
          signal,
          assertOwned: assertPreparedOwned,
          identify(id) {
            assertOwned()
            store.mutate(spec.taskId, (value) => ({ ...value, last_effect_id: id }))
          },
          publish(actual, next, pending) {
            busy = true
            published = true
            epoch = nextEpoch
            observer = nextObserver
            projection = createOwnedEventProjection(spec.taskId, epoch, input.stateDir, assertOwned)
            seen = new Set()
            lastText = undefined
            actualModel = undefined
            pumpFault = undefined
            outcomeWait = new AbortController()
            stopMarked = false
            cleanupOnly = false
            journalRow = actual
            reference = referenceFrom(actual, epoch, next.residency_claim ?? previous.reference.residencyClaim)
            managedInput = inputPort()
            admission = pending
            current = pending.then(outcome)
            void current.catch(() => {})
            return reference
          },
          restoreReference(actual, old) {
            journalRow = actual
            reference = referenceFrom(
              actual,
              old.notification.run_epoch,
              old.residency_claim ?? previous.reference.residencyClaim,
            )
            return reference
          },
          synchronize,
          async accepted() {
            busy = false
            finish()
            await previous.managedInput.close()
            await previous.observer.dispose()
            observers.delete(previous.observer)
          },
          failure(reason) {
            finish()
            busy = false
            cleanupOnly = true
            pumpFault = new ChildObservationUncertain("owned-turn-unadmitted-or-unconfirmed")
            pumpFault.message += `: ${reason}`
            outcomeWait.abort(pumpFault)
          },
          async release() {
            try {
              const actual = await journal.read(journalKey),
                native = store.load(spec.taskId)
              if (!actual || actual.owner !== journal.owner || !native)
                throw new Error("Unpublished turn custody unavailable")
              if (
                native.notification.run_epoch === previous.epoch &&
                native.residency_claim === previous.reference.residencyClaim &&
                native.owned_session?.journalOwner === previous.reference.journalOwner &&
                native.owned_session.sessionID === child.locator.sessionID
              ) {
                const restored =
                  actual.turn?.observationKey === row.turn?.observationKey
                    ? actual
                    : backend.checkpointTurn(child, row.turn)
                journal.assertCurrent(restored)
                const oldReference = referenceFrom(restored, previous.epoch, previous.reference.residencyClaim)
                store.mutate(spec.taskId, (value) => {
                  if (
                    value.notification.run_epoch !== previous.epoch ||
                    value.residency_claim !== previous.reference.residencyClaim ||
                    value.owned_session?.journalOwner !== previous.reference.journalOwner
                  )
                    throw new Error("Prior run moved during ticket release")
                  return { ...value, owned_session: oldReference }
                })
                epoch = previous.epoch
                observer = previous.observer
                projection = previous.projection
                seen = previous.seen
                lastText = previous.lastText
                actualModel = previous.actualModel
                pumpFault = previous.pumpFault
                outcomeWait = previous.outcomeWait
                managedInput = previous.managedInput
                current = previous.current
                admission = previous.admission
                stopMarked = previous.stopMarked
                reference = oldReference
                journalRow = restored
                cleanupOnly = previous.cleanupOnly
              } else if (published) {
                cleanupOnly = true
                pumpFault = new ChildObservationUncertain("prepared-turn-superseded")
                outcomeWait.abort(pumpFault)
              }
              await nextObserver.dispose()
              observers.delete(nextObserver)
            } catch (error) {
              cleanupOnly = true
              pumpFault = new ChildObservationUncertain("prepared-turn-release-unconfirmed")
              outcomeWait.abort(pumpFault)
              throw error
            } finally {
              finish()
              busy = false
            }
          },
          track(pending) {
            ticketWork.add(pending)
            void pending.finally(() => ticketWork.delete(pending)).catch(() => {})
          },
          serialize<T>(operation: () => Promise<T>) {
            // This operation OWNS the new admission gate; waiting for that same gate here
            // would deadlock. Later direct Native controls/inputs still queue behind it.
            const next = controlTail.then(operation)
            controlTail = next.catch(() => {})
            return next
          },
        })
      } catch (error) {
        signal.removeEventListener("abort", abortSetup)
        preparation.delete(controller)
        if (fresh) {
          await fresh.dispose()
          observers.delete(fresh)
        }
        throw error
      }
    })
    preparing.add(work)
    void work
      .then(
        () => {
          preparing.delete(work)
          if (!published && signal.aborted) preparation.delete(controller)
        },
        (error) => {
          preparing.delete(work)
          preparation.delete(controller)
          signal.removeEventListener("abort", abortSetup)
          observerLifetime.abort(error)
        },
      )
      .catch(() => {})
    return work
  }
  const handle: ManagedChildHandle = {
    task_id: spec.taskId,
    sessionId: child.locator.sessionID,
    pid: undefined,
    kind: "owned-session",
    observationCoverage: "partial",
    get ownedSession() {
      return store.load(spec.taskId)?.owned_session ?? reference
    },
    assertOwned,
    bindReattachedRun,
    effectiveModel: () => actualModel,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    subscribeTranscript(sink) {
      const write = (event: ManagedChildEvent) => projection.persist(sink, event)
      transcript.add(write)
      flush()
      return () => {
        transcript.delete(write)
      }
    },
    waitForOutcome() {
      if (!current) {
        const known = observer.outcome()
        return Promise.reject(new ChildObservationUncertain(known.reason ?? "input-not-admitted"))
      }
      return current
    },
    lastAssistantText: () => lastText,
    markStopping,
    abort: () => {
      const stopped = stopInputs()
      return serialize(async () => {
        await stopped
        assertOwned()
        markStopping()
        busy = true
        try {
          await backend.interrupt(child)
          await synchronize()
        } finally {
          busy = false
        }
        await awaitObservedSettlement()
      })
    },
    steer: (text, identity) => enqueueInput(text, "steer", identity),
    followUp: (text, identity) => enqueueInput(text, "queue", identity),
    prepareFollowUp,
    terminate: end,
    dispose: () => {
      const stopped = stopInputs()
      return serialize(async () => {
        await stopped
        return retire(true)
      })
    },
  }
  function enqueueInput(text: string, delivery: "steer" | "queue", identity?: { readonly clientMessageId: string }) {
    const generation = inputGeneration
    return serialize(() => {
      if (generation !== inputGeneration) throw new Error("Owned input stopped before dispatch")
      return activeInput(text, delivery, identity)
    })
  }
  async function activeInput(
    text: string,
    delivery: "steer" | "queue",
    identity?: { readonly clientMessageId: string },
  ) {
    assertOwned()
    if (pumpFault) throw pumpFault
    const record = store.load(spec.taskId)
    const observed = observer.outcome()
    if (observed.status === "uncertain")
      throw new ChildObservationUncertain(observed.reason ?? "input-observation-unavailable", observed.startEventID)
    if (
      record?.status !== "running" ||
      record.notification.run_epoch !== epoch ||
      settledStatus(observed.status)
    ) {
      throw new Error("Owned managed idle turn is not bound; no input dispatched")
    }
    busy = true
    try {
      await managedInput.withSignal(invocation.getStore(), () => managedInput.send(text, delivery, identity))
    } finally {
      busy = false
    }
  }
  function stopInputs(): Promise<void> {
    inputGeneration++
    for (const controller of preparation) controller.abort(new Error("Owned turn stopped by control"))
    if (preparing.size || ticketWork.size)
      return Promise.allSettled([managedInput.abortPending(), ...preparing, ...ticketWork]).then(() => {})
    if (!managedInput.hasPending()) return Promise.resolve()
    // The private pending request owns its intermediate journal revisions. Validate actual
    // backend custody and unchanged Native identity without mistaking that known write for theft.
    guard()
    const fresh = store.load(spec.taskId),
      current = fresh?.owned_session
    if (
      !fresh ||
      !current ||
      disposed ||
      current.journalOwner !== reference.journalOwner ||
      current.sessionID !== child.locator.sessionID ||
      current.generation !== child.locator.generation ||
      fresh.notification.run_epoch !== epoch ||
      current.residencyClaim !== reference.residencyClaim
    )
      throw new Error("Owned input control custody changed")
    return managedInput.abortPending()
  }
  return {
    handle,
    child,
    backend,
    get observer() {
      return observer
    },
    flush,
    stopInputs,
    withInputSignal: (signal, operation) => invocation.run(signal, operation),
    inputDiagnostics: () => managedInput.diagnostics(),
    continueAfterRestart(text) {
      restartContinuation = text
    },
    prepareEnd() {
      const stopped = stopInputs()
      return serialize(async () => {
        await stopped
        await assertEndAuthority()
        permanentEndRequested = true
      })
    },
    end,
    detach: () => {
      const stopped = stopInputs()
      return serialize(async () => {
        await stopped
        return retire(true)
      })
    },
    begin() {
      assertOwned()
      if (started) throw new Error("Original task input cannot be replayed")
      started = true
      const id = `msg_native_${randomUUID().replaceAll("-", "")}`
      observer.expectInput(id)
      admission = (async () => {
        busy = true
        try {
          await backend.begin(child, { id, text: spec.prompt })
          input.firstInputAccepted?.()
          await synchronize()
        } catch {
          // An RPC/admission failure is not a model failure or permission to replay.
          // Refresh the retained control fence if possible; observation remains uncertain.
          try {
            await synchronize()
          } catch {
            /* The local uncertainty channel still settles waiters. */
          }
          throw new ChildObservationUncertain("input-admission-uncertain")
        } finally {
          busy = false
        }
      })()
      current = admission.then(outcome)
      void current.catch(() => {})
      return { turnId: id, outcome: current }
    },
  }
}

/** An observed turn the observer settled; `cancelled` is a local Stop of a held turn (omo#9069). */
function settledStatus(status: string): boolean {
  return status === "completed" || status === "error" || status === "interrupted" || status === "cancelled"
}
