import { afterEach, expect, test } from "bun:test"
import { z } from "zod"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { createTaskRecordStore, type TaskRecord, type ManagerStartSpec, type TaskManager } from "@oh-my-opencode/senpi-task/manager-kernel"
import { createTaskRecord } from "../../../../../senpi-task/src/state/record"
import { createOwnedCompletionStore } from "./completion-store"
import { createSessionScopes, type SessionLease } from "../../host/session-state"
import { createToolRegistry, type ListedTool } from "../../host/tool-registry"
import { createToolKernel } from "../../host/tool-kernel"
import { createPolicyPipeline } from "../../host/policy-pipeline"
import { openChildJournal } from "../../host/child-journal"
import { openCompletionIntentJournal } from "../../host/completion-intent-journal"
import { createParentBindings } from "./parent-binding"
import { createParentNotificationAuthorityIssuer, type NotificationAcceptedCustody, type NotificationReturnedAssociation, type AcceptedNotificationTask } from "./parent-notification-authority"
import { createParentNotificationOwner, type ParentNotificationOwnerHost } from "./parent-notification-owner"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omo-C2-owner-unit-")), store = createTaskRecordStore({ project_dir: dir, task: { state_dir: join(dir, "records") } })
  const scopes = createSessionScopes(), policy = { tools: ["unit"], authorize() {} }, root = scopes.open("unit-root" as SessionLease["sessionID"], policy)
  const bindings = createParentBindings(root, policy, () => scopes.assert(root))
  const journal = await openCompletionIntentJournal({ path: join(dir, "completion.sqlite"), namespace: dir, ownerIdentity: { pid: process.pid, start: null } })
  const childJournal = await openChildJournal({ path: join(dir, "children.sqlite") })
  const accepted = new Map<string, NotificationAcceptedCustody>(), returned = new WeakMap<ManagerStartSpec, NotificationReturnedAssociation>()
  const sources = new WeakSet<import("@oh-my-opencode/senpi-task/task-operations").CompletionDeliverySource>()
  const tasks = new Map<string, AcceptedNotificationTask>()
  let action: (caller: ToolContext) => Promise<void> = async () => {}, count = 0
  const tool: ListedTool = { id: "unit", name: "unit", description: "CONTROLLED UNIT", input: z.object({}), async execute(_input, caller) { await action(caller); return { content: "unit" } } }
  const registry = createToolRegistry([tool], { unit: () => [{ action: "unit", resources: [dir] }] })
  const kernel = createToolKernel({ registry, scopes, pipeline: createPolicyPipeline(), permission: { async assert() {} } })
  let receivingQueries = 0, onReceivingQuery: ((count: number) => Promise<void> | void) | undefined
  const issuer = createParentNotificationAuthorityIssuer({ callAuthority: kernel.callAuthority, scopes, bindings, receiver: bindings.root, root,
    registryGeneration: registry.generation, directory: dir, rootDirectory: dir, hostVersion: "2.2.6",
    session: { async get({ sessionID }) { await onReceivingQuery?.(++receivingQueries); return { id: sessionID as SessionLease["sessionID"], location: { directory: dir } } } },
    readers: { store, journal: childJournal, accepted, returned, sources } })
  const hooks = new Map<string, Set<Function>>(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const submitted: Parameters<ParentNotificationOwnerHost["session"]["synthetic"]>[0][] = []
  let calls = 0, failAfterAdmission = false, failDisposal = false
  // These are exact consumed public signatures with CONTROLLED UNIT implementations;
  // no fake full Context and no actual SDK/Native acceptance is claimed by this fixture.
  const hook = (async (name: string, callback: Function) => {
    const set = hooks.get(name) ?? new Set<Function>(); hooks.set(name, set); set.add(callback)
    return { async dispose() { if (failDisposal) { failDisposal = false; throw Error("controlled original registration disposer failed") }; set.delete(callback) } }
  }) as ParentNotificationOwnerHost["session"]["hook"]
  const synthetic = (async (input: Parameters<ParentNotificationOwnerHost["session"]["synthetic"]>[0]) => {
    calls++; submitted.push(input); entered.resolve(); await release.promise
    if (failAfterAdmission) throw Error("controlled lost ACK after host admission")
    return { id: input.id ?? "unit-inbox", sessionID: input.sessionID, time: { created: Date.now() }, type: "synthetic",
      payload: { text: input.text }, delivery: input.delivery ?? "queue" }
  }) as ParentNotificationOwnerHost["session"]["synthetic"]
  const streamEnded = Promise.withResolvers<void>()
  const waitEntered = Promise.withResolvers<void>(), waitRelease = Promise.withResolvers<void>()
  let quiescenceEnabled = false, waitCalls = 0, getCalls = 0
  let cooperativeWait = false
  let waitSignal: AbortSignal | undefined, onWakeQuery: ((count: number) => Promise<void> | void) | undefined
  let receivingDirectory = dir
  const wait = async ({ sessionID }: { sessionID: string }, request?: { signal?: AbortSignal }) => {
    if (sessionID !== root.sessionID) throw Error("Foreign controlled receiving wait")
    waitCalls++
    if (!quiescenceEnabled) throw Error("Controlled unit has no fresh public quiescence")
    waitSignal = request?.signal
    waitEntered.resolve()
    if (cooperativeWait) await new Promise<void>((resolve, reject) => {
      const signal = request?.signal
      const abort = () => { signal?.removeEventListener("abort", abort); reject(signal?.reason) }
      signal?.addEventListener("abort", abort, { once: true })
      void waitRelease.promise.then(() => { signal?.removeEventListener("abort", abort); resolve() }, reject)
      if (signal?.aborted) abort()
    })
    else await waitRelease.promise
    request?.signal?.throwIfAborted()
  }
  const get = async ({ sessionID }: { sessionID: string }) => {
    if (sessionID !== root.sessionID) throw Error("Foreign controlled receiving query")
    getCalls++
    await onWakeQuery?.(getCalls)
    return { id: root.sessionID, location: { directory: receivingDirectory } }
  }
  const eventQueue: unknown[] = []
  let eventWake: (() => void) | undefined
  const subscribe = ((options: { signal?: AbortSignal }) => ({ async *[Symbol.asyncIterator]() {
    if (options.signal?.aborted) return
    let ended = false
    const end = () => { ended = true; eventWake?.() }
    options.signal?.addEventListener("abort", end, { once: true }); void streamEnded.promise.then(end)
    try {
      while (!ended) {
        if (eventQueue.length) yield eventQueue.shift()
        else await new Promise<void>(resolve => { eventWake = resolve })
      }
    } finally { options.signal?.removeEventListener("abort", end); eventWake = undefined }
  } })) as ParentNotificationOwnerHost["event"]["subscribe"]
  const receivingSession = { hook, synthetic, wait, get }
  const ctx: ParentNotificationOwnerHost = { session: receivingSession, tool: { hook: hook as ParentNotificationOwnerHost["tool"]["hook"] }, event: { subscribe } }
  const receiver = { backendID: "omo-native-task-opencode", directory: dir, hostVersion: "2.2.6", sessionID: root.sessionID, rootSessionID: root.sessionID,
    leaseGeneration: root.generation, registryGeneration: registry.generation }
  const owner = createParentNotificationOwner({ ctx, baseStore: store, stateDir: dir, bindings, binding: bindings.root, issuer, journal, receiver,
    taskFor: row => tasks.get(row.task_id), ownsTerminal(row) { const task = tasks.get(row.task_id); if (!task) return false; issuer.assertAcceptedTaskCurrent(task, row); return true },
    wasBackground: () => true, registerSource: source => { sources.add(source) } })
  const chain = createOwnedCompletionStore({ baseStore: store, bindings, channels: new Map([[bindings.root, owner.channel]]), wasBackground: () => true, currentGeneration: () => undefined })
  async function bindRow(row: TaskRecord) {
    const spec: ManagerStartSpec = { parent_session_id: root.sessionID, root_session_id: root.sessionID, depth: 1, prompt: "CONTROLLED UNIT" }
    const identity = Object.freeze({}), result: Awaited<ReturnType<TaskManager["start"]>> = { kind: "started", task_id: row.task_id, name: row.task_id, status: "running" }
    // Controlled C2 returned association DOUBLE, actual C1 opaque grant/Kernel/store.
    accepted.set(row.task_id, { identity, epoch: row.notification.run_epoch, claim: undefined, birth: { createdAt: row.created_at, parentSessionId: row.parent_session_id, rootSessionId: row.root_session_id, depth: row.depth } })
    returned.set(spec, { identity, result })
    action = async caller => { const grant = issuer.provision(kernel.callAuthority.capture(caller), spec); tasks.set(row.task_id, issuer.bindAcceptedWithoutChild(grant, result)) }
    // Explicit UNIT caller, not an invented genuine SDK callback.
    const caller = { sessionID: root.sessionID, id: `unit-${++count}`, messageID: "unit-message", agent: "unit", signal: new AbortController().signal, async progress() {} } as unknown as ToolContext
    const bound = kernel.bind(caller, root)
    try { await bound.invoke("unit", {}) } finally { bound.dispose() }
  }
  async function terminal(notifying = true, status: "completed" | "cancelled" | "interrupted" | "lost" = "completed") {
    const row = { ...createTaskRecord({ parent_session_id: root.sessionID, root_session_id: root.sessionID, depth: 1, execution_mode: "in-process", model: "unit", notify_on_terminal: notifying }), status: "running" as const }
    store.save(row)
    await bindRow(row)
    chain.store.mutate(row.task_id, fresh => ({ ...fresh, status, final_response: "unit completion" }))
    return store.load(row.task_id)!
  }
  const logical = (row: TaskRecord) => ({ taskId: row.task_id, nativeEpoch: row.notification.run_epoch, parentSessionId: row.parent_session_id, rootSessionId: row.root_session_id, createdAt: row.created_at })
  const f = { dir, store, journal, owner, issuer, terminal, receiver, logical, submitted,
    enableQuiescence() { quiescenceEnabled = true }, waitEntered: waitEntered.promise, releaseWait: () => waitRelease.resolve(), waitCalls: () => waitCalls, getCalls: () => getCalls,
    cooperativeWait() { cooperativeWait = true },
    waitSignal: () => waitSignal, setWakeQuery(callback: typeof onWakeQuery) { onWakeQuery = callback }, moveReceiver() { receivingDirectory = join(dir, "moved") },
    emitActivity() { eventQueue.push({ type: "session.execution.started", data: { sessionID: root.sessionID } }); eventWake?.() },
    emitCompaction(phase: "started" | "ended") { eventQueue.push({ type: `session.compaction.${phase}`, data: { sessionID: root.sessionID } }); eventWake?.() },
    holdTask(id: string) { tasks.delete(id) }, endStream() { streamEnded.resolve() },
    async advance(row: TaskRecord) { const next = store.mutate(row.task_id, value => ({ ...value, final_response: "new epoch completion", notification: { ...value.notification, run_epoch: value.notification.run_epoch + 1 } }))!; await bindRow(next); owner.requestReconcile(); await owner.join(); return next }, entered: entered.promise, release: () => release.resolve(), calls: () => calls,
    setReceivingQuery(callback: typeof onReceivingQuery) { onReceivingQuery = callback },
    loseACK() { failAfterAdmission = true },
    failDisposal() { failDisposal = true }, registeredHooks: () => [...hooks.values()].reduce((sum, set) => sum + set.size, 0),
    async idle() { for (const callback of hooks.get("experimental.idle") ?? []) await Reflect.apply(callback, undefined, [{ sessionID: root.sessionID, background: [] }]) },
    async streaming() { for (const callback of hooks.get("execute.after") ?? []) await Reflect.apply(callback, undefined, [{ sessionID: root.sessionID, tool: "unit", id: "controlled-unit", agent: "unit", messageID: "unit-message", input: {}, status: "completed", result: { content: "unit" } }]) },
    async close() { release.resolve(); waitRelease.resolve(); await owner.close(); await journal.close(); childJournal.close(); store.close(); scopes.dispose(); rmSync(dir, { recursive: true, force: true }) } }
  cleanups.push(f.close); return f
}

