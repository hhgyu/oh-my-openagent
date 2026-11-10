import { afterEach, expect, test } from "bun:test"
import { z } from "zod"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import { createSessionScopes, type SessionLease } from "../../host/session-state"
import { createToolRegistry } from "../../host/tool-registry"
import { createPolicyPipeline } from "../../host/policy-pipeline"
import { createToolKernel, type IssuedToolCall } from "../../host/tool-kernel"
import { createParentBindings } from "./parent-binding"
import { createTaskRecordStore, type ManagerStartSpec, type ManagedStartSpec, type TaskManager, type TaskRecord } from "@oh-my-opencode/senpi-task/manager-kernel"
import { createTaskRecord } from "../../../../../senpi-task/src/state/record"
import { createCompletionNotifier, type CompletionDeliverySource } from "@oh-my-opencode/senpi-task/task-operations"
import { openChildJournal } from "../../host/child-journal"
import { createSessionBackend, type SessionBackendApi } from "../../host/session-backend"
import { withJoinedSessionCancellation } from "../../host/session-cancellation"
import type { OwnedTaskControl } from "./owned-handle"
import { createParentNotificationAuthorityIssuer, type NotificationAcceptedCustody, type NotificationStagedAssociation, type NotificationReturnedAssociation,
  type NotificationClosedSource, type ParentNotificationAuthorityOptions, type ProvisionalNotificationGrant, type AcceptedNotificationTask,
  type NotificationInitialInputAssociation, type NotificationFailedStartAssociation, type NotificationRecoveredAssociation } from "./parent-notification-authority"

