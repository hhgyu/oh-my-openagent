import type { Context } from "@opencode/plugin/promise/plugin"
import type { ChildCompletionPolicy } from "@oh-my-opencode/orchestration-core/contracts/child-outcome"
import { randomUUID } from "node:crypto"
import {
  createHeldTurnSettlement,
  createWakeSourceLedger,
  sessionIsIdle,
  type TurnSettlementScheduler,
} from "@oh-my-opencode/senpi-task/manager-kernel"
import type { ChildHandle } from "./session-backend"
import {
  normalizeOwnedChildEvent,
  observedModelSchema,
  toolMetadataRecordID,
  type ObservationRecord,
  type OwnedChildObservationStore,
  type OwnedChildOutcome,
  type OwnedChildObservationView,
  type SafeToolMetadata,
} from "./owned-child-observation-types"
import { openOwnedToolMetadataSubscription, type OwnedToolMetadataSource } from "./effect-tool-metadata-source"
import { hasJoinedSessionCancellation } from "./session-cancellation"
import { ownedChildSessionState, projectOwnedChildOutcome } from "./owned-child-outcome"

type Host = Pick<Context, "session" | "event">
export interface OwnedChildObserverOptions {
  readonly key: string
  readonly child: ChildHandle
  readonly guard: () => void
  readonly store: OwnedChildObservationStore
  /** Install the actual task title as the public pre-input event barrier. */
  readonly title: string
  readonly timeoutMs?: number
  /** Internal caller policy; captured once before custody binding or host calls. */
  readonly completion?: ChildCompletionPolicy
  /** Observer lifetime, not the run gate: Stop must remain observable. */
  readonly signal?: AbortSignal
  /** Acquired in the genuine public Effect root scope before this observer. */
  readonly toolMetadataSource?: OwnedToolMetadataSource
  /** Held-error confirmation (Native `settleConfirmMs`, default the Native heartbeat interval). */
  readonly settlement?: { readonly confirmMs?: number; readonly schedule?: TurnSettlementScheduler }
}

const DEFAULT_SETTLE_CONFIRM_MS = 10_000

type ShellLifecycle = { readonly type: "created" | "ended"; readonly key: string; readonly sessionID?: unknown }

function readRecord(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
}

/** The host's global `shell.*` events carry no session field; the shell tool tags `metadata.sessionID`. */
function shellLifecycle(raw: unknown): ShellLifecycle | undefined {
  const type = readRecord(raw, "type"),
    data = readRecord(raw, "data")
  if (type === "shell.created") {
    const info = readRecord(data, "info"),
      id = readRecord(info, "id")
    if (typeof id !== "string") return undefined
    return { type: "created", key: `shell:${id}`, sessionID: readRecord(readRecord(info, "metadata"), "sessionID") }
  }
  if (type === "shell.exited" || type === "shell.deleted") {
    const id = readRecord(data, "id")
    return typeof id === "string" ? { type: "ended", key: `shell:${id}` } : undefined
  }
  return undefined
}
export interface OwnedChildObserver {
  expectInput(inboxID: string): void
  markStopping(): void
  outcome(): OwnedChildOutcome
  observation(): OwnedChildObservationView
  waitForOutcome(signal?: AbortSignal): Promise<OwnedChildOutcome>
  dispose(): Promise<void>
}