test("late terminal after the original idle hook uses a fresh public quiescence without another hook", async () => {
  const f = await fixture(); await f.owner.initialize()
  await f.idle()
  expect(f.owner.channel.parentState()).toBeUndefined()
  f.enableQuiescence(); f.releaseWait(); f.release()
  const row = await f.terminal()
  await f.owner.join()
  expect(f.waitCalls()).toBeGreaterThan(0)
  expect(f.getCalls()).toBeGreaterThan(0)
  expect(f.calls()).toBe(1)
  expect(f.submitted[0]?.delivery).toBe("steer")
  expect(f.journal.findBySource(f.logical(row))).toMatchObject({ phase: "accepted", bookkeeping: "complete" })
  expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(row.notification.run_epoch)
  expect(f.owner.channel.parentState()).toBeUndefined()
})

test.each(["foreground", "cancelled", "interrupted"] as const)("canonical %s suppression starts no readonly parent wait", async kind => {
  const f = await fixture(); await f.owner.initialize(); f.enableQuiescence()
  await f.terminal(kind !== "foreground", kind === "foreground" ? "completed" : kind)
  await Bun.sleep(0)
  expect(f.waitCalls()).toBe(0)
  expect(f.calls()).toBe(0)
})

test("canonical lost terminal remains eligible for a fresh wake", async () => {
  const f = await fixture(); await f.owner.initialize(); f.enableQuiescence(); f.releaseWait(); f.release()
  const row = await f.terminal(true, "lost"); await f.owner.join()
  expect(f.calls()).toBe(1)
  expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(0)
})