type Result = Awaited<ReturnType<TaskManager["start"]>>
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omo-C1A-unit-")), scopes = createSessionScopes(), policy = { tools: ["probe"], authorize() {} }
  const root = scopes.open("root" as SessionLease["sessionID"], policy), bindings = createParentBindings(root, policy, () => scopes.assert(root))
  const store = createTaskRecordStore({ project_dir: dir }), journal = await openChildJournal({ path: join(dir, "children.sqlite") })
  const controls = new Map<string, OwnedTaskControl>(), accepted = new Map<string, NotificationAcceptedCustody>(), staged = new WeakMap<OwnedTaskControl, NotificationStagedAssociation>()
  const returned = new WeakMap<ManagerStartSpec, NotificationReturnedAssociation>(), closed = new Map<string, NotificationClosedSource>(), sources = new WeakSet<CompletionDeliverySource>()
  const initialInputs = new WeakMap<OwnedTaskControl, NotificationInitialInputAssociation>(), failedStarts = new WeakMap<OwnedTaskControl, NotificationFailedStartAssociation>(), recovered = new WeakMap<OwnedTaskControl, NotificationRecoveredAssociation>()
  const sessions = new Map<string, { parent?: string; directory: string }>([["root", { directory: "/unit/project" }]])
  let run: (token: IssuedToolCall) => void | Promise<void> = () => {}, sequence = 0, queryCalls = 0
  let query: SessionBackendApi["get"] = async ({ sessionID }) => {
    const row = sessions.get(sessionID); if (!row) throw Error("controlled missing session")
    return { id: sessionID as SessionLease["sessionID"], ...(row.parent ? { parentID: row.parent as SessionLease["sessionID"] } : {}), location: { directory: row.directory } }
  }
  const tool: Info & { id: string } = { id: "probe", name: "probe", description: "UNIT", input: z.object({}), options: { permission: "probe" },
    execute: async (_input, caller) => { await run(kernel.callAuthority.capture(caller)); return { content: "unit" } } }
  const registry = createToolRegistry([tool], { probe: () => [{ action: "probe", resources: ["unit"] }] })
  const kernel = createToolKernel({ scopes, registry, pipeline: createPolicyPipeline({}), permission: { async assert() {} } })
  const issuers: ReturnType<typeof createParentNotificationAuthorityIssuer>[] = [], backends: ReturnType<typeof createSessionBackend>[] = []
  const gates: (() => void)[] = []
  const options: ParentNotificationAuthorityOptions = { callAuthority: kernel.callAuthority, scopes, bindings, receiver: bindings.root, root, registryGeneration: registry.generation,
    directory: "/unit/project", rootDirectory: "/unit/project", hostVersion: "2.2.6", session: { get(...args) { queryCalls++; return query(...args) } }, readers: { store, journal, controls, accepted, staged, returned, closed, sources, initialInputs, failedStarts, recovered } }
  const issuer = createParentNotificationAuthorityIssuer(options); issuers.push(issuer)
  async function call(fn: typeof run, lease = root) {
    run = fn
    // Explicit UNIT ToolContext, not a genuine SDK callback. Actual Kernel and scopes execute it.
    const caller = { sessionID: lease.sessionID, id: `unit-call-${++sequence}`, messageID: "unit-message", agent: "unit", signal: new AbortController().signal, progress: async () => {} } as unknown as ToolContext
    const bound = kernel.bind(caller, lease)
    try { await bound.invoke("probe", {}) } finally { bound.dispose(); run = () => {} }
  }
  function spec(parent = "root", depth = 1): ManagerStartSpec { return { prompt: "UNIT private prompt must not be retained by accepted grant", parent_session_id: parent, root_session_id: "root", depth, run_in_background: true } }
  function record(parent = "root", depth = 1) { const row = { ...createTaskRecord({ parent_session_id: parent, root_session_id: "root", depth, execution_mode: "in-process", model: "unit", notify_on_terminal: true, task_seq: ++sequence }), status: "completed" as const, final_response: "unit completed" }; store.save(row); return row }
  async function queued(chosen = issuer, parentLease = root, original = spec(parentLease.sessionID, parentLease === root ? 1 : 2)) {
    const row = record(parentLease.sessionID, original.depth), identity = Object.freeze({})
    // Controlled C2 acceptance association UNIT DOUBLE, not a real Native manager result.
    const result: Result = { kind: "started", task_id: row.task_id, name: row.name ?? row.task_id, status: "pending", run_epoch: 0 }
    accepted.set(row.task_id, { identity, epoch: 0, claim: row.residency_claim, birth: { createdAt: row.created_at, parentSessionId: row.parent_session_id, rootSessionId: row.root_session_id, depth: row.depth } })
    returned.set(original, { identity, result })
    let grant!: ProvisionalNotificationGrant, task!: AcceptedNotificationTask
    await call(token => { grant = chosen.provision(token, original); task = chosen.bindAcceptedWithoutChild(grant, result) }, parentLease)
    return { row, identity, original, result, grant, task }
  }
  function source(row: TaskRecord) {
    let issued!: CompletionDeliverySource
    const notifier = createCompletionNotifier({ store, notifier: { enqueue() { throw Error("source port expected") }, enqueueWithSource(_message, receipts) { issued = receipts[0]!; receipts.forEach(item => sources.add(item)) } }, schedule: () => () => {} })
    notifier.notifyTerminal({ record: row, parentState: { kind: "idle" }, runInBackground: true })
    if (!issued) throw Error("canonical source missing")
    return issued
  }
  async function stage(parentLease = root, chosen = issuer, bind = true, initial: boolean | "none" = false) {
    const original = spec(parentLease.sessionID, parentLease === root ? 1 : 2), row = record(parentLease.sessionID, original.depth)
    let continuationReply: ((input: { sessionID: string; id: string }) => Promise<{ id: string; sessionID: string }>) | undefined
    const api = { async get({ sessionID }: { sessionID: string }) { const value = sessions.get(sessionID); if (!value) throw Error("unit session missing"); return { id: sessionID, ...(value.parent ? { parentID: value.parent } : {}), location: { directory: value.directory } } },
      async create(input: { id: string; parentID: string }) { sessions.set(input.id, { parent: input.parentID, directory: "/unit/project" }); return { id: input.id, parentID: input.parentID, location: { directory: "/unit/project" } } },
      async prompt(input: { sessionID: string; id: string }) { return continuationReply ? continuationReply(input) : { id: input.id, sessionID: input.sessionID } },
      async interrupt() { return { interrupted: true } }, async wait() {}, async remove({ sessionID }: { sessionID: string }) { sessions.delete(sessionID) } } as unknown as SessionBackendApi
    withJoinedSessionCancellation(api, "controlled-test")
    const backend = createSessionBackend({ app: { name: "opencode", version: "2.2.6", channel: "stable" }, location: { directory: "/unit/project" }, session: api },
      { backendID: "omo-native-task-opencode", owner: journal.owner, parent: parentLease, scopes, policy, journal, gate: { assertActive() { scopes.assert(parentLease) } } })
    backends.push(backend)
    const child = await backend.stage({ key: row.task_id, sessionID: `unit-child-${++sequence}` as SessionLease["sessionID"], agent: "unit" })
    if (!initial) await backend.checkpointTurn(child, { nativeEpoch: 0, observationKey: `unit:${row.task_id}` })
    let checkpoint = (await journal.read(row.task_id))!
    function sync() { store.mutate(row.task_id, current => ({ ...current, runner_kind: "owned-session", child_session_id: child.locator.sessionID,
      residency_claim: "CONTROLLED-unit-claim", owned_session: { ...child.locator, journalKey: row.task_id, journalOwner: journal.owner, journalRevision: checkpoint.revision, runEpoch: current.notification.run_epoch, residencyClaim: "CONTROLLED-unit-claim" } })) }
    sync()
    // This control assembler is a labelled UNIT DOUBLE. Its backend and journal are REAL;
    // this does NOT claim actual Native runner acceptance or an actual SDK child.
    const control = { child, backend, begin() {
      const turnId = `unit-initial-${++sequence}`
      const outcome = backend.begin(child, { id: turnId, text: "controlled initial input" }).then(() => ({ status: "completed" as const, finalResponse: "unit" }))
      return { turnId, outcome }
    }, handle: { task_id: row.task_id, assertOwned() {
      backend.observationGuard(child)(); journal.assertCurrent(checkpoint)
      const current = store.load(row.task_id)!
      if (current.owned_session?.journalRevision !== checkpoint.revision) throw Error("controlled private reference differs from real journal")
    } } } as unknown as OwnedTaskControl
    controls.set(row.task_id, control)
    const identity = Object.freeze({}), stageIdentity = Object.freeze({}); accepted.set(row.task_id, { identity, epoch: 0, claim: "CONTROLLED-unit-claim", control, birth: { createdAt: row.created_at, parentSessionId: row.parent_session_id, rootSessionId: row.root_session_id, depth: row.depth } })
    let task!: AcceptedNotificationTask, grant!: ProvisionalNotificationGrant, managed!: ManagedStartSpec
    await call(token => {
      grant = chosen.provision(token, original)
      const hostAuthority = { admissionSignal: token.admissionSignal, lifetimeSignal: token.lifetimeSignal, assertAdmission() { throw Error("must not reuse start authority") }, assertLifetime() { throw Error("must not reuse start authority") } }
      managed = { taskId: row.task_id, parentSessionId: parentLease.sessionID, rootSessionId: "root", depth: original.depth, cwd: "/unit/project", stateDir: dir, prompt: "UNIT", admission: { hostAuthority } as unknown as ManagedStartSpec["admission"] }
      staged.set(control, { original: new WeakRef(original), managed: new WeakRef(managed), hostAuthority, identity, stageIdentity })
      if (bind) task = chosen.bindStaged(grant, managed, control)
    }, parentLease)
    if (initial === true) {
      const begin = control.begin(); await begin.outcome
      checkpoint = (await journal.read(row.task_id))!; sync()
      initialInputs.set(control, { identity, control, stageIdentity, nativeEpoch: 0, inputID: begin.turnId, begin })
    }
    return { row: store.load(row.task_id)!, original, control, backend, child, task, grant, managed, identity,
      setContinuationReply(reply: typeof continuationReply) { continuationReply = reply },
      async syncJournal() { checkpoint = (await journal.read(row.task_id))!; sync() },
      async steer(id: string) { try { return await backend.promptContinuation(child, { id, text: "controlled same-epoch steer" }) } finally { checkpoint = (await journal.read(row.task_id))!; sync() } },
      async progress() { await backend.checkpointTurn(child, { nativeEpoch: 0, observationKey: `unit-progress:${++sequence}` }); checkpoint = (await journal.read(row.task_id))!; sync() },
      async closeSource() { const referenceRevision = store.load(row.task_id)!.owned_session!.journalRevision; await backend.close(child); const actual = (await journal.read(row.task_id))!; await backend.confirmClosed(child); controls.delete(row.task_id); closed.set(row.task_id, { control, row: actual, referenceRevision }) } }
  }
  function deferredGet() {
    const gate = Promise.withResolvers<Awaited<ReturnType<SessionBackendApi["get"]>>>(), entered = Promise.withResolvers<void>()
    gates.push(() => gate.resolve({ id: "root" as SessionLease["sessionID"], location: { directory: "/unit/project" } }))
    query = () => { entered.resolve(); return gate.promise }
    return { gate, entered }
  }
  const value = { dir, scopes, root, bindings, store, journal, controls, accepted, staged, returned, closed, sources, initialInputs, failedStarts, recovered, kernel, registry, issuer, options, call, spec, record, queued, source, stage, deferredGet,
    setGet(fn: SessionBackendApi["get"]) { query = fn }, queryCalls: () => queryCalls,
    another(changes: Partial<ParentNotificationAuthorityOptions> = {}) { const result = createParentNotificationAuthorityIssuer({ ...options, ...changes }); issuers.push(result); return result },
    async close() { gates.splice(0).forEach(release => release()); for (const item of issuers) { try { await item.retire() } catch { await item.retire() } }; for (const backend of backends) await backend.dispose(); journal.close(); store.close(); scopes.dispose(); rmSync(dir, { recursive: true, force: true }) } }
  cleanups.push(value.close); return value
}