/** Internal real-host port; no task tools or automatic orchestration registration. */
export async function createOwnedChildObserver(
  ctx: Host,
  options: OwnedChildObserverOptions,
): Promise<OwnedChildObserver> {
  const completion = options.completion
  const toolMetadataSource = options.toolMetadataSource
  if (completion !== undefined && completion !== "final-text" && completion !== "turn")
    throw new Error("Invalid child completion policy")
  if (!hasJoinedSessionCancellation(ctx.session))
    throw new Error("Child observation requires joined session cancellation")
  if (!options.title.trim() || options.title.length > 4096) throw new Error("Observation requires a bounded task title")
  const confirmMs = options.settlement?.confirmMs ?? DEFAULT_SETTLE_CONFIRM_MS
  if (!Number.isSafeInteger(confirmMs) || confirmMs < 1) throw new Error("Invalid settlement confirmation delay")
  const schedule = options.settlement?.schedule
  const timeout = options.timeoutMs ?? 5000
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
    throw new Error("Invalid observation readiness timeout")
  options.guard()
  // Validate source provenance before binding or installing any observer hooks.
  const metadataSubscription =
    toolMetadataSource === undefined
      ? undefined
      : openOwnedToolMetadataSubscription(toolMetadataSource, options.child.locator.sessionID)
  let bound: ReturnType<OwnedChildObservationStore["bind"]>
  try {
    bound = options.store.bind({ key: options.key, locator: options.child.locator, guard: options.guard })
  } catch (error) {
    metadataSubscription?.close()
    throw error
  }
  const controller = new AbortController()
  const registrations: { dispose(): Promise<void> | void }[] = []
  const waiters = new Set<(result: OwnedChildOutcome) => void>()
  let fault: string | undefined,
    disposed = false,
    disposal: Promise<void> | undefined
  let expectedInput = false,
    readySeen = false
  let readyResolve!: () => void, readyReject!: (error: Error) => void
  const ready = new Promise<void>((yes, no) => {
    readyResolve = yes
    readyReject = no
  })
  // A startup failure can reject before title installation has returned.
  void ready.catch(() => {})
  let setupDone!: () => void
  const setup = new Promise<void>((yes) => {
    setupDone = yes
  })
  let pump: Promise<void> = Promise.resolve()
  let metadataPump: Promise<void> = Promise.resolve()
  let metadataIssue: string | undefined
  const metadataCalls = new Map<string, SafeToolMetadata>()
  function metadataGap(reason: string) {
    if (metadataIssue) return
    metadataIssue = reason
    append({ kind: "tool-metadata-gap", id: randomUUID(), reason })
  }
  function drainMetadata() {
    if (!metadataSubscription || disposed || fault) return
    options.guard()
    const batch = metadataSubscription.drain()
    for (const metadata of batch.records) {
      if (metadata.sessionID !== options.child.locator.sessionID) {
        metadataGap("foreign-tool-metadata")
        continue
      }
      const prior = metadataCalls.get(metadata.callID)
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(metadata)) metadataGap("conflicting-tool-metadata")
        continue
      }
      metadataCalls.set(metadata.callID, metadata)
      // Use the same bounded custody store; this ID is a parent record key only.
      bound.append({ kind: "tool-metadata", id: toolMetadataRecordID(metadata), metadata })
    }
    if (batch.issue) metadataGap(batch.issue)
  }
  const uncertain = (): OwnedChildOutcome => ({
    status: "uncertain",
    reason: fault ?? "observer-disposed",
    delivered: [],
    consumption: "unconfirmed",
  })
  // Native held settlement (omo#9069, senpi#3262): a run's end is held until the session is really
  // done. `experimental.idle` with no background work the child itself owns is that edge; a run the
  // session starts on its own (a background job's notice) drops the held outcome and its own end is
  // held next. A held error is confirmed against the session's state and its own running shells.
  const wakeSources = createWakeSourceLedger()
  let settled: OwnedChildOutcome | undefined
  let runStart: string | undefined, runTerminal: string | undefined
  let turnOutcome: OwnedChildOutcome | undefined
  const settlement = createHeldTurnSettlement<OwnedChildOutcome>({
    settle(result) {
      if (settled) return
      settled = Object.freeze(result)
      for (const resolveWaiter of [...waiters]) resolveWaiter(result)
    },
    probe: async () => ownedChildSessionState(bound.snapshot().records),
    settleConfirmMs: confirmMs,
    wakeSourcesLive: wakeSources.hasLive,
    disposed: () => disposed || !!fault,
    ...(schedule ? { scheduleConfirmation: schedule } : {}),
  })
  function advance(result: OwnedChildOutcome) {
    if (settled || result.status === "uncertain") return
    if (result.startEventID !== undefined && result.startEventID !== runStart) {
      runStart = result.startEventID
      runTerminal = undefined
      wakeSources.resetTurn()
      settlement.begin()
    }
    if (result.terminalEventID === undefined || result.terminalEventID === runTerminal) return
    runTerminal = result.terminalEventID
    if (result.status === "control-only") {
      // A run that did no model work for the turn leaves the turn's last outcome where it was.
      if (turnOutcome) settlement.end(turnOutcome)
    } else if (result.status === "completed" || result.status === "error") {
      turnOutcome = result
      settlement.end(result)
      if (result.ended === "succeeded") {
        // A succeeded run went through `experimental.idle`: with nothing of its own running, idle.
        if (result.held === undefined) settlement.idle()
      } else idleAfterFailure()
    } else if (result.status === "interrupted") settlement.end(result)
  }
  /** OpenCode 2.2.6 tells a plugin nothing when a session goes idle after a failed run (no idle hook,
   * no status event), and no hook can continue a failed run. So the failure itself is Native's
   * `agent_idle` when the child owns no running background work and no input waits for a run;
   * otherwise the held error waits for the wake run or the bounded confirmation. */
  function idleAfterFailure() {
    if (settled || settlement.pending()?.status !== "error" || wakeSources.hasLive()) return
    if (sessionIsIdle(ownedChildSessionState(bound.snapshot().records))) settlement.idle()
  }
  function outcome(): OwnedChildOutcome {
    if (fault || disposed) return uncertain()
    let result: OwnedChildOutcome
    try {
      drainMetadata()
      result = projectOwnedChildOutcome(bound.snapshot(), completion)
    } catch {
      fail("observation-store-unavailable")
      return uncertain()
    }
    if (result.status === "uncertain") return result
    advance(result)
    if (settled) return settled
    if (settlement.pending()) return { ...result, status: "pending", reason: "settlement-held" }
    return result
  }
  function notify() {
    const result = outcome()
    if (result.status !== "uncertain") return
    for (const settle of [...waiters]) settle(result)
  }
  function observeShell(shell: ShellLifecycle) {
    if (shell.type === "created") {
      if (shell.sessionID === options.child.locator.sessionID) wakeSources.armSession(shell.key)
      return
    }
    wakeSources.endSession(shell.key)
    settlement.reconfirmHeld()
  }
  function fail(reason: string) {
    if (!fault) {
      fault = reason
      settlement.cancelConfirmation()
      try {
        bound.invalidate(reason)
      } catch {
        /* Old bindings cannot downgrade their replacement. */
      }
    }
    readyReject(new Error(reason))
    controller.abort(new Error(reason))
    for (const settle of [...waiters]) settle(uncertain())
  }
  function append(record: ObservationRecord) {
    if (disposed || fault) throw new Error("Child observer is unavailable")
    try {
      bound.append(record)
    } catch {
      fail("observation-append-failed")
      throw new Error("Child observation could not be persisted")
    }
    if (record.kind !== "tool-metadata-gap") notify()
  }
  async function register(promise: Promise<{ dispose(): Promise<void> | void }>) {
    const handle = await promise
    if (disposed || fault) await handle.dispose()
    else registrations.push(handle)
  }
  const signals = [options.child.lease.signal, ...(options.signal ? [options.signal] : [])]
  const lifetime = AbortSignal.any(signals)
  function onAbort() {
    fail("observation-lifetime-ended")
    void dispose().catch(() => {})
  }
  lifetime.addEventListener("abort", onAbort, { once: true })
  async function dispose(): Promise<void> {
    if (disposal) return disposal
    disposed = true
    fail("observer-disposed")
    lifetime.removeEventListener("abort", onAbort)
    disposal = (async () => {
      await setup
      metadataSubscription?.close()
      await metadataPump
      await pump
      const results = await Promise.allSettled(
        registrations.splice(0).map((handle) => Promise.resolve().then(() => handle.dispose())),
      )
      if (results.some((result) => result.status === "rejected")) throw new Error("Observer hook cleanup incomplete")
    })()
    return disposal
  }
  const readinessTimer = setTimeout(() => fail("observation-readiness-timeout"), timeout)
  try {
    if (lifetime.aborted) throw new Error("Observation lifetime already ended")
    if (metadataSubscription)
      metadataPump = (async () => {
        try {
          while (!disposed && !fault && !metadataIssue) {
            await metadataSubscription.wait(controller.signal)
            drainMetadata()
          }
        } catch {
          if (!disposed && !fault) fail("tool-metadata-observation-unavailable")
        } finally {
          metadataSubscription.close()
        }
      })()
    await register(
      ctx.session.hook("model.request", (request) => {
        if (disposed || fault || request.sessionID !== options.child.locator.sessionID) return
        try {
          if (request.kind === "primary")
            append({ kind: "primary", id: randomUUID(), model: observedModelSchema.parse(request.model) })
          else append({ kind: "auxiliary", id: randomUUID(), requestKind: request.kind })
        } catch {
          fail("model-observation-unavailable")
        }
      }),
    )
    if (disposed || fault) throw new Error("Observation setup stopped")
    await register(
      ctx.session.hook("experimental.idle", (idle) => {
        if (disposed || fault || idle.sessionID !== options.child.locator.sessionID) return
        try {
          const owned = idle.background.filter((job) => job.sessionID === options.child.locator.sessionID)
          wakeSources.replaceSession(owned.flatMap((job) => (job.kind === "shell" ? [`shell:${job.shellID}`] : [])))
          wakeSources.resetTurn()
          for (const job of owned)
            if (job.kind === "subagent") wakeSources.armTurn(`subagent:${job.childSessionID}`)
            else if (job.kind === "image") wakeSources.armTurn(`image:${job.path}`)
          append({
            kind: "idle",
            id: randomUUID(),
            owned: owned.length,
            descendant: idle.background.length - owned.length,
          })
        } catch {
          fail("idle-observation-unavailable")
        }
      }),
    )
    if (disposed || fault) throw new Error("Observation setup stopped")
    pump = (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          if (disposed || fault) break
          const shell = shellLifecycle(raw)
          if (shell) {
            observeShell(shell)
            continue
          }
          const event = normalizeOwnedChildEvent(raw, options.child.locator.sessionID)
          if (!event) continue
          // Full text is carried by text.ended; transient deltas cannot prove a result.
          if (!event.durable && event.type.endsWith(".delta")) continue
          append({ kind: "host", id: event.id, event })
          if (!readySeen && event.durable) {
            readySeen = true
            readyResolve()
          }
        }
        if (!disposed && !fault) fail("observation-stream-ended")
      } catch {
        if (!disposed && !fault) fail("observation-stream-failed")
      }
    })()
    // onActivity is not invoked by the 2.2.6 direct Promise plugin adapter.
    // An observed owned event, rather than wait() or a sleep, establishes readiness.
    options.guard()
    await ctx.session.update(
      { sessionID: options.child.locator.sessionID, title: options.title },
      { signal: controller.signal },
    )
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
      markStopping() {
        append({ kind: "stop", id: randomUUID() })
        // A local Stop ends a turn held for the child's own background work at once (Native: a user
        // abort settles as cancelled).
        const held = settlement.pending()
        if (held && !settled) {
          const { held: _background, text: _text, ...facts } = held
          settlement.end({ ...facts, status: "cancelled", reason: "stopped-while-held" })
        }
      },
      outcome,
      observation() {
        if (disposed || fault) return safeView([], [fault ?? "observer-disposed"], false)
        try {
          drainMetadata()
          const snapshot = bound.snapshot()
          return safeView(snapshot.records, snapshot.uncertainty, toolMetadataSource !== undefined)
        } catch {
          fail("observation-store-unavailable")
          return safeView([], [fault ?? "observation-store-unavailable"], false)
        }
      },
      waitForOutcome(signal) {
        if (!expectedInput) return Promise.reject(new Error("Record the expected owned input before waiting"))
        if (signal?.aborted) return Promise.reject(signal.reason)
        const current = outcome()
        if (current.status === "uncertain" || settled) return Promise.resolve(current)
        return new Promise<OwnedChildOutcome>((resolve, reject) => {
          const settle = (result: OwnedChildOutcome) => {
            waiters.delete(settle)
            signal?.removeEventListener("abort", abort)
            resolve(result)
          }
          const abort = () => {
            waiters.delete(settle)
            signal?.removeEventListener("abort", abort)
            reject(signal?.reason)
          }
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

  function safeView(
    records: readonly ObservationRecord[],
    uncertainty: readonly string[],
    available: boolean,
  ): OwnedChildObservationView {
    const reasons = new Set<string>()
    if (!available) reasons.add("tool-metadata-source-unavailable")
    for (const record of records) if (record.kind === "tool-metadata-gap") reasons.add(record.reason)
    const calls = new Map<string, { called: boolean; terminal?: "completed" | "error" }>()
    const metadata = new Map<string, SafeToolMetadata>()
    const hostEvents = new Map<string, string>()
    const callIdentities = new Map<string, string>()
    let ambiguousHostEvidence = false
    const refuseHostJoin = (reason: string) => {
      ambiguousHostEvidence = true
      reasons.add(reason)
    }
    const key = (sessionID: string, messageID: string, callID: string) => JSON.stringify([sessionID, messageID, callID])
    for (const record of records) {
      if (record.kind === "tool-metadata")
        metadata.set(key(record.metadata.sessionID, record.metadata.messageID, record.metadata.callID), record.metadata)
      if (record.kind !== "host") continue
      const body = JSON.stringify(record.event),
        priorEvent = hostEvents.get(record.event.id)
      if (priorEvent !== undefined) {
        // The real store deduplicates identical IDs/bodies. Distinct evidence must
        // never be collapsed into that idempotence rule or overwrite a terminal.
        if (priorEvent !== body) refuseHostJoin("conflicting-tool-event-id")
        continue
      }
      hostEvents.set(record.event.id, body)
      if (!["session.tool.called", "session.tool.success", "session.tool.failed"].includes(record.event.type)) continue
      const event = record.event,
        { assistantMessageID, callID } = event.data
      if (
        event.sessionID !== options.child.locator.sessionID ||
        (event.durable && event.durable.aggregateID !== event.sessionID)
      ) {
        refuseHostJoin("foreign-tool-event-identity")
        continue
      }
      if (!assistantMessageID || !callID) {
        refuseHostJoin("missing-tool-event-identity")
        continue
      }
      const id = key(event.sessionID, assistantMessageID, callID),
        call = calls.get(id) ?? { called: false }
      const priorIdentity = callIdentities.get(callID)
      if (priorIdentity !== undefined && priorIdentity !== id) refuseHostJoin("conflicting-tool-event-identity")
      else callIdentities.set(callID, id)
      if (event.type === "session.tool.called") {
        if (call.called || call.terminal !== undefined) refuseHostJoin("ambiguous-tool-event-sequence")
        else call.called = true
      } else {
        if (!call.called || call.terminal !== undefined) refuseHostJoin("ambiguous-tool-event-sequence")
        else call.terminal = event.type === "session.tool.success" ? "completed" : "error"
      }
      calls.set(id, call)
    }
    const joined: SafeToolMetadata[] = []
    for (const [id, call] of calls) {
      const row = metadata.get(id)
      if (!row) reasons.add("missing-tool-metadata")
      else if (!call.called || !call.terminal) reasons.add("unfinished-tool-event-join")
      else if (row.status !== call.terminal) reasons.add("conflicting-tool-status")
      else if (!ambiguousHostEvidence && !reasons.has("conflicting-tool-metadata")) joined.push(row)
    }
    for (const id of metadata.keys()) if (!calls.has(id)) reasons.add("unmatched-tool-metadata")
    // Partial is intentional: direct nested closures do not fire these hooks.
    const value: OwnedChildObservationView = {
      records: structuredClone(records),
      uncertainty: [...uncertainty],
      toolMetadata: {
        scope: "model-loop-outer-calls",
        coverage: !available
          ? "unavailable"
          : uncertainty.length ||
              metadataIssue ||
              ambiguousHostEvidence ||
              records.some((row) => row.kind === "tool-metadata-gap") ||
              reasons.has("conflicting-tool-status")
            ? "uncertain"
            : "partial",
        reasons: [...reasons],
        joined: structuredClone(joined),
      },
    }
    return deepFreeze(value)
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}