test("canonical legacy failed-epoch entitlement survives a false notify flag", async () => {
  const f = await fixture(); await f.owner.initialize()
  const row = await f.terminal(false); await f.owner.join()
  expect(f.waitCalls()).toBe(0)
  // Controlled legacy persistence, not an invented current SDK receipt.
  f.store.mutate(row.task_id, fresh => ({ ...fresh, notification: { ...fresh.notification, notification_failed_epoch: 0 } }))
  f.enableQuiescence(); f.releaseWait(); f.release(); f.owner.requestReconcile(); await f.owner.join()
  expect(f.calls()).toBe(1)
  expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(0)
})

test("compaction starting before wait settles remains blocked until its real ended event", async () => {
  const f = await fixture(); await f.owner.initialize(); f.enableQuiescence(); f.release()
  const row = await f.terminal(); await f.waitEntered
  f.emitCompaction("started"); await Bun.sleep(0)
  f.releaseWait(); await f.owner.join()
  expect(f.calls()).toBe(0)
  expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(-1)
  f.emitCompaction("ended"); await Bun.sleep(0); await f.owner.join()
  expect(f.calls()).toBe(1)
})

test("a canonical due retry acquires fresh quiescence after a transient original C1 GET failure", async () => {
  const f = await fixture(); await f.owner.initialize(); f.enableQuiescence(); f.releaseWait(); f.release()
  const original = f.issuer.validateForDispatch
  let dispatchQuery = false, failed = false, timer: ReturnType<typeof setTimeout> | undefined
  expect(Reflect.set(f.issuer, "validateForDispatch", function(...args: Parameters<typeof original>) {
    dispatchQuery = true
    const actual = Reflect.apply(original, f.issuer, args)
    void actual.finally(() => { dispatchQuery = false }).catch(() => {})
    return actual
  })).toBe(true)
  f.setReceivingQuery(() => { if (dispatchQuery && !failed) { failed = true; throw Error("controlled transient original receiving GET failure") } })
  try {
    const row = await f.terminal(); await f.owner.join()
    expect(failed).toBe(true)
    expect(f.calls()).toBe(0)
    const observed = await Promise.race([f.entered.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1500) })])
    if (timer) clearTimeout(timer)
    expect(observed).toBe(true)
    await f.owner.join()
    expect(f.calls()).toBe(1)
    expect(f.waitCalls()).toBeGreaterThan(1)
    expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(0)
    expect(f.journal.findBySource(f.logical(row))).toMatchObject({ phase: "accepted", bookkeeping: "complete" })
  } finally {
    if (timer) clearTimeout(timer)
    Reflect.set(f.issuer, "validateForDispatch", original)
    // Real C1 query failures are reported once at physical retirement even when
    // Native retry succeeds. Join/report that failure and retry its real closer.
    await f.owner.close().catch(() => f.owner.close())
  }
})