test("actual initial backend admission without a turn descriptor binds only its exact captured begin receipt", async () => {
  const f = await fixture(), initial = await f.stage(f.root, f.issuer, true, true)
  const association = f.initialInputs.get(initial.control)!, row = (await f.journal.read(initial.row.task_id))!
  expect(row.turn).toBeUndefined(); expect(row.admission).toBe("accepted")
  expect(row.inboxID).toBe(association.begin.turnId); expect(row.receipts[association.inputID]).toBe("accepted")
  await expect(f.issuer.bindCurrentOwnedRun(initial.task)).resolves.toBeDefined()
})

test("initial accepted receipt remains valid after real same-epoch steering advances current inbox", async () => {
  const f = await fixture(), initial = await f.stage(f.root, f.issuer, true, true)
  const original = f.initialInputs.get(initial.control)!
  await initial.steer("unit-next-accepted")
  const actual = (await f.journal.read(initial.row.task_id))!
  expect(actual.turn).toBeUndefined(); expect(actual.inboxID).toBe("unit-next-accepted")
  expect(actual.receipts[original.inputID]).toBe("accepted"); expect(actual.receipts[actual.inboxID!]).toBe("accepted")
  const run = await f.issuer.bindCurrentOwnedRun(initial.task)
  const permit = await f.issuer.validateForDispatch(run, f.source(f.store.load(initial.row.task_id)!))
  expect(() => f.issuer.assertDispatchCurrent(permit)).not.toThrow()
})

for (const disposition of ["pending", "uncertain"] as const) test(`initial accepted receipt cannot authorize latest ${disposition} steering`, async () => {
  const f = await fixture(), initial = await f.stage(f.root, f.issuer, true, true)
  const gate = Promise.withResolvers<{ id: string; sessionID: string }>(), entered = Promise.withResolvers<void>()
  initial.setContinuationReply(() => { entered.resolve(); return gate.promise })
  const sending = initial.steer(`unit-next-${disposition}`); const observed = sending.catch(error => error)
  await entered.promise; await initial.syncJournal()
  if (disposition === "uncertain") { gate.reject(Error("controlled lost steering ACK")); await observed }
  const actual = (await f.journal.read(initial.row.task_id))!
  expect(actual.admission).toBe(disposition)
  try { await expect(f.issuer.bindCurrentOwnedRun(initial.task)).rejects.toThrow() }
  finally { if (disposition === "pending") { gate.resolve({ id: "unit-next-pending", sessionID: initial.child.locator.sessionID }); await observed } }
})

test("no-turn accepted ledger is fenced when real steering starts during the receiving GET", async () => {
  const f = await fixture(), initial = await f.stage(f.root, f.issuer, true, true)
  const run = await f.issuer.bindCurrentOwnedRun(initial.task), source = f.source(initial.row), query = f.deferredGet()
  const validating = f.issuer.validateForDispatch(run, source)
  await query.entered.promise
  const gate = Promise.withResolvers<{ id: string; sessionID: string }>(), entered = Promise.withResolvers<void>()
  initial.setContinuationReply(() => { entered.resolve(); return gate.promise })
  const sending = initial.steer("unit-steer-during-get"); await entered.promise; await initial.syncJournal()
  query.gate.resolve({ id: f.root.sessionID, location: { directory: "/unit/project" } })
  await expect(validating).rejects.toThrow()
  gate.resolve({ id: "unit-steer-during-get", sessionID: initial.child.locator.sessionID }); await sending
  f.setGet(async ({ sessionID }) => ({ id: sessionID as SessionLease["sessionID"], location: { directory: "/unit/project" } }))
  const fresh = await f.issuer.bindCurrentOwnedRun(initial.task), permit = await f.issuer.validateForDispatch(fresh, source)
  expect(() => f.issuer.assertDispatchCurrent(permit)).not.toThrow()
})

for (const change of ["stage", "identity", "control", "epoch", "input", "begin"] as const) test(`initial input ${change} association cannot substitute matching journal fields`, async () => {
  const f = await fixture(), initial = await f.stage(f.root, f.issuer, true, true), entry = f.initialInputs.get(initial.control)!
  f.initialInputs.set(initial.control, { ...entry,
    ...(change === "stage" ? { stageIdentity: {} } : {}), ...(change === "identity" ? { identity: {} } : {}),
    ...(change === "control" ? { control: { ...initial.control } } : {}), ...(change === "epoch" ? { nativeEpoch: 1 } : {}),
    ...(change === "input" ? { inputID: "unrelated" } : {}), ...(change === "begin" ? { begin: { ...entry.begin, turnId: "unrelated" } } : {}),
  })
  await expect(f.issuer.bindCurrentOwnedRun(initial.task)).rejects.toThrow()
  expect(f.queryCalls()).toBe(0)
})

