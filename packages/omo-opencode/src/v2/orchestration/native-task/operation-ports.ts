import type { ReattachingTaskManager, ManagerStartSpec, TaskRecord } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { TaskOperationManager, SendManager, CancelManager, OutputManager } from "@oh-my-opencode/senpi-task/task-operations"
import { runTaskSend, type TaskSendInput, type TaskSendRunOptions, type TaskSendTeamRouting } from "@oh-my-opencode/senpi-task/task-operations"
import type { TeamServiceDeps } from "@oh-my-opencode/senpi-task/team-operations"
import type { DagTaskOwner, DagTaskOwnerKey, OwnedStartResult } from "@oh-my-opencode/senpi-task/dag"
import type { NativeOperationLifetime } from "./accepted-operation"

export interface AcceptedTaskProof { readonly taskID: string; readonly epoch: number; read(): TaskRecord }
export type NativeOperationResolution =
  | { readonly kind: "found"; readonly taskID: string }
  | { readonly kind: "stored-refusal"; readonly send: (input: Parameters<SendManager["sendToTask"]>[0]) => ReturnType<SendManager["sendToTask"]> }
  | { readonly kind: "missing-in-original-scope" }
  | { readonly kind: "denied"; readonly reason: string }
export interface NativeOperationAccess {
  readonly manager: ReattachingTaskManager
  readonly parentSessionID: string
  assertCurrent(): void
  capture(id: string): AcceptedTaskProof
  resolve(input: string, options?: { readonly storedSendRefusal: true }): NativeOperationResolution
  captureSendFormattingScope(): () => ReturnType<SendManager["list"]>
  assertParentPark(id: string, epoch: number, continuation?: boolean): void
  start(spec: ManagerStartSpec): ReturnType<TaskOperationManager["start"]>
  /** A DAG node start under THIS call: the same ancestry check as `start`, keyed by its node owner. */
  startOwned(spec: ManagerStartSpec, owner: DagTaskOwner): Promise<OwnedStartResult>
  send(input: Parameters<SendManager["sendToTask"]>[0]): ReturnType<SendManager["sendToTask"]>
  cancel(...args: Parameters<CancelManager["cancelTask"]>): ReturnType<CancelManager["cancelTask"]>
  waitFor(...args: Parameters<TaskOperationManager["waitFor"]>): ReturnType<TaskOperationManager["waitFor"]>
  destroyResidentTask(...args: Parameters<TeamServiceDeps["destruction"]["destroyResidentTask"]>): ReturnType<TeamServiceDeps["destruction"]["destroyResidentTask"]>
  /** Restores a child its previous runtime parked at shutdown, under THIS call's fresh approval.
   * True once a live control is installed; a released or unparked child is left as it is. */
  restoreAfterReload(id: string): Promise<boolean>
}