test("a retry due during an original proof wait is flushed after that window ends without SDK input", async () => {
  const f = await fixture(); await f.owner.initialize(); f.release()
  const insert = f.journal.insertQueued
  let first = true
  Reflect.set(f.journal, "insertQueued", function(...args: Parameters<typeof insert>) {
    if (first) { first = false; throw Error("controlled original pre-submit journal failure") }
    return Reflect.apply(insert, f.journal, args)
  })
  const a = await f.terminal(); await f.idle(); await f.owner.join()
  Reflect.set(f.journal, "insertQueued", insert)
  const failed = f.store.load(a.task_id)!
  // Temporarily suppress ordinary catch-up so only the ORIGINAL scheduled
  // Native retry owns A while B starts the next window. Identity is unchanged.
  f.store.mutate(a.task_id, row => ({ ...row, notify_on_terminal: false, notification: { run_epoch: 0, notified_epoch: -1 } }))
  const b = await f.terminal(); await f.owner.join()
  f.enableQuiescence(); f.releaseWait()
  const proofEntered = Promise.withResolvers<void>(), proofRelease = Promise.withResolvers<void>()
  const validate = f.issuer.validateForDispatch
  let dispatchQuery = false, held = false, observationTimer: ReturnType<typeof setTimeout> | undefined
  Reflect.set(f.issuer, "validateForDispatch", function(...args: Parameters<typeof validate>) {
    dispatchQuery = true
    return Reflect.apply(validate, f.issuer, args)
  })
  f.setReceivingQuery(async () => {
    if (!dispatchQuery || held) return
    held = true
    f.store.mutate(a.task_id, row => ({ ...row, notify_on_terminal: true, notification: { ...failed.notification } }))
    proofEntered.resolve(); await proofRelease.promise
  })
  const hook = f.idle()
  try {
    await proofEntered.promise
    await Bun.sleep(750)
    expect(f.owner.diagnostics().queued).toBeGreaterThan(0)
    // Retire B's source before its original query returns. It admits no SDK
    // input/event that could accidentally wake the queued retry for A.
    f.store.mutate(b.task_id, row => ({ ...row, notification: { ...row.notification, run_epoch: 1 } }))
    proofRelease.resolve(); await hook
    const observed = await Promise.race([f.entered.then(() => true), new Promise<boolean>(resolve => { observationTimer = setTimeout(() => resolve(false), 1200) })])
    if (observationTimer) clearTimeout(observationTimer)
    expect(observed).toBe(true)
    await f.owner.join()
    expect(f.calls()).toBe(1)
    expect(f.submitted[0]!.text).toContain(a.task_id)
    expect(f.submitted[0]!.text).not.toContain(b.task_id)
  } finally {
    if (observationTimer) clearTimeout(observationTimer)
    proofRelease.resolve(); await hook
    Reflect.set(f.issuer, "validateForDispatch", validate)
  }
})

test("busy-to-idle activity before the original wait settles does not stale the fresh lane", async () => {
  const f = await fixture(); await f.owner.initialize(); f.enableQuiescence(); f.release()
  const row = await f.terminal()
  await f.waitEntered
  f.emitActivity(); await Bun.sleep(0)
  f.releaseWait(); await f.owner.join()
  expect(f.waitCalls()).toBe(1)
  expect(f.calls()).toBe(1)
  expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(0)
})

test("activity during the post-wait query requires a new quiescence observation", async () => {
  const f = await fixture(); await f.owner.initialize(); f.enableQuiescence(); f.releaseWait(); f.release()
  f.setWakeQuery(async count => { if (count === 1) { f.emitActivity(); await Bun.sleep(0) } })
  const row = await f.terminal(); await f.owner.join()
  expect(f.waitCalls()).toBe(2)
  expect(f.getCalls()).toBe(2)
  expect(f.calls()).toBe(1)
  expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(0)
})

test("a real controlled hook wins without waiting for the parent's readonly wait", async () => {
  const f = await fixture(); await f.owner.initialize(); f.enableQuiescence(); f.release()
  const row = await f.terminal(); await f.waitEntered
  await f.idle()
  expect(f.calls()).toBe(1)
  expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(0)
  expect(f.owner.diagnostics().wakePending).toBe(true)
  expect(f.waitSignal()?.aborted).toBe(true)
  f.releaseWait(); await f.owner.join()
  expect(f.calls()).toBe(1)
})

test("a winning actual controlled hook cancels a cooperative readonly wait without manual release", async () => {
  const f = await fixture(); await f.owner.initialize(); f.enableQuiescence(); f.cooperativeWait(); f.release()
  await f.terminal(); await f.waitEntered
  await f.idle(); await f.owner.join()
  expect(f.waitSignal()?.aborted).toBe(true)
  expect(f.owner.diagnostics().wakePending).toBe(false)
  expect(f.calls()).toBe(1)
})

test.each([null, undefined, false, 0, new Error("controlled competing read failure")])("a different original read rejection racing cancellation remains observable (%s)", async failure => {
  const f = await fixture(); await f.owner.initialize(); f.enableQuiescence(); f.releaseWait(); f.release()
  const queried = Promise.withResolvers<void>(), rejectRead = Promise.withResolvers<void>()
  f.setWakeQuery(async () => { queried.resolve(); await rejectRead.promise; throw failure })
  await f.terminal(); await queried.promise
  try {
    await f.idle()
    expect(f.waitSignal()?.aborted).toBe(true)
  } finally { rejectRead.resolve() }
  await f.owner.join()
  const expected = failure instanceof Error ? failure.message : String(failure)
  expect(f.owner.diagnostics().failures).toContainEqual({ kind: "wake-wait", error: expected })
  expect(f.calls()).toBe(1)
})