test("initial proof is fenced again after actual receiving query and at synchronous dispatch", async () => {
  const f = await fixture(), initial = await f.stage(f.root, f.issuer, true, true), entry = f.initialInputs.get(initial.control)!
  const run = await f.issuer.bindCurrentOwnedRun(initial.task), source = f.source(initial.row), deferred = f.deferredGet()
  const pending = f.issuer.validateForDispatch(run, source); await deferred.entered.promise
  f.initialInputs.set(initial.control, { ...entry })
  deferred.gate.resolve({ id: f.root.sessionID, location: { directory: "/unit/project" } })
  await expect(pending).rejects.toThrow("association changed")
  f.initialInputs.set(initial.control, entry); f.setGet(async ({ sessionID }) => ({ id: sessionID as SessionLease["sessionID"], location: { directory: "/unit/project" } }))
  const nextRun = await f.issuer.bindCurrentOwnedRun(initial.task), permit = await f.issuer.validateForDispatch(nextRun, source)
  entry.begin.turnId = "changed-after-await"
  expect(() => f.issuer.assertDispatchCurrent(permit)).toThrow("association changed")
})

test("accepted initial lifetime retains its stage witness after weak raw associations disappear", async () => {
  const f = await fixture(), initial = await f.stage(f.root, f.issuer, true, true)
  f.staged.delete(initial.control); f.returned.delete(initial.original)
  const run = await f.issuer.bindCurrentOwnedRun(initial.task), permit = await f.issuer.validateForDispatch(run, f.source(initial.row))
  expect(() => f.issuer.assertDispatchCurrent(permit)).not.toThrow()
})

test("actual staged no-input error requires registered exact returned failure and current empty ledger", async () => {
  const f = await fixture(), staged = await f.stage(f.root, f.issuer, true, "none"), association = f.staged.get(staged.control)!
  const result: Extract<Result, { kind: "start_failed" }> = { kind: "start_failed", task_id: staged.row.task_id,
    name: staged.row.task_id, execution_mode: "in-process", model: "unit", run_in_background: true, error_message: "controlled before begin" }
  f.store.mutate(staged.row.task_id, row => ({ ...row, status: "error", error_message: result.error_message }))
  f.failedStarts.set(staged.control, { identity: staged.identity, control: staged.control, stageIdentity: association.stageIdentity!, nativeEpoch: 0, result, beginInvoked: false })
  const row = (await f.journal.read(staged.row.task_id))!
  expect(row.turn).toBeUndefined(); expect(row.admission).toBe("none"); expect(row.inboxID).toBeUndefined(); expect(Object.keys(row.receipts)).toHaveLength(0)
  const run = await f.issuer.bindCurrentOwnedRun(staged.task), permit = await f.issuer.validateForDispatch(run, f.source(f.store.load(staged.row.task_id)!))
  expect(() => f.issuer.assertDispatchCurrent(permit)).not.toThrow()
  await staged.control.begin().outcome; await staged.progress()
  expect(() => f.issuer.assertDispatchCurrent(permit)).toThrow()
})

for (const change of ["missing", "stage", "identity", "result", "epoch"] as const) test(`no-input failure ${change} cannot infer acceptance from error status alone`, async () => {
  const f = await fixture(), staged = await f.stage(f.root, f.issuer, true, "none"), association = f.staged.get(staged.control)!
  f.store.mutate(staged.row.task_id, row => ({ ...row, status: "error" }))
  const result: Extract<Result, { kind: "start_failed" }> = { kind: "start_failed", task_id: change === "result" ? "other" : staged.row.task_id,
    name: "unit", execution_mode: "in-process", model: "unit", run_in_background: true, error_message: "unit failure" }
  if (change !== "missing") f.failedStarts.set(staged.control, { identity: change === "identity" ? {} : staged.identity,
    control: staged.control, stageIdentity: change === "stage" ? {} : association.stageIdentity!, nativeEpoch: change === "epoch" ? 1 : 0, result, beginInvoked: false })
  await expect(f.issuer.bindCurrentOwnedRun(staged.task)).rejects.toThrow()
})

async function recoveredFixture(initial = false, nested = false) {
  const f = await fixture()
  let token!: IssuedToolCall; await f.call(value => { token = value })
  let receiver = f.bindings.root, parentLease = f.root
  if (nested) {
    const parent = await f.stage()
    receiver = f.bindings.adopt(parent.backend.borrowParent(parent.child), 1, () => parent.control.handle.assertOwned!())
    parentLease = parent.child.lease
  }
  const chosen = f.another({ rootToken: token, receiver })
  const source = await f.stage(parentLease, chosen, true, initial)
  // Registered recovery/reattach association is a C2 UNIT DOUBLE. Control's backend,
  // actual journal, scopes and Kernel are real; this is NOT actual Native recovery QA.
  const control = { ...source.control }, identity = Object.freeze({ recovered: true })
  f.controls.set(source.row.task_id, control)
  const accepted = f.accepted.get(source.row.task_id)!
  f.accepted.set(source.row.task_id, { ...accepted, identity, control })
  const actual = (await f.journal.read(source.row.task_id))!
  const association: NotificationRecoveredAssociation = { identity, control, birth: { ...accepted.birth }, beforeEpoch: 0, nativeEpoch: 0,
    claim: source.row.residency_claim, result: { ok: true }, ...(initial ? { initialInput: { inputID: actual.inboxID!, row: structuredClone(actual) } } : {}) }
  f.recovered.set(control, association)
  return { f, chosen, source, control, identity, association, token, receiver }
}

for (const nested of [false, true]) test(`recovered ${nested ? "nested receiver" : "root receiver"} uses actual ROOT basis and registered recovery identity`, async () => {
  const r = await recoveredFixture(false, nested), task = r.chosen.bindRecovered(r.control)
  await expect(r.chosen.bindCurrentOwnedRun(r.source.task)).rejects.toThrow()
  const run = await r.chosen.bindCurrentOwnedRun(task), permit = await r.chosen.validateForDispatch(run, r.f.source(r.source.row))
  expect(() => r.chosen.assertDispatchCurrent(permit)).not.toThrow()
  expect(r.chosen.assertAcceptedTaskCurrent(task).task_id).toBe(r.source.row.task_id)
})

test("recovered terminal initial run uses original claimed accepted ledger, not a fabricated new begin", async () => {
  const r = await recoveredFixture(true), task = r.chosen.bindRecovered(r.control)
  const actual = (await r.f.journal.read(r.source.row.task_id))!
  expect(actual.turn).toBeUndefined(); expect(actual.admission).toBe("accepted")
  const run = await r.chosen.bindCurrentOwnedRun(task), permit = await r.chosen.validateForDispatch(run, r.f.source(r.source.row))
  expect(() => r.chosen.assertDispatchCurrent(permit)).not.toThrow()
})