/** A view of the SAME Native manager/allocator. No Native algorithms or new scheduler. */
export function createNativeOperationPorts(lifetime: NativeOperationLifetime, access: NativeOperationAccess) {
  const manager = access.manager, receipts = new Map<string, AcceptedTaskProof>()
  const subscriptions = new Set<() => void>()
  const foreground = new Map<string, AbortSignal | undefined>()
  const foregroundStarts = new Set<string>()
  const cleanupCancelled = new Set<string>()
  let formattingScope: (() => ReturnType<SendManager["list"]>) | undefined
  function current() { lifetime.assertAction(); access.assertCurrent() }
  function accept(id: string) { const proof = access.capture(id); receipts.set(id, proof); return proof }
  function receipt(id: string) {
    lifetime.assertLifetime()
    const proof = receipts.get(id)
    if (proof) return proof
    current()
    return accept(id)
  }
  function foregroundSetup(id: string) {
    if (!lifetime.reportingSignal.aborted) { current(); return }
    lifetime.assertBodyContinuation()
    if (!foregroundStarts.has(id)) throw Error("No original admitted foreground setup")
    receipt(id).read()
  }
  function foregroundParentSetup() {
    if (!lifetime.reportingSignal.aborted) { current(); return false }
    lifetime.assertBodyContinuation()
    if (!foregroundStarts.size) throw Error("No original admitted foreground body")
    for (const id of foregroundStarts) receipt(id).read()
    return true
  }
  const get: TaskOperationManager["get"] = id => {
    if (!receipts.has(id)) { current(); if (!manager.get(id)) return undefined }
    return receipt(id).read()
  }
  const list: SendManager["list"] = scope => {
    lifetime.assertLifetime()
    if (scope.scope !== "parent-session" || scope.session_id !== access.parentSessionID) throw Error("Operation list outside original parent")
    // An original late not-found formatter may read only its captured bounded scope.
    if (!lifetime.diagnostics().live) return [...receipts.values()].map(proof => ({ record: proof.read() }))
    current()
    return manager.list(scope).map(item => { accept(item.record.task_id); return item })
  }
  const sendList: SendManager["list"] = scope => {
    lifetime.assertLifetime()
    if (scope.scope !== "parent-session" || scope.session_id !== access.parentSessionID) throw Error("Send formatting outside original parent")
    if (formattingScope) return formattingScope()
    current()
    return manager.list(scope)
  }
  const parked = new Set<object>()
  const parkedCleanup = new Map<object, () => void>()
  const unparking = new Map<object, Promise<void>>()
  const allocator = manager.concurrency
  const concurrency = allocator && new Proxy(allocator, {
    get(target, key) {
      const original = Reflect.get(target, key, target)
      if (key === "park") return (...args: Parameters<typeof target.park>) => {
        const continuation = foregroundParentSetup()
        const parent = manager.findTaskByChildSession?.(access.parentSessionID)
        if (!parent || parent.task_id !== args[0] || parent.notification.run_epoch !== args[1]) throw Error("Cannot park an unrelated Native parent")
        access.assertParentPark(parent.task_id, parent.notification.run_epoch, continuation)
        const token = target.park(...args)
        if (token) {
          parked.add(token)
          parkedCleanup.set(token, lifetime.cleanup(async () => {
            await target.unpark(token)
            parked.delete(token); parkedCleanup.delete(token)
          }))
        }
        return token
      }
      if (key === "unpark") return (...args: Parameters<typeof target.unpark>) => {
        lifetime.assertLifetime()
        const token = args[0]
        if (token === undefined) return Promise.resolve()
        if (!parked.has(token)) throw Error("Unissued or already used Native lane cleanup token")
        const pending = unparking.get(token)
        if (pending) return pending
        const original = target.unpark(...args)
        const work = original.then(() => { parked.delete(token); parkedCleanup.get(token)?.(); parkedCleanup.delete(token) })
        unparking.set(token, work)
        void work.finally(() => unparking.delete(token)).catch(() => {})
        return lifetime.track(work)
      }
      // Only canonical read methods are admitted; no allocator mutation escape.
      if (typeof original === "function") return (...args: unknown[]) => {
        current()
        if (!["leaseState", "getCount", "getLimit", "getKey", "queuePosition", "getRetainedKeyCounts"].includes(String(key))) throw Error("Native allocator action is not an operation port")
        return Reflect.apply(original, target, args)
      }
      return original
    },
  })
  const task: TaskOperationManager = {
    start(spec) {
      current()
      const originalForeground = spec.run_in_background !== true
      const original = lifetime.track(access.start(spec))
      return lifetime.track(original.then(result => {
        if ("task_id" in result && result.task_id) accept(result.task_id)
        if (result.kind === "started" && originalForeground) foregroundStarts.add(result.task_id)
        return result
      }))
    },
    get,
    waitFor(id, options) { foregroundSetup(id); receipt(id).read(); foreground.set(id, options?.signal); return lifetime.track(access.waitFor(id, options)) },
    subscribeChild(id, listener) {
      foregroundSetup(id)
      const proof = receipt(id); proof.read()
      let live = true
      const original = manager.subscribeChild(id, event => { if (live) { proof.read(); listener(event) } })
      let removeStop = () => {}
      let removeCleanup = () => {}
      const close = () => { if (!live) return; original(); live = false; subscriptions.delete(close); removeStop(); removeCleanup() }
      subscriptions.add(close)
      removeStop = lifetime.onStop(close)
      removeCleanup = lifetime.cleanup(close)
      return close
    },
    ...(manager.whenLaunched ? { whenLaunched(id: string) { foregroundSetup(id); receipt(id).read(); const launched = manager.whenLaunched; if (!launched) throw Error("Native task manager no longer exposes whenLaunched"); return lifetime.track(launched.call(manager, id)) } } : {}),
    promoteToBackground(id) { current(); receipt(id).read(); return manager.promoteToBackground(id) },
    cancelTask(...args) {
      // Canonical foreground abort finally owns only its original waiting task.
      if (foreground.get(args[0])?.aborted) lifetime.assertBodyContinuation()
      else current()
      if (cleanupCancelled.has(args[0])) throw Error("Foreground cleanup already admitted")
      receipt(args[0]).read(); cleanupCancelled.add(args[0])
      return lifetime.track(access.cancel(...args))
    },
    ...(manager.findTaskByChildSession ? { findTaskByChildSession(sessionID: string) {
      foregroundParentSetup()
      if (sessionID !== access.parentSessionID) throw Error("Foreign child-session lookup")
      const find = manager.findTaskByChildSession
      if (!find) throw Error("Native task manager no longer exposes findTaskByChildSession")
      return find.call(manager, sessionID)
    } } : {}),
    ...(concurrency ? { concurrency } : {}),
  }
  const send: SendManager = {
    sendToTask(input) {
      current()
      // Native formats CURRENT names in the ORIGINAL parent scope, not a frozen
      // membership snapshot. This continuation confers no task action receipt.
      formattingScope ??= access.captureSendFormattingScope()
      const resolved = access.resolve(input.idOrName, { storedSendRefusal: true })
      if (resolved.kind === "denied") throw Error(resolved.reason)
      // A stored row never becomes an accepted actuation receipt. This separate
      // current-call branch only reaches the original Native parked-send policy.
      if (resolved.kind === "stored-refusal") return lifetime.track(resolved.send(input))
      if (resolved.kind === "missing-in-original-scope") {
        // Scope resolution refusal only: no Native dispatch, ACK or receipt.
        return Promise.resolve({ kind: "not_found", reason: `No task found for "${input.idOrName}".`, suggestion: "Use /tasks to see available tasks, or task_output to read a known task." })
      }
      accept(resolved.taskID)
      return lifetime.track(access.send(input))
    },
    list: sendList,
    // Cold redispatch is deliberately not issued by this first same-tree slice.
  }
  const cancel: CancelManager = {
    cancelTask(input, reason, extra) {
      current()
      const resolved = access.resolve(input)
      if (resolved.kind === "denied") throw Error(resolved.reason)
      if (resolved.kind === "stored-refusal") throw Error("Stored send refusal is not a cancellation grant")
      if (resolved.kind === "missing-in-original-scope") return Promise.resolve({ kind: "not_found", reason: `No task found for "${input}".` })
      accept(resolved.taskID)
      return lifetime.track(access.cancel(resolved.taskID, reason, extra))
    },
    get,
  }
  const output: OutputManager = { get, list, ...(concurrency ? { concurrency } : {}) }
  /** Lifecycle single-writer destruction, only for a task in this operation's original scope. */
  const destruction: TeamServiceDeps["destruction"] = {
    destroyResidentTask(id, cause) {
      current()
      const resolved = access.resolve(id)
      if (resolved.kind !== "found" || resolved.taskID !== id) throw Error("Destruction outside the original parent scope")
      accept(id)
      return lifetime.track(access.destroyResidentTask(id, cause))
    },
  }
  /** The DAG engine's owned-start slice, only inside this operation and only in its original parent.
   * A reused or conflicting owner gets no receipt here; a later read captures it through `get`. */
  const dag = {
    startOwned(spec: ManagerStartSpec, owner: DagTaskOwner): Promise<OwnedStartResult> {
      current()
      return lifetime.track(access.startOwned(spec, owner).then(result => {
        if (result.kind === "started" && !result.reused) accept(result.task_id)
        return result
      }))
    },
    findOwnedTask(key: DagTaskOwnerKey): TaskRecord | undefined {
      current()
      const record = manager.findOwnedTask(key)
      return record && record.parent_session_id === access.parentSessionID ? record : undefined
    },
    residencyChanged(parentSessionID: string): Promise<void> {
      current()
      if (parentSessionID !== access.parentSessionID) throw Error("Residency wait outside the original parent")
      return manager.residencyChanged(parentSessionID)
    },
  }
  /** Lazy restore of a team member parked by a reload, before the lead's call acts on its team. */
  const recovery = {
    restoreAfterReload(id: string): Promise<boolean> {
      current()
      return lifetime.track(access.restoreAfterReload(id))
    },
  }
  return Object.freeze({ task, send, cancel, output, destruction, recovery, dag,
    /** Full canonical send lifetime. The low-level send port alone does not own
     * Native's mapped/late chain; the mandatory observer cannot be overridden. */
    runSend(params: TaskSendInput, options: Omit<TaskSendRunOptions, "retainWork"> & { readonly teamRouting?: TaskSendTeamRouting } = {}) {
      current()
      const deliver = options.deliverLateOutcome, signal = options.signal ?? lifetime.reportingSignal
      let originalOutcomeJSON: string | undefined
      // Team routing is supplied per call by the component, over the SAME operation's team service.
      return runTaskSend(send, params, lifetime.source.sessionID, options.teamRouting, {
        signal,
        ...(deliver ? { deliverLateOutcome(result, delivery) {
          try { originalOutcomeJSON = JSON.stringify({ result, delivery }) } catch { /* No invented substitute outcome. */ }
          return deliver(result, delivery)
        } } : {}),
        retainWork(work, phase) { lifetime.retainSendWork(work, phase, () => originalOutcomeJSON) },
      })
    },
    // SDK metadata reporter, deliberately not typed as Native AgentToolUpdateCallback.
    source: lifetime.source, reportProgress: lifetime.hasProgress ? lifetime.progress : undefined,
    closeReporting: lifetime.closeReporting, joinReporting: lifetime.joinReporting,
    diagnostics: lifetime.diagnostics,
    closeSubscriptions() { for (const close of [...subscriptions]) close() },
  })
}
export type NativeOperationOwner = ReturnType<typeof createNativeOperationPorts>