test("close aborts but still joins the original uncooperative readonly wait", async () => {
  const f = await fixture(); await f.owner.initialize(); f.enableQuiescence()
  const row = await f.terminal(); await f.waitEntered
  let closed = false
  const closing = f.owner.close().then(() => { closed = true })
  try {
    await Bun.sleep(0)
    expect(f.waitSignal()?.aborted).toBe(true)
    expect(closed).toBe(false)
    expect(f.registeredHooks()).toBeGreaterThan(0)
    expect(f.journal.findBySource(f.logical(row))).toBeUndefined()
  } finally { f.releaseWait(); await closing }
  expect(closed).toBe(true)
  expect(f.calls()).toBe(0)
  expect(f.registeredHooks()).toBe(0)
})

test("two late sources ready before fresh quiescence coalesce into one canonical envelope", async () => {
  const f = await fixture(); await f.owner.initialize(); f.enableQuiescence(); f.release()
  const a = await f.terminal(); await f.waitEntered
  const b = await f.terminal()
  f.releaseWait(); await f.owner.join()
  expect(f.calls()).toBe(1)
  expect(f.journal.findBySource(f.logical(a))!.sources.map(source => source.taskId)).toEqual([a.task_id, b.task_id])
  expect(f.store.load(a.task_id)!.notification.notified_epoch).toBe(0)
  expect(f.store.load(b.task_id)!.notification.notified_epoch).toBe(0)
})

test("fresh quiescence never resends an uncertain original SDK admission", async () => {
  const f = await fixture(); await f.owner.initialize(); f.enableQuiescence(); f.releaseWait(); f.release(); f.loseACK()
  const row = await f.terminal(); await f.owner.join()
  const original = f.journal.findBySource(f.logical(row))!
  expect(original.phase).toBe("uncertain")
  f.owner.requestReconcile(); await f.owner.join(); await f.idle()
  expect(f.calls()).toBe(1)
  expect(f.journal.findBySource(f.logical(row))!.intentID).toBe(original.intentID)
  expect(f.journal.findBySource(f.logical(row))!.phase).toBe("uncertain")
  expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(-1)
})

test("fresh quiescence does not wake again after its canonical source is spent", async () => {
  const f = await fixture(); await f.owner.initialize(); f.enableQuiescence(); f.releaseWait(); f.release()
  const row = await f.terminal(); await f.owner.join()
  const waits = f.waitCalls()
  f.owner.requestReconcile(); await f.owner.join()
  expect(f.waitCalls()).toBe(waits)
  expect(f.calls()).toBe(1)
  expect(f.journal.findBySource(f.logical(row))!.bookkeeping).toBe("complete")
})

test("close retains an original receiving query that ignores its abort until it settles", async () => {
  const f = await fixture(); await f.owner.initialize(); f.enableQuiescence(); f.releaseWait()
  const queried = Promise.withResolvers<void>(), releaseQuery = Promise.withResolvers<void>()
  f.setWakeQuery(async () => { queried.resolve(); await releaseQuery.promise })
  const row = await f.terminal(); await queried.promise
  let closed = false
  const closing = f.owner.close().then(() => { closed = true })
  try {
    await Bun.sleep(0)
    expect(closed).toBe(false)
    expect(f.registeredHooks()).toBeGreaterThan(0)
    expect(f.journal.findBySource(f.logical(row))).toBeUndefined()
  } finally { releaseQuery.resolve(); await closing }
  expect(closed).toBe(true)
  expect(f.calls()).toBe(0)
})

test.each(["get-error", "receiver-moved", "source-retired", "stream-gap"] as const)("fresh quiescence holds %s without inventing acceptance", async fault => {
  const f = await fixture(); await f.owner.initialize(); f.enableQuiescence(); f.releaseWait(); f.release()
  f.setWakeQuery(async () => {
    if (fault === "get-error") throw Error("controlled original receiving get rejected")
    if (fault === "receiver-moved") f.moveReceiver()
    if (fault === "source-retired") f.holdTask(f.store.list().records[0]!.task_id)
    if (fault === "stream-gap") { f.endStream(); await Bun.sleep(0) }
  })
  const row = await f.terminal(); await f.owner.join()
  expect(f.calls()).toBe(0)
  expect(f.journal.findBySource(f.logical(row))).toBeUndefined()
  expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(-1)
  expect(f.owner.channel.parentState()).toBeUndefined()
})

test("actual canonical source must be durably dispatching BEFORE original controlled SDK promise starts", async () => {
  const f = await fixture(); await f.owner.initialize(); const row = await f.terminal()
  const idle = f.idle()
  try {
    await f.entered
    const intent = f.journal.findBySource({ taskId: row.task_id, nativeEpoch: 0, parentSessionId: row.parent_session_id, rootSessionId: row.root_session_id, createdAt: row.created_at })
    expect(f.calls()).toBe(1); expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(-1)
    expect(intent?.phase).toBe("dispatching")
  } finally { f.release(); await idle }
})

test("two actual canonical sources coalesce once and all bookkeeping finishes before hook return", async () => {
  const f = await fixture(); await f.owner.initialize()
  const a = await f.terminal(), b = await f.terminal(); f.release()
  await f.idle(); await f.owner.join()
  const intent = f.journal.findBySource(f.logical(a))!
  expect(f.calls()).toBe(1); expect(intent.sources.map(source => source.taskId)).toEqual([a.task_id, b.task_id])
  expect(intent.phase).toBe("accepted"); expect(intent.bookkeeping).toBe("complete")
  expect(f.store.load(a.task_id)!.notification.notified_epoch).toBe(0)
  expect(f.store.load(b.task_id)!.notification.notified_epoch).toBe(0)
  expect(f.owner.diagnostics().pending).toBe(0)
})