for (const change of ["missing", "birth", "epoch", "claim", "result", "identity"] as const) test(`recovered ${change} cannot mint a replacement from matching record fields`, async () => {
  const r = await recoveredFixture()
  if (change === "missing") r.f.recovered.delete(r.control)
  else r.f.recovered.set(r.control, { ...r.association, ...(change === "birth" ? { birth: { ...r.association.birth, createdAt: "different" } } : {}),
    ...(change === "epoch" ? { nativeEpoch: 1 } : {}), ...(change === "claim" ? { claim: "other" } : {}),
    ...(change === "result" ? { result: { ok: false, kind: "failed", reason: "controlled refused" } as const } : {}), ...(change === "identity" ? { identity: {} } : {}) })
  expect(() => r.chosen.bindRecovered(r.control)).toThrow()
})

test("recovery needs real root token and original recovered association remains fenced through GET", async () => {
  const r = await recoveredFixture(), absent = r.f.another({ rootToken: undefined })
  expect(() => absent.bindRecovered(r.control)).toThrow("root component basis")
  const task = r.chosen.bindRecovered(r.control), run = await r.chosen.bindCurrentOwnedRun(task), deferred = r.f.deferredGet()
  const pending = r.chosen.validateForDispatch(run, r.f.source(r.source.row)); await deferred.entered.promise
  r.f.recovered.set(r.control, { ...r.association })
  deferred.gate.resolve({ id: r.f.root.sessionID, location: { directory: "/unit/project" } })
  await expect(pending).rejects.toThrow("association changed")
})

test("original Kernel token cannot provision NEW grant after callback closes", async () => {
  const f = await fixture(); let token!: IssuedToolCall; await f.call(value => { token = value })
  expect(() => f.issuer.provision(token, f.spec())).toThrow("active authorized")
})
test("queued accepted custody survives callback closure without using future start permission", async () => {
  const f = await fixture(), accepted = await f.queued(), run = await f.issuer.bindCurrentOwnedRun(accepted.task)
  const permit = await f.issuer.validateForDispatch(run, f.source(accepted.row)); expect(() => f.issuer.assertDispatchCurrent(permit)).not.toThrow()
  expect(f.queryCalls()).toBe(1)
})
test("opaque grants and genuine source object cannot be replaced by matching fields", async () => {
  const f = await fixture(), accepted = await f.queued()
  await expect(f.issuer.bindCurrentOwnedRun({} as AcceptedNotificationTask)).rejects.toThrow("Unissued")
  const run = await f.issuer.bindCurrentOwnedRun(accepted.task), source = f.source(accepted.row)
  await expect(f.issuer.validateForDispatch(run, { ...source })).rejects.toThrow("Unissued")
  expect(() => f.issuer.assertDispatchCurrent({} as never)).toThrow("Unissued")
  expect(f.queryCalls()).toBe(0)
})
test("missing C2 evidence capabilities refuse without synthesizing accepted records", async () => {
  const f = await fixture(), absent = f.another({ readers: undefined }); let grant!: ProvisionalNotificationGrant
  const original = f.spec(); await f.call(token => { grant = absent.provision(token, original) })
  expect(() => absent.bindAcceptedWithoutChild(grant, { kind: "started", task_id: "made-up", name: "unit", status: "pending" })).toThrow("unavailable")
})
test("exact returned result identity matters; record-only and empty/no-result refusals do not bind", async () => {
  const f = await fixture(), original = f.spec(), row = f.record(); let grant!: ProvisionalNotificationGrant
  await f.call(token => { grant = f.issuer.provision(token, original) })
  const result: Result = { kind: "started", task_id: row.task_id, name: "unit", status: "pending" }
  expect(() => f.issuer.bindAcceptedWithoutChild(grant, result)).toThrow("acceptance")
  const identity = {}; f.returned.set(original, { result, identity }); f.accepted.set(row.task_id, { identity, epoch: 0, claim: row.residency_claim, birth: { createdAt: row.created_at, parentSessionId: row.parent_session_id, rootSessionId: row.root_session_id, depth: row.depth } })
  expect(() => f.issuer.bindAcceptedWithoutChild(grant, { ...result })).toThrow("acceptance")
  const task = f.issuer.bindAcceptedWithoutChild(grant, result)
  expect(() => f.issuer.bindAcceptedWithoutChild(grant, result)).toThrow()
  expect(await f.issuer.bindCurrentOwnedRun(task)).toBeDefined()
})
test("staged original and DISTINCT managed spec association binds before begin, then spec association may disappear", async () => {
  const f = await fixture(), staged = await f.stage()
  expect(staged.original).not.toBe(staged.managed)
  f.staged.delete(staged.control); f.returned.delete(staged.original)
  const run = await f.issuer.bindCurrentOwnedRun(staged.task), source = f.source(staged.row)
  const permit = await f.issuer.validateForDispatch(run, source); expect(() => f.issuer.assertDispatchCurrent(permit)).not.toThrow()
})
test("wrong staged association and control replacement cannot bind or refresh custody", async () => {
  const f = await fixture(), staged = await f.stage(f.root, f.issuer, false), association = f.staged.get(staged.control)!
  f.staged.set(staged.control, { ...association, original: new WeakRef(f.spec()) })
  expect(() => f.issuer.bindStaged(staged.grant, staged.managed, staged.control)).toThrow("association")
  f.staged.set(staged.control, association); const task = f.issuer.bindStaged(staged.grant, staged.managed, staged.control)
  f.controls.set(staged.row.task_id, { ...staged.control })
  await expect(f.issuer.bindCurrentOwnedRun(task)).rejects.toThrow("replaced")
})
for (const change of ["epoch","parent","root","depth","birth","claim"] as const) test(`queued source ${change} race after genuine receiver get denies old permit`, async () => {
  const f = await fixture(), accepted = await f.queued(), run = await f.issuer.bindCurrentOwnedRun(accepted.task), source = f.source(accepted.row), deferred = f.deferredGet()
  const pending = f.issuer.validateForDispatch(run, source); await deferred.entered.promise
  f.store.mutate(accepted.row.task_id, row => change === "epoch" ? { ...row, notification: { ...row.notification, run_epoch: 1 } }
    : change === "parent" ? { ...row, parent_session_id: "foreign" } : change === "root" ? { ...row, root_session_id: "foreign" }
    : change === "depth" ? { ...row, depth: 7 } : change === "birth" ? { ...row, created_at: "changed" } : { ...row, residency_claim: "changed" })
  deferred.gate.resolve({ id: "root" as SessionLease["sessionID"], location: { directory: "/unit/project" } })
  await expect(pending).rejects.toThrow()
})
test("registry and lease generations are independent and each retired identity refuses", async () => {
  const f = await fixture(), accepted = await f.queued(), run = await f.issuer.bindCurrentOwnedRun(accepted.task), source = f.source(accepted.row)
  expect(f.root.generation).not.toBe(f.registry.generation + 10)
  f.registry.replace([])
  await expect(f.issuer.validateForDispatch(run, source)).rejects.toThrow("registry")
  const g = await fixture(), q = await g.queued(), r = await g.issuer.bindCurrentOwnedRun(q.task)
  g.scopes.open("root" as SessionLease["sessionID"], { tools: [], authorize() {} })
  await expect(g.issuer.validateForDispatch(r, g.source(q.row))).rejects.toThrow()
})
test("actual receiver parent/location mismatch is denied, never an idle/liveness inference", async () => {
  const f = await fixture(), q = await f.queued(), run = await f.issuer.bindCurrentOwnedRun(q.task), source = f.source(q.row)
  f.setGet(async () => ({ id: f.root.sessionID, parentID: "foreign" as SessionLease["sessionID"], location: { directory: "/unit/project" } }))
  await expect(f.issuer.validateForDispatch(run, source)).rejects.toThrow("receiver identity")
  f.setGet(async () => ({ id: f.root.sessionID, location: { directory: "/other" } }))
  await expect(f.issuer.validateForDispatch(run, source)).rejects.toThrow("receiver identity")
})
test("sync dispatch fence rejects mutation AFTER successful asynchronous validation", async () => {
  const f = await fixture(), q = await f.queued(), run = await f.issuer.bindCurrentOwnedRun(q.task), permit = await f.issuer.validateForDispatch(run, f.source(q.row))
  f.store.mutate(q.row.task_id, row => ({ ...row, parent_session_id: "other" }))
  expect(() => f.issuer.assertDispatchCurrent(permit)).toThrow()
})
test("same actual backend/journal progress passes while raw reference-only advance/rollback fails", async () => {
  const f = await fixture(), staged = await f.stage(), run = await f.issuer.bindCurrentOwnedRun(staged.task), source = f.source(staged.row), deferred = f.deferredGet()
  const pending = f.issuer.validateForDispatch(run, source); await deferred.entered.promise; await staged.progress()
  deferred.gate.resolve({ id: f.root.sessionID, location: { directory: "/unit/project" } }); const permit = await pending
  expect(() => f.issuer.assertDispatchCurrent(permit)).not.toThrow()
  f.store.mutate(staged.row.task_id, row => ({ ...row, owned_session: { ...row.owned_session!, journalRevision: row.owned_session!.journalRevision + 1 } }))
  expect(() => f.issuer.assertDispatchCurrent(permit)).toThrow("reference")
})
test("closed SOURCE needs real backend closed receipt but does not close original receiver", async () => {
  const f = await fixture(), staged = await f.stage(); await staged.closeSource()
  const run = await f.issuer.bindCurrentOwnedRun(staged.task), permit = await f.issuer.validateForDispatch(run, f.source(f.store.load(staged.row.task_id)!))
  expect(() => f.issuer.assertDispatchCurrent(permit)).not.toThrow(); expect(f.root.signal.aborted).toBe(false)
})
test("retirement joins ORIGINAL held get, never races it or creates another query", async () => {
  const f = await fixture(), q = await f.queued(), run = await f.issuer.bindCurrentOwnedRun(q.task), deferred = f.deferredGet()
  const pending = f.issuer.validateForDispatch(run, f.source(q.row)); void pending.catch(()=>{}); await deferred.entered.promise
  let done = false; const retirement = f.issuer.retire().then(()=>{done=true}); await Promise.resolve()
  expect(done).toBe(false); expect(f.issuer.diagnostics().pending).toBe(1)
  deferred.gate.resolve({ id: f.root.sessionID, location: { directory: "/unit/project" } })
  await expect(pending).rejects.toThrow("quiescing"); await retirement
  expect(done).toBe(true); expect(f.queryCalls()).toBe(1)
})
test("get error including falsey rejection is observed and retirement reports once without replay", async () => {
  const f = await fixture(), q = await f.queued(), run = await f.issuer.bindCurrentOwnedRun(q.task)
  f.setGet(() => Promise.reject(undefined))
  let rejected = false; try { await f.issuer.validateForDispatch(run, f.source(q.row)) } catch (error) { rejected=true; expect(error).toBeUndefined() }
  expect(rejected).toBe(true); await expect(f.issuer.retire()).rejects.toBeInstanceOf(AggregateError)
  await f.issuer.retire(); expect(f.issuer.diagnostics()).toMatchObject({ state: "retired", pending: 0, queryFailures: 1 }); expect(f.queryCalls()).toBe(1)
})
test("only exact abort reason is expected joined cancellation, raced network failure stays history", async () => {
  for (const exact of [true,false]) {
    const f = await fixture(), q = await f.queued(), run = await f.issuer.bindCurrentOwnedRun(q.task), entered = Promise.withResolvers<void>()
    f.setGet((_input, options) => new Promise((_resolve,reject) => { entered.resolve(); options!.signal!.addEventListener("abort",()=>reject(exact?options!.signal!.reason:Error("network raced abort")),{once:true}) }))
    const pending = f.issuer.validateForDispatch(run,f.source(q.row)); void pending.catch(()=>{}); await entered.promise
    const retirement = f.issuer.retire(); await expect(pending).rejects.toThrow()
    if (exact) { await retirement; expect(f.issuer.diagnostics().queryFailures).toBe(0) }
    else { await expect(retirement).rejects.toBeInstanceOf(AggregateError); await f.issuer.retire(); expect(f.issuer.diagnostics().queryFailures).toBe(1) }
  }
})