test("unknown outside actual controlled hook holds; ephemeral absence never creates idle", async () => {
  const f = await fixture(); await f.owner.initialize(); const row = await f.terminal()
  await f.owner.join()
  expect(f.calls()).toBe(0); expect(f.journal.findBySource(f.logical(row))).toBeUndefined()
  expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(-1)
  expect(f.owner.channel.parentState()).toBeUndefined()
  // This safe hold is NOT late-idle completion parity. Real late_idle_background remains required.
})

test("controlled streaming hook has bounded state and preserves canonical foreground suppression", async () => {
  const f = await fixture(); await f.owner.initialize(); const row = await f.terminal(false)
  f.release(); await f.streaming()
  expect(f.calls()).toBe(0); expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(-1)
  expect(f.owner.channel.parentState()).toBeUndefined()
})

test("lost ACK after controlled host admission persists uncertainty and NEVER retries transport or notDelivered", async () => {
  const f = await fixture(); await f.owner.initialize(); const row = await f.terminal()
  f.loseACK(); f.release(); await f.idle()
  const intent = f.journal.findBySource(f.logical(row))!
  expect(intent.phase).toBe("uncertain"); expect(intent.bookkeeping).toBe("pending")
  expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(-1)
  expect(f.store.load(row.task_id)!.notification.notification_failed_epoch).toBeUndefined()
  await f.idle(); expect(f.calls()).toBe(1)
  await f.owner.close(); expect(f.owner.diagnostics().closed).toBe(true)
  expect(f.owner.diagnostics().uncertain).toBe(1)
})

test("accepted intent write-then-throw repairs SAME canonical receipt without SDK resend", async () => {
  const f = await fixture(); await f.owner.initialize(); const row = await f.terminal()
  const original = f.journal.writeSync; let failed = false
  expect(Reflect.set(f.journal, "writeSync", function(before: Parameters<typeof original>[0], next: Parameters<typeof original>[1]) {
    original.call(f.journal, before, next)
    if (next.phase === "accepted" && !failed) { failed = true; throw null }
  })).toBe(true)
  try { f.release(); await f.idle(); await f.owner.join() }
  finally { expect(Reflect.set(f.journal, "writeSync", original)).toBe(true) }
  expect(failed).toBe(true); expect(f.calls()).toBe(1)
  const intent = f.journal.findBySource(f.logical(row))!
  expect(intent.phase).toBe("accepted"); expect(intent.bookkeeping).toBe("complete")
  expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(0)
})

test("actual canonical mutation-after-commit failure remains retryable cleanup and keeps original SDK result", async () => {
  const f = await fixture(); await f.owner.initialize(); const row = await f.terminal()
  const original = f.store.mutate; let failed = false
  expect(Reflect.set(f.store, "mutate", new Proxy(original, { apply(fn, receiver, args: Parameters<typeof original>) {
    const actual = fn.apply(receiver, args)
    if (actual?.notification.notified_epoch === 0 && !failed) { failed = true; throw Error("controlled canonical cache ACK loss") }
    return actual
  } }))).toBe(true)
  f.release(); await f.idle()
  expect(f.store.load(row.task_id)!.status).toBe("completed"); expect(f.calls()).toBe(1)
  await expect(f.owner.join()).rejects.toThrow("bookkeeping retained")
  expect(f.owner.diagnostics().closed).toBe(false)
  expect(Reflect.set(f.store, "mutate", original)).toBe(true)
  await f.owner.close()
  expect(f.calls()).toBe(1); expect(f.journal.findBySource(f.logical(row))!.bookkeeping).toBe("complete")
  expect(f.owner.diagnostics().failures).not.toEqual([])
})

test("future canonical retry timer parks outside hooks without touching store; next actual window retries", async () => {
  const f = await fixture(); await f.owner.initialize(); const row = await f.terminal()
  const original = f.journal.insertQueued; let failed = false
  expect(Reflect.set(f.journal, "insertQueued", function(input: Parameters<typeof original>[0]) {
    if (!failed) { failed = true; throw Error("controlled definitely pre-submit journal refusal") }
    return original.call(f.journal, input)
  })).toBe(true)
  await f.idle(); expect(f.calls()).toBe(0)
  expect(Reflect.set(f.journal, "insertQueued", original)).toBe(true)
  let reads = 0; const load = f.store.load, list = f.store.list
  expect(Reflect.set(f.store, "load", (...args: Parameters<typeof load>) => { reads++; return load.apply(f.store, args) })).toBe(true)
  expect(Reflect.set(f.store, "list", (...args: Parameters<typeof list>) => { reads++; return list.apply(f.store, args) })).toBe(true)
  await Bun.sleep(600)
  expect(reads).toBe(0); expect(f.calls()).toBe(0)
  expect(Reflect.set(f.store, "load", load)).toBe(true); expect(Reflect.set(f.store, "list", list)).toBe(true)
  f.release(); await f.idle()
  expect(f.calls()).toBe(1); expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(0)
})

test("close remains pending for original uncooperative controlled SDK promise then joins before disposed", async () => {
  const f = await fixture(); await f.owner.initialize(); await f.terminal()
  const idle = f.idle(); await f.entered
  let closed = false; const closing = f.owner.close().then(() => { closed = true })
  await Promise.resolve(); await Promise.resolve(); expect(closed).toBe(false)
  f.release(); await idle; await closing
  expect(closed).toBe(true); expect(f.registeredHooks()).toBe(0)
})