for (const state of ["running","cancelled","interrupt-cause-removed"] as const) test(`canonical eligibility ${state} change during receiver GET cannot mint permit`, async () => {
  const f = await fixture(), q = await f.queued()
  if (state === "interrupt-cause-removed") f.store.mutate(q.row.task_id, row => ({ ...row, status: "interrupted", interrupt_cause: "session_replaced" }))
  const row = f.store.load(q.row.task_id)!, run = await f.issuer.bindCurrentOwnedRun(q.task), source = f.source(row), deferred = f.deferredGet()
  const pending = f.issuer.validateForDispatch(run, source); await deferred.entered.promise
  f.store.mutate(q.row.task_id, current => state === "interrupt-cause-removed" ? { ...current, interrupt_cause: undefined } : { ...current, status: state })
  deferred.gate.resolve({ id: f.root.sessionID, location: { directory: "/unit/project" } })
  await expect(pending).rejects.toThrow("eligible")
})
test("actual CLOSED journal receipt cannot corroborate raw ref revision advance during GET", async () => {
  const f = await fixture(), staged = await f.stage(); await staged.closeSource()
  const closed = f.closed.get(staged.row.task_id)!, durableRevision = closed.row.revision
  // Closed path must use actual durable receipt, not the retired live handle/no-op guard.
  staged.control.handle.assertOwned = () => { throw Error("retired live guard is NOT closed proof") }
  const run = await f.issuer.bindCurrentOwnedRun(staged.task), source = f.source(f.store.load(staged.row.task_id)!), deferred = f.deferredGet()
  const pending = f.issuer.validateForDispatch(run, source); await deferred.entered.promise
  f.store.mutate(staged.row.task_id, row => ({ ...row, owned_session: { ...row.owned_session!, journalRevision: durableRevision + 1 } }))
  deferred.gate.resolve({ id: f.root.sessionID, location: { directory: "/unit/project" } })
  await expect(pending).rejects.toThrow()
  expect((await f.journal.read(staged.row.task_id))!.revision).toBe(durableRevision)
})

async function nested(f: Awaited<ReturnType<typeof fixture>>) {
  const parent = await f.stage()
  const binding = f.bindings.adopt(parent.backend.borrowParent(parent.child), 1, () => parent.control.handle.assertOwned!())
  const issuer = f.another({ receiver: binding })
  return { parent, binding, issuer }
}
test("ordinary completed live RECEIVER retains exact child lease with independent registry generation", async () => {
  const f = await fixture(), n = await nested(f)
  expect(n.parent.child.lease.generation).not.toBe(f.registry.generation)
  const q = await f.queued(n.issuer, n.parent.child.lease), run = await n.issuer.bindCurrentOwnedRun(q.task)
  const permit = await n.issuer.validateForDispatch(run, f.source(q.row))
  expect(() => n.issuer.assertDispatchCurrent(permit)).not.toThrow()
  expect(f.queryCalls()).toBe(2) // Actual unit parent child + root queries, no invented status API.
})
for (const field of ["root","parent","child","depth","claim","control","killed"] as const) test(`original nested receiver chain ${field} mutation cannot refresh old accepted grant`, async () => {
  const f = await fixture(), n = await nested(f), q = await f.queued(n.issuer,n.parent.child.lease)
  const run = await n.issuer.bindCurrentOwnedRun(q.task), source = f.source(q.row), deferred = f.deferredGet()
  const pending = n.issuer.validateForDispatch(run,source); await deferred.entered.promise
  if(field==="control") f.controls.set(n.parent.row.task_id,{...n.parent.control})
  else f.store.mutate(n.parent.row.task_id,row=>field==="root"?{...row,root_session_id:"foreign"}:field==="parent"?{...row,parent_session_id:"foreign",owned_session:{...row.owned_session!,parentID:"foreign"}}
    :field==="child"?{...row,child_session_id:"foreign",owned_session:{...row.owned_session!,sessionID:"foreign"}}:field==="depth"?{...row,depth:7}:field==="claim"?{...row,residency_claim:"foreign",owned_session:{...row.owned_session!,residencyClaim:"foreign"}}:{...row,killed:true})
  deferred.gate.resolve({id:n.parent.child.locator.sessionID,parentID:f.root.sessionID,location:{directory:"/unit/project"}})
  await expect(pending).rejects.toThrow()
})
test("nested SAME control and actual backend journal progress keeps accepted receiver custody", async()=>{
  const f=await fixture(),n=await nested(f),q=await f.queued(n.issuer,n.parent.child.lease),run=await n.issuer.bindCurrentOwnedRun(q.task)
  let gets=0
  f.setGet(async({sessionID})=>{
    if(++gets===1) await n.parent.progress()
    return {id:sessionID as SessionLease["sessionID"],...(sessionID===f.root.sessionID?{}:{parentID:f.root.sessionID}),location:{directory:"/unit/project"}}
  })
  const permit=await n.issuer.validateForDispatch(run,f.source(q.row));expect(()=>n.issuer.assertDispatchCurrent(permit)).not.toThrow()
})
test("revoking canonical source registration during GET prevents permit creation",async()=>{
  const f=await fixture(),q=await f.queued(),run=await f.issuer.bindCurrentOwnedRun(q.task),source=f.source(q.row),deferred=f.deferredGet()
  const pending=f.issuer.validateForDispatch(run,source);await deferred.entered.promise;f.sources.delete(source)
  deferred.gate.resolve({id:f.root.sessionID,location:{directory:"/unit/project"}})
  await expect(pending).rejects.toThrow("Unissued")
})
test("closed file ref cannot advance even BELOW durable CLOSED ceiling",async()=>{
  const f=await fixture(),s=await f.stage();await s.closeSource();const known=f.closed.get(s.row.task_id)!
  expect(known.row.revision).toBeGreaterThan(known.referenceRevision)
  const run=await f.issuer.bindCurrentOwnedRun(s.task),source=f.source(f.store.load(s.row.task_id)!),deferred=f.deferredGet()
  const pending=f.issuer.validateForDispatch(run,source);await deferred.entered.promise
  f.store.mutate(s.row.task_id,row=>({...row,owned_session:{...row.owned_session!,journalRevision:known.referenceRevision+1}}))
  deferred.gate.resolve({id:f.root.sessionID,location:{directory:"/unit/project"}})
  await expect(pending).rejects.toThrow("reference")
})

test("returned acceptance birth captured BEFORE binding cannot adopt a replaced same-ID record",async()=>{
  const f=await fixture(),original=f.spec(),row=f.record(),identity={}
  const result:Result={kind:"started",task_id:row.task_id,name:"unit",status:"pending"}
  const birth={createdAt:row.created_at,parentSessionId:row.parent_session_id,rootSessionId:row.root_session_id,depth:row.depth}
  f.accepted.set(row.task_id,Object.assign({identity,epoch:0,claim:row.residency_claim},{birth}))
  f.returned.set(original,{identity,result});let grant!:ProvisionalNotificationGrant
  await f.call(token=>{grant=f.issuer.provision(token,original)})
  f.store.mutate(row.task_id,current=>({...current,created_at:"2026-11-10T00:00:00.000Z"}))
  expect(()=>f.issuer.bindAcceptedWithoutChild(grant,result)).toThrow("birth")
})
test("accepted opaque lifetime cannot adopt changed captured birth even with same identity",async()=>{
  const f=await fixture(),q=await f.queued(),prior=f.accepted.get(q.row.task_id)!
  f.accepted.set(q.row.task_id,Object.assign({},prior,{birth:{createdAt:"changed",parentSessionId:"root",rootSessionId:"root",depth:1}}))
  await expect(f.issuer.bindCurrentOwnedRun(q.task)).rejects.toThrow("birth")
})
test("CLOSED captured reference cannot be refreshed from mutable port DURING real journal read",async()=>{
  const f=await fixture(),gate=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>()
  const issuer=f.another({readers:{...f.options.readers!,journal:{owner:f.journal.owner,
    read(key){return f.journal.read(key).then(async row=>{entered.resolve();await gate.promise;return row})},assertCurrent(row){return f.journal.assertCurrent(row)}}}})
  const staged=await f.stage(f.root,issuer);await staged.closeSource()
  const pending=issuer.bindCurrentOwnedRun(staged.task);void pending.catch(()=>{})
  try{
    await entered.promise;const entry=f.closed.get(staged.row.task_id)!,next=entry.referenceRevision+1
    expect(next).toBeLessThanOrEqual(entry.row.revision)
    f.store.mutate(staged.row.task_id,row=>({...row,owned_session:{...row.owned_session!,journalRevision:next}}))
    Reflect.set(entry,"referenceRevision",next) // Explicit mutable UNIT port alias race.
    gate.resolve();await expect(pending).rejects.toThrow()
  }finally{gate.resolve()}
})

test("stop issuance rejects new provision; quiesce rejects new run/dispatch without retiring real lease",async()=>{
  const f=await fixture(),q=await f.queued(),run=await f.issuer.bindCurrentOwnedRun(q.task),source=f.source(q.row)
  f.issuer.stopIssuing();await f.call(token=>{expect(()=>f.issuer.provision(token,f.spec())).toThrow("issuance stopped")})
  const permit=await f.issuer.validateForDispatch(run,source)
  f.issuer.quiesce();expect(()=>f.issuer.assertDispatchCurrent(permit)).toThrow("quiescing")
  await expect(f.issuer.bindCurrentOwnedRun(q.task)).rejects.toThrow("quiescing")
  expect(()=>f.scopes.assert(f.root)).not.toThrow();await f.issuer.retire()
})
test("foreign root and wrong registry generation cannot become completion grant authority",async()=>{
  const f=await fixture(),other=await fixture()
  expect(()=>f.another({root:other.root})).toThrow("Foreign")
  const wrong=f.another({registryGeneration:f.registry.generation+1})
  await f.call(token=>{expect(()=>wrong.provision(token,f.spec())).toThrow("generation")})
})
test("fresh process executes private issuer refusal/retirement with SDK/UI/Native adapter poison",()=>{
  const source=new URL("./parent-notification-authority.ts",import.meta.url).href
  const scopesURL=new URL("../../host/session-state.ts",import.meta.url).href
  const bindingsURL=new URL("./parent-binding.ts",import.meta.url).href
  const script=`let forbidden=0,queries=0;
Bun.plugin({name:"C1A-cold",setup(b){b.onResolve({filter:/^(@code-yeongyu\\/senpi|@earendil-works\\/pi-tui|@opencode\\/plugin|@oh-my-opencode\\/omo-senpi)(\\/|$)/},a=>{forbidden++;throw Error("FORBIDDEN:"+a.path)});b.onLoad({filter:/[\\\\/]packages[\\\\/]omo-senpi[\\\\/]/},()=>{forbidden++;throw Error("NATIVE_ADAPTER")})}});
const {createParentNotificationAuthorityIssuer}=await import(${JSON.stringify(source)}),{createSessionScopes}=await import(${JSON.stringify(scopesURL)}),{createParentBindings}=await import(${JSON.stringify(bindingsURL)});
const scopes=createSessionScopes(),policy={tools:[],authorize(){}},root=scopes.open("unit-root",policy),bindings=createParentBindings(root,policy,()=>scopes.assert(root));
const unavailable=()=>{throw Error("UNIT unavailable Kernel authority")};const issuer=createParentNotificationAuthorityIssuer({root,receiver:bindings.root,bindings,scopes,registryGeneration:1,directory:"unit",rootDirectory:"unit",hostVersion:"2.2.6",callAuthority:{capture:unavailable,assert:unavailable,assertCall:unavailable,parent:unavailable},session:{get(){queries++;throw Error("unexpected GET")}}});
let refused=false;try{issuer.assertDispatchCurrent({})}catch{refused=true}issuer.quiesce();await issuer.retire();if(forbidden||queries||!refused||issuer.diagnostics().state!=="retired")throw Error("Cold failure");scopes.dispose();console.log(JSON.stringify({forbidden,queries,forgedRefused:refused,state:issuer.diagnostics().state}));`
  const child=Bun.spawnSync([process.execPath,"--eval",script],{stdout:"pipe",stderr:"pipe",timeout:5000})
  expect(new TextDecoder().decode(child.stderr)).toBe("");expect(child.exitCode).toBe(0)
  expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({forbidden:0,queries:0,forgedRefused:true,state:"retired"})
})

test("no-admission recovered-spec shape cannot be fed to the NEW-start branch",async()=>{
  const f=await fixture(),s=await f.stage(f.root,f.issuer,false),prior=f.staged.get(s.control)!
  const {admission:_admission,...recoveredShape}=s.managed
  f.staged.set(s.control,{...prior,managed:new WeakRef(recoveredShape)})
  expect(()=>f.issuer.bindStaged(s.grant,recoveredShape,s.control)).toThrow("association")
})