test("failed actual registration disposer retains owner and retries exact resource", async () => {
  const f = await fixture(); await f.owner.initialize(); f.failDisposal()
  await expect(f.owner.close()).rejects.toThrow("registrations retained")
  expect(f.owner.diagnostics().closed).toBe(false); expect(f.registeredHooks()).toBe(1)
  await f.owner.close(); expect(f.registeredHooks()).toBe(0); expect(f.owner.diagnostics().closed).toBe(true)
})

test("controlled prior accepted durable intent repairs with fresh C1 proof and zero new SDK submits", async () => {
  const f = await fixture(); await f.owner.initialize(); const row = await f.terminal()
  const queued = f.journal.insertQueued({ intentID: "controlled-prior-accepted", receiver: { ...f.receiver, registryGeneration: f.receiver.registryGeneration + 7 },
    sources: [{ ...f.logical(row), provenance: { controlledPriorFixture: true } }], message: { text: "controlled historical accepted payload" } })
  const dispatching = { ...queued, revision: queued.revision + 1, phase: "dispatching" as const }
  f.journal.writeSync(queued, dispatching)
  f.journal.writeSync(dispatching, { ...dispatching, revision: dispatching.revision + 1, phase: "accepted", acceptance: { kind: "synthetic", id: "controlled-old-inbox", sessionID: row.parent_session_id } })
  // This is inert controlled journal state, NOT a claimed genuine historical SDK ACK.
  f.release(); await f.idle()
  expect(f.calls()).toBe(0); expect(f.store.load(row.task_id)!.notification.notified_epoch).toBe(0)
  expect(f.journal.read(queued.intentID)!.bookkeeping).toBe("complete")
})

 test("later batch receiving query cannot revoke the first source after its last synchronous fence", async () => {
  const f = await fixture(); await f.owner.initialize()
  const a = await f.terminal(); await f.terminal(); f.release()
  f.setReceivingQuery(count => { if (count === 4) f.store.mutate(a.task_id, row => ({ ...row, notification: { ...row.notification, run_epoch: 1 } })) })
  await f.idle()
  expect(f.calls()).toBe(0)
  expect(f.store.load(a.task_id)!.notification.notified_epoch).toBe(-1)
})


test("prepare never labels a pre-await old run as ready for a mutated new epoch", async () => {
  const f = await fixture(); await f.owner.initialize()
  const original = f.issuer.bindCurrentOwnedRun, list = f.store.list
  let listed: TaskRecord | undefined
  expect(Reflect.set(f.store, "list", function() { const result = list.call(f.store); listed = result.records[0]; return result })).toBe(true)
  let changed = false
  expect(Reflect.set(f.issuer, "bindCurrentOwnedRun", async function(...args: Parameters<typeof original>) {
    const run = await original.apply(f.issuer, args)
    if (!changed) {
      changed = true
      const cached = listed!
      expect(Reflect.set(cached.notification, "run_epoch", cached.notification.run_epoch + 1)).toBe(true) // Controlled mutation of the actual readonly-typed record; no production weakening.
      f.store.replace(cached)
    }
    return run
  })).toBe(true)
  const row = await f.terminal(); f.owner.requestReconcile(); await f.owner.join()
  expect(changed).toBe(true)
  try { expect(f.owner.channel.notificationReady(f.store.load(row.task_id)!)).toBe(false) }
  finally { expect(Reflect.set(f.store, "list", list)).toBe(true) }
})

test("queued old epoch is superseded per Native task key without spending its survivor ACK", async () => {
  const f = await fixture(); await f.owner.initialize(); const old = await f.terminal(); await f.owner.join()
  f.owner.channel.notifier.notifyTerminal({ record: old, parentState: { kind: "idle" }, runInBackground: true })
  const next = await f.advance(old)
  f.owner.channel.notifier.notifyTerminal({ record: next, parentState: { kind: "idle" }, runInBackground: true })
  f.release(); await f.idle()
  expect(f.calls()).toBe(1)
  const saved = f.journal.findBySource(f.logical(next))!
  expect(saved.sources).toHaveLength(1); expect(saved.sources[0]!.nativeEpoch).toBe(1)
  expect(f.journal.findBySource(f.logical(old))).toBeUndefined()
  expect(f.store.load(old.task_id)!.notification.notified_epoch).toBe(1)
  expect(f.submitted[0]!.text).toContain("new epoch completion")
  expect(f.submitted[0]!.text).not.toContain("unit completion")
})

test("multi-detail canonical message has per-task items paired with exact source receipts", async () => {
  const f = await fixture(); await f.owner.initialize(); const a = await f.terminal(), b = await f.terminal(); await f.owner.join()
  for (const row of [a,b]) f.owner.channel.notifier.notifyTerminal({ record: row, parentState: { kind: "compacting" }, runInBackground: true })
  f.owner.channel.notifier.flushBuffered({ sessionId: f.receiver.sessionID, replaced: false })
  f.release(); await f.idle()
  expect(f.calls()).toBe(1)
  const items = f.submitted[0]!.metadata!.nativeItems as { details: { task_id: string }[] }[]
  expect(items).toHaveLength(2)
  expect(items.map(item => item.details.map(detail => detail.task_id))).toEqual([[a.task_id],[b.task_id]])
  expect(f.journal.findBySource(f.logical(a))!.bookkeeping).toBe("complete")
  expect(f.store.load(a.task_id)!.notification.notified_epoch).toBe(0); expect(f.store.load(b.task_id)!.notification.notified_epoch).toBe(0)
})

test("historical accepted two-source envelope repairs only its unspent subset without SDK resend", async () => {
  const f = await fixture(); await f.owner.initialize(); const a = await f.terminal(), b = await f.terminal()
  f.store.mutate(a.task_id, row => ({ ...row, notification: { ...row.notification, notified_epoch: 0 } }))
  const queued = f.journal.insertQueued({ intentID: "controlled-partial-accepted", receiver: f.receiver,
    sources: [a,b].map(row => ({ ...f.logical(row), provenance: { controlledHistorical: true } })), message: { text: "immutable historical A+B" } })
  const sending = { ...queued, revision: queued.revision+1, phase: "dispatching" as const }; f.journal.writeSync(queued,sending)
  f.journal.writeSync(sending,{ ...sending, revision:sending.revision+1, phase:"accepted",acceptance:{kind:"synthetic",id:"controlled-original-AB-ACK",sessionID:f.receiver.sessionID} })
  f.release(); await f.idle()
  const saved = f.journal.read(queued.intentID)!
  expect(f.calls()).toBe(0); expect(f.store.load(b.task_id)!.notification.notified_epoch).toBe(0)
  expect(saved.bookkeeping).toBe("complete"); expect(saved.sources).toEqual(queued.sources); expect(saved.message).toEqual(queued.message)
  expect(saved.acceptance?.id).toBe("controlled-original-AB-ACK")
})


test("accepted subset repair cannot complete another still-unspent logical source", async () => {
  const f = await fixture(); await f.owner.initialize(); const a = await f.terminal(), b = await f.terminal()
  f.holdTask(a.task_id) // Explicit missing current task capability: data is not a replacement grant.
  const queued = f.journal.insertQueued({ intentID: "controlled-pending-subset", receiver: f.receiver,
    sources: [a,b].map(row => ({ ...f.logical(row), provenance: { controlledHistorical: true } })), message: { text: "historical two-source payload" } })
  const sending = { ...queued, revision: queued.revision+1, phase: "dispatching" as const }; f.journal.writeSync(queued,sending)
  f.journal.writeSync(sending,{ ...sending, revision:sending.revision+1, phase:"accepted",acceptance:{kind:"synthetic",id:"controlled-subset-ACK",sessionID:f.receiver.sessionID} })
  f.release(); await f.idle()
  expect(f.calls()).toBe(0); expect(f.store.load(a.task_id)!.notification.notified_epoch).toBe(-1)
  expect(f.store.load(b.task_id)!.notification.notified_epoch).toBe(0)
  expect(f.journal.read(queued.intentID)!.bookkeeping).toBe("pending")
  expect(f.journal.read(queued.intentID)!.sources).toEqual(queued.sources)
})


function holdPreparationAfterFirstCanonicalPass(f: Awaited<ReturnType<typeof fixture>>) {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const bind = f.issuer.bindCurrentOwnedRun, reconcile = f.owner.channel.notifier.reconcileUnnotifiedNotifications
  let afterFirstPass = false, held = false
  expect(Reflect.set(f.issuer, "bindCurrentOwnedRun", async function(...args: Parameters<typeof bind>) {
    const original = await bind.apply(f.issuer,args)
    if (afterFirstPass && !held) { held = true; entered.resolve(); await release.promise }
    return original
  })).toBe(true)
  expect(Reflect.set(f.owner.channel.notifier, "reconcileUnnotifiedNotifications", function(...args: Parameters<typeof reconcile>) {
    const result = reconcile.apply(f.owner.channel.notifier,args)
    if (!afterFirstPass) { afterFirstPass = true; f.owner.requestReconcile() }
    return result
  })).toBe(true)
  return { entered: entered.promise, release: () => release.resolve(), restore() {
    expect(Reflect.set(f.issuer,"bindCurrentOwnedRun",bind)).toBe(true)
    expect(Reflect.set(f.owner.channel.notifier,"reconcileUnnotifiedNotifications",reconcile)).toBe(true)
  } }
}

test("same registered controlled hook catches terminal binding during owned await after first reconcile", async () => {
  const f = await fixture(); await f.owner.initialize(); const a = await f.terminal(); await f.owner.join()
  const gate = holdPreparationAfterFirstCanonicalPass(f); f.release(); const idle = f.idle()
  try {
    await gate.entered
    const late = await f.terminal()
    gate.release(); await idle
    expect(f.calls()).toBe(1)
    const saved = f.journal.findBySource(f.logical(late))
    expect(saved?.phase).toBe("accepted")
    expect(saved?.sources.map(source => source.taskId)).toEqual([a.task_id,late.task_id])
    expect(f.store.load(late.task_id)!.notification.notified_epoch).toBe(0)
  } finally { gate.release(); await idle; gate.restore() }
})

test("stream gap invalidates current catch-up window before late terminal can dispatch", async () => {
  const f = await fixture(); await f.owner.initialize(); await f.terminal(); await f.owner.join()
  const gate = holdPreparationAfterFirstCanonicalPass(f); f.release(); const idle = f.idle()
  try {
    await gate.entered
    const late = await f.terminal()
    f.endStream(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    gate.release(); await idle
    expect(f.owner.diagnostics().streamAlive).toBe(false)
    expect(f.calls()).toBe(0)
    expect(f.store.load(late.task_id)!.notification.notified_epoch).toBe(-1)
    expect(f.owner.channel.parentState()).toBeUndefined()
  } finally { gate.release(); await idle; gate.restore() }
})
