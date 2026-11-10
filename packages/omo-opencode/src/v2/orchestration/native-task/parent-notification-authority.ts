import type { ManagerStartSpec, ManagedStartSpec, TaskManager, ReattachingTaskManager, TaskRecord, TaskRecordStore, HostStartAuthority } from "@oh-my-opencode/senpi-task/manager-kernel"
import { shouldNotifyRecord } from "@oh-my-opencode/senpi-task/task-operations"
import type { CompletionDeliverySource } from "@oh-my-opencode/senpi-task/task-operations"
import type { IssuedToolCall, ToolCallAuthority } from "../../host/tool-kernel"
import type { SessionLease, SessionScopes } from "../../host/session-state"
import type { SessionBackendApi, ChildRecord } from "../../host/session-backend"
import type { DurableChildJournal } from "../../host/child-journal"
import { parentBindingInfo, type createParentBindings, type VerifiedParentBinding } from "./parent-binding"
import { ownedAncestorPath } from "./ancestry"
import type { OwnedTaskControl } from "./owned-handle"

const provisionalBrand: unique symbol = Symbol("completion provisional")
const taskBrand: unique symbol = Symbol("completion task custody")
const runBrand: unique symbol = Symbol("completion run custody")
const permitBrand: unique symbol = Symbol("completion dispatch permit")
type StartResult = Awaited<ReturnType<TaskManager["start"]>>
export interface ProvisionalNotificationGrant { readonly [provisionalBrand]: true }
export interface AcceptedNotificationTask { readonly [taskBrand]: true }
export interface NotificationRunBinding { readonly [runBrand]: true }
export interface NotificationDispatchPermit { readonly [permitBrand]: true }
/** FUTURE trusted C2 wiring, not an existing runtime accessor or proof from structural data alone.
 * Identity is issued at actual original capture/result/installed boundaries. Spec references are
 * only checked at binding; accepted lifetime retains the distinct opaque identity, never params. */
export interface NotificationAcceptedCustody {
  readonly identity: object
  /** Copied at REAL acceptance/installation, never discovered later from an arbitrary row. */
  readonly birth: { readonly createdAt: string; readonly parentSessionId: string; readonly rootSessionId: string; readonly depth: number }
  readonly epoch: number
  readonly claim: string | undefined
  readonly control?: OwnedTaskControl
}
export interface NotificationStagedAssociation {
  readonly original: WeakRef<ManagerStartSpec>
  readonly managed: WeakRef<ManagedStartSpec>
  readonly hostAuthority: HostStartAuthority
  readonly identity: object
  readonly stageIdentity?: object
}
export interface NotificationInitialInputAssociation {
  readonly identity: object
  readonly control: OwnedTaskControl
  readonly stageIdentity: object
  readonly nativeEpoch: number
  readonly inputID: string
  readonly begin: ReturnType<OwnedTaskControl["begin"]>
}
export interface NotificationFailedStartAssociation {
  readonly identity: object
  readonly control: OwnedTaskControl
  readonly stageIdentity: object
  readonly nativeEpoch: number
  readonly result: Extract<StartResult, { kind: "start_failed" }>
  readonly beginInvoked: false
}
export interface NotificationRecoveredAssociation {
  readonly identity: object
  readonly control: OwnedTaskControl
  readonly birth: NotificationAcceptedCustody["birth"]
  readonly beforeEpoch: number
  readonly nativeEpoch: number
  readonly claim: string | undefined
  readonly result: Awaited<ReturnType<ReattachingTaskManager["reattach"]>>
  readonly initialInput?: { readonly inputID: string; readonly row: ChildRecord }
}
export interface NotificationReturnedAssociation {
  readonly result: StartResult
  readonly identity: object
}
export interface NotificationClosedSource {
  readonly control: OwnedTaskControl
  readonly row: ChildRecord
  /** Existing runtime.closedControls.revision captured at REAL cleanup, not a later file read. */
  readonly referenceRevision: number
}
export interface NotificationEvidenceReaders {
  readonly store: Pick<TaskRecordStore, "load" | "list">
  readonly journal: Pick<DurableChildJournal, "owner" | "read" | "assertCurrent">
  readonly controls?: ReadonlyMap<string, OwnedTaskControl>
  readonly accepted?: ReadonlyMap<string, NotificationAcceptedCustody>
  readonly staged?: Pick<WeakMap<OwnedTaskControl, NotificationStagedAssociation>, "get">
  readonly returned?: Pick<WeakMap<ManagerStartSpec, NotificationReturnedAssociation>, "get">
  readonly closed?: ReadonlyMap<string, NotificationClosedSource>
  /** Registered ONLY by C2's actual A6b enqueueWithSource callback, not by field equality. */
  readonly sources?: Pick<WeakSet<CompletionDeliverySource>, "has">
  readonly initialInputs?: Pick<WeakMap<OwnedTaskControl, NotificationInitialInputAssociation>, "get">
  readonly failedStarts?: Pick<WeakMap<OwnedTaskControl, NotificationFailedStartAssociation>, "get">
  readonly recovered?: Pick<WeakMap<OwnedTaskControl, NotificationRecoveredAssociation>, "get">
}
export interface ParentNotificationAuthorityOptions {
  readonly callAuthority: ToolCallAuthority
  readonly scopes: SessionScopes
  readonly bindings: ReturnType<typeof createParentBindings>
  readonly receiver: VerifiedParentBinding
  readonly root: SessionLease
  readonly registryGeneration: number
  readonly directory: string
  readonly rootDirectory: string
  readonly hostVersion: string
  readonly session: Pick<SessionBackendApi, "get">
  readonly readers?: NotificationEvidenceReaders
  readonly rootToken?: IssuedToolCall
}
export class NotificationAuthorityError extends Error { override readonly name = "NotificationAuthorityError" }
function fail(message: string): never { throw new NotificationAuthorityError(message) }
function ownedRef(row: TaskRecord): NonNullable<TaskRecord["owned_session"]> {
  if (!row.owned_session) fail("Notification owned source identity differs")
  return row.owned_session
}
function relationship(row: TaskRecord): string {
  const owned = row.owned_session && { ...row.owned_session, journalRevision: undefined }
  return JSON.stringify([row.task_id, row.created_at, row.parent_session_id, row.root_session_id, row.depth,
    row.child_session_id, row.notification.run_epoch, row.residency_claim, row.residency_state, row.runner_kind,
    row.host_pid, owned])
}
function receiverRelationship(row: TaskRecord): string {
  return JSON.stringify([relationship(row), row.killed === true, row.status === "cancelled" || row.status === "lost", row.cancel_requested])
}
function closedRowSnapshot(row: ChildRecord): ChildRecord {
  return Object.freeze({ ...row, locator: Object.freeze({ ...row.locator }), receipts: Object.freeze({ ...row.receipts }), ...(row.turn ? { turn: Object.freeze({ ...row.turn }) } : {}) })
}

/** One issuer per ORIGINAL receiving binding. No transport, lease retirement or C2 reader is
 * fabricated here. Kernel/unit contexts are not genuine SDK callbacks; real C2 wiring is pending. */
export function createParentNotificationAuthorityIssuer(options: ParentNotificationAuthorityOptions) {
  const { callAuthority, scopes, bindings, receiver, root, registryGeneration, directory, rootDirectory, hostVersion, session, readers, rootToken } = options
  const receiverInfo = parentBindingInfo(receiver), lease = receiverInfo.lease
  if (bindings.info(bindings.root).lease !== root || bindings.info(receiver) !== receiverInfo || receiverInfo.rootSessionId !== root.sessionID) fail("Foreign notification receiver root")
  const stop = new AbortController()
  let state: "open" | "quiescing" | "retired" = "open", issuing = true
  type Parent = { token: IssuedToolCall; spec?: WeakRef<ManagerStartSpec>; parent: string; root: string; depth: number; bound: boolean; chain: Chain }
  type Task = { token: IssuedToolCall; rootBasis?: true; id: string; birth: string; parent: string; root: string; depth: number; identity: object; initialEpoch: number; initialClaim: string | undefined; control?: OwnedTaskControl; stageIdentity?: object; recovered?: NotificationRecoveredAssociation; recoveryFingerprint?: string; recoveryResult?: NotificationRecoveredAssociation["result"]; chain: Chain }
  type Run = { task: Task; epoch: number; identity: string; revision: number; control?: OwnedTaskControl; closed?: NotificationClosedSource; closedRow?: ChildRecord; closedReferenceRevision?: number; admissionProof?: () => void }
  type Chain = { readonly identities: readonly string[]; readonly controls: readonly OwnedTaskControl[]; readonly revisions: readonly number[] }
  const provisionals = new WeakMap<ProvisionalNotificationGrant, Parent>(), tasks = new WeakMap<AcceptedNotificationTask, Task>()
  const runs = new WeakMap<NotificationRunBinding, Run>(), permits = new WeakMap<NotificationDispatchPermit, { run: Run; source: CompletionDeliverySource; chain: Chain }>()
  const pending = new Set<Promise<unknown>>(), queryErrors: unknown[] = []
  let reportedErrors = 0, retirement: Promise<void> | undefined
  function current(token?: IssuedToolCall, rootBasis = false): void {
    if (state !== "open") fail("Notification issuer is quiescing or retired")
    scopes.assert(root); scopes.assert(lease)
    if (bindings.info(receiver) !== receiverInfo || receiverInfo.lease !== lease || receiverInfo.rootSessionId !== root.sessionID
      || bindings.info(bindings.root).lease !== root) fail("Notification receiving binding changed")
    if (token) {
      const target = rootBasis ? root : lease
      callAuthority.assert(token, target)
      if (token.registryGeneration !== registryGeneration || token.leaseGeneration !== target.generation) fail("Notification registry or lease generation differs")
    }
  }
  function evidence(): NotificationEvidenceReaders { if (!readers) fail("Notification C2 evidence readers unavailable"); return readers }
  function custody(task: Task): TaskRecord {
    current(task.token, task.rootBasis)
    task.chain = chain(task.token, task.chain, task.rootBasis)
    const ports = evidence(), actual = ports.accepted?.get(task.id), row = ports.store.load(task.id)
    if (!actual || actual.identity !== task.identity) fail("Original accepted notification custody unavailable")
    if (task.recovered && ((task.control ? ports.recovered?.get(task.control) : undefined) !== task.recovered || task.recovered.identity !== task.identity
      || task.recovered.control !== task.control || task.recovered.result !== task.recoveryResult || !task.recovered.result.ok
      || recoveryFingerprint(task.recovered) !== task.recoveryFingerprint)) fail("Original recovered notification association changed")
    if (!actual.birth || actual.birth.createdAt !== task.birth || actual.birth.parentSessionId !== task.parent
      || actual.birth.rootSessionId !== task.root || actual.birth.depth !== task.depth) fail("Captured accepted notification birth changed")
    if (!row || row.created_at !== task.birth || row.parent_session_id !== task.parent || row.root_session_id !== task.root || row.depth !== task.depth) fail("Notification accepted task relationship changed")
    if (row.child_session_id) {
      const control = ports.controls?.get(task.id) ?? ports.closed?.get(task.id)?.control
      if (!control || actual.control !== control || task.control && task.control !== control) fail("Notification private control replaced or unavailable")
      task.control ??= control
      if (!task.stageIdentity) {
        const association = ports.staged?.get(control)
        if (association?.identity === task.identity) task.stageIdentity = association.stageIdentity
      }
    } else if (task.control || actual.epoch !== task.initialEpoch || actual.claim !== task.initialClaim
      || row.notification.run_epoch !== task.initialEpoch || row.residency_claim !== task.initialClaim || row.owned_session) fail("Queued notification custody changed")
    return row
  }
  function checkControl(row: TaskRecord, control: OwnedTaskControl): void {
    const ref = row.owned_session
    if (!ref || control.handle.task_id !== row.task_id || control.child.locator.sessionID !== row.child_session_id
      || control.child.locator.parentID !== row.parent_session_id || ref.sessionID !== row.child_session_id
      || ref.parentID !== row.parent_session_id || ref.runEpoch !== row.notification.run_epoch || ref.residencyClaim !== row.residency_claim
      || ref.backendID !== control.child.locator.backendID || ref.hostVersion !== hostVersion || ref.location !== control.child.locator.location
      || ref.generation !== control.child.locator.generation || ref.journalOwner !== evidence().journal.owner) fail("Notification owned source identity differs")
  }
  function recoveryFingerprint(value: NotificationRecoveredAssociation): string {
    return JSON.stringify([value.birth.createdAt, value.birth.parentSessionId, value.birth.rootSessionId, value.birth.depth,
      value.beforeEpoch, value.nativeEpoch, value.claim, value.result.ok])
  }
  /** No turn descriptor is written for the first input. Its actual private begin return
   * and backend's accepted ledger are required instead; absence alone proves nothing. */
  function uncheckpointedProof(task: Task, row: TaskRecord, actual: ChildRecord): () => void {
    const control = task.control, ports = evidence()
    const accepted = ports.accepted?.get(task.id)
    if (!accepted || accepted.identity !== task.identity) fail("Initial input accepted identity differs")
    if (!control) fail("Uncheckpointed Native run has no registered admission proof")
    const initial = ports.initialInputs?.get(control)
    if (initial) {
      const begin = initial.begin, inputID = initial.inputID, stageIdentity = initial.stageIdentity, outcome = begin.outcome
      const check = () => {
        if (ports.initialInputs?.get(control) !== initial || initial.identity !== task.identity || initial.control !== control
          || initial.stageIdentity !== stageIdentity || !stageIdentity || stageIdentity !== task.stageIdentity
          || initial.nativeEpoch !== row.notification.run_epoch || initial.inputID !== inputID || initial.begin !== begin
          || begin.turnId !== inputID || begin.outcome !== outcome) fail("Initial input association changed")
        ports.journal.assertCurrent(actual)
      }
      check()
      if (!inputID || actual.admission !== "accepted" || !actual.inboxID || actual.receipts[actual.inboxID] !== "accepted" || actual.receipts[inputID] !== "accepted") fail("Initial input has no exact accepted backend receipt")
      return check
    }
    const recovered = task.recovered, oldInput = recovered?.initialInput
    if (recovered && oldInput) {
      const inputID = oldInput.inputID, snapshot = closedRowSnapshot(oldInput.row)
      const check = () => {
        if (ports.recovered?.get(control) !== recovered || recovered.initialInput !== oldInput || oldInput.inputID !== inputID
          || JSON.stringify(oldInput.row) !== JSON.stringify(snapshot) || recovered.beforeEpoch !== row.notification.run_epoch
          || recovered.nativeEpoch !== row.notification.run_epoch || !recovered.result.ok) fail("Recovered initial admission association changed")
        ports.journal.assertCurrent(actual)
      }
      check()
      if (!inputID || snapshot.owner !== actual.owner || snapshot.key !== actual.key || snapshot.turn
        || JSON.stringify(snapshot.locator) !== JSON.stringify(actual.locator) || snapshot.revision > actual.revision
        || snapshot.admission !== "accepted" || snapshot.inboxID !== inputID || snapshot.receipts[inputID] !== "accepted"
        || actual.admission !== "accepted" || !actual.inboxID || actual.receipts[actual.inboxID] !== "accepted" || actual.receipts[inputID] !== "accepted") fail("Recovered initial input lacks original accepted ledger")
      return check
    }
    const failed = ports.failedStarts?.get(control)
    if (failed) {
      const result = failed.result, stageIdentity = failed.stageIdentity, snapshot = closedRowSnapshot(actual)
      const check = () => {
        if (ports.failedStarts?.get(control) !== failed || failed.identity !== task.identity || failed.control !== control
          || failed.stageIdentity !== stageIdentity || !stageIdentity || stageIdentity !== task.stageIdentity
          || failed.nativeEpoch !== row.notification.run_epoch || failed.beginInvoked !== false || failed.result !== result
          || result.kind !== "start_failed" || result.task_id !== task.id) fail("No-input failed-start association changed")
        ports.journal.assertCurrent(snapshot)
      }
      check()
      if (row.status !== "error" || actual.admission !== "none" || actual.inboxID !== undefined
        || Object.keys(actual.receipts).length !== 0 || actual.turn) fail("Failed start has an admitted or uncertain input")
      return check
    }
    fail("Uncheckpointed Native run has no registered admission proof")
  }
  function sourceCurrent(run: Run): TaskRecord {
    const row = custody(run.task)
    if (row.notification.run_epoch !== run.epoch || relationship(row) !== run.identity) fail("Notification source epoch or relationship changed")
    if (run.control) {
      checkControl(row, run.control)
      const closed = evidence().closed?.get(row.task_id)
      if (closed) {
        if (closed !== run.closed || closed.control !== run.control || !run.closedRow || closed.row.phase !== "closed"
          || closed.referenceRevision !== run.closedReferenceRevision || ownedRef(row).journalRevision !== run.closedReferenceRevision
          || run.closedRow.revision < ownedRef(row).journalRevision || (run.closedRow.turn ? run.closedRow.turn.nativeEpoch !== run.epoch : !run.admissionProof)
          || JSON.stringify(closed.row) !== JSON.stringify(run.closedRow)) fail("Closed notification source receipt/reference differs")
        evidence().journal.assertCurrent(run.closedRow)
      } else {
        if (evidence().controls?.get(row.task_id) !== run.control || !run.control.handle.assertOwned) fail("Live notification source unavailable")
        run.control.handle.assertOwned()
        run.control.backend.observationGuard(run.control.child)()
      }
      const revision = ownedRef(row).journalRevision
      if (revision < run.revision) fail("Notification source journal rolled back")
      run.revision = revision
    }
    run.admissionProof?.()
    return row
  }
  function notificationSourceCurrent(run: Run, source: CompletionDeliverySource): TaskRecord {
    const row = sourceCurrent(run)
    if (!evidence().sources?.has(source) || source.taskId !== row.task_id || source.runEpoch !== run.epoch
      || source.parentSessionId !== lease.sessionID || !shouldNotifyRecord(row)) fail("Unissued or ineligible completion source")
    return row
  }
  function chain(token: IssuedToolCall, captured?: Chain, rootBasis = false): Chain {
    current(token, rootBasis)
    const rows = lease === root ? [] : ownedAncestorPath(root.sessionID, evidence().store.list().records, lease.sessionID, true)
    const identities: string[] = [], controls: OwnedTaskControl[] = [], revisions: number[] = []
    for (const row of rows) {
      if (row.killed || row.status === "cancelled" || row.status === "lost" || row.cancel_requested) fail("Notification receiver is stopped")
      const control = evidence().controls?.get(row.task_id)
      if (!control || !control.handle.assertOwned) fail("Notification receiving ancestor control unavailable")
      checkControl(row, control); control.handle.assertOwned(); control.backend.observationGuard(control.child)()
      identities.push(receiverRelationship(row)); controls.push(control); revisions.push(ownedRef(row).journalRevision)
    }
    if (captured && (JSON.stringify(identities) !== JSON.stringify(captured.identities) || controls.some((control,index)=>control !== captured.controls[index])
      || controls.length !== captured.controls.length || revisions.some((revision,index)=>revision < captured.revisions[index]))) fail("Notification receiver chain changed")
    return { identities: Object.freeze(identities), controls: Object.freeze(controls), revisions: Object.freeze(revisions) }
  }
  function taskFrom(grant: ProvisionalNotificationGrant, id: string, identity: object, control?: OwnedTaskControl): AcceptedNotificationTask {
    const parent = provisionals.get(grant)
    if (!parent || parent.bound || !parent.spec?.deref()) fail("Unissued, consumed or expired notification provisional")
    current(parent.token)
    parent.chain = chain(parent.token, parent.chain)
    const ports = evidence(), actual = ports.accepted?.get(id), row = ports.store.load(id)
    if (!row || !actual || actual.identity !== identity || actual.control !== control || row.parent_session_id !== parent.parent
      || row.root_session_id !== parent.root || row.depth !== parent.depth) fail("Notification accepted task binding differs")
    if (!actual.birth || actual.birth.createdAt !== row.created_at || actual.birth.parentSessionId !== parent.parent
      || actual.birth.rootSessionId !== parent.root || actual.birth.depth !== parent.depth) fail("Captured notification acceptance birth differs")
    if (control) { checkControl(row, control); if (!control.handle.assertOwned) fail("Source control lacks private custody"); control.handle.assertOwned(); control.backend.observationGuard(control.child)() }
    else if (row.child_session_id || row.owned_session || actual.epoch !== row.notification.run_epoch || actual.claim !== row.residency_claim) fail("Queued notification acceptance differs")
    const task = Object.freeze({ [taskBrand]: true as const })
    tasks.set(task, { token: parent.token, id, birth: row.created_at, parent: parent.parent, root: parent.root, depth: parent.depth,
      identity, initialEpoch: row.notification.run_epoch, initialClaim: row.residency_claim, control,
      stageIdentity: control ? ports.staged?.get(control)?.stageIdentity : undefined, chain: parent.chain })
    parent.bound = true; parent.spec = undefined // Accepted lifetime never depends on original spec/GC.
    return task
  }
  return {
    assertAcceptedTaskCurrent(task: AcceptedNotificationTask, observed?: TaskRecord): TaskRecord {
      const captured = tasks.get(task)
      if (!captured) fail("Unissued notification task")
      const row = custody(captured)
      if (observed && relationship(observed) !== relationship(row)) fail("Observed notification task differs from actual custody")
      return row
    },
    bindRecovered(control: OwnedTaskControl): AcceptedNotificationTask {
      if (!rootToken) fail("Recovered notification root component basis unavailable")
      current(rootToken, true)
      const ports = evidence(), association = ports.recovered?.get(control), id = control.handle.task_id
      const accepted = ports.accepted?.get(id), row = ports.store.load(id)
      if (!association || association.control !== control || !association.result.ok || !accepted || accepted.identity !== association.identity
        || accepted.control !== control || ports.controls?.get(id) !== control || !row
        || row.notification.run_epoch !== association.nativeEpoch || row.residency_claim !== association.claim
        || accepted.epoch !== association.nativeEpoch || accepted.claim !== association.claim
        || row.created_at !== association.birth.createdAt || row.parent_session_id !== association.birth.parentSessionId
        || row.root_session_id !== association.birth.rootSessionId || row.depth !== association.birth.depth
        || row.parent_session_id !== lease.sessionID || row.root_session_id !== root.sessionID
        || accepted.birth.createdAt !== association.birth.createdAt || accepted.birth.parentSessionId !== association.birth.parentSessionId
        || accepted.birth.rootSessionId !== association.birth.rootSessionId || accepted.birth.depth !== association.birth.depth) fail("Actual recovered notification custody unavailable")
      checkControl(row, control)
      if (!control.handle.assertOwned) fail("Recovered control lacks private custody")
      control.handle.assertOwned(); control.backend.observationGuard(control.child)()
      const task = Object.freeze({ [taskBrand]: true as const })
      tasks.set(task, { token: rootToken, rootBasis: true, id, birth: row.created_at, parent: row.parent_session_id, root: row.root_session_id,
        depth: row.depth, identity: association.identity, initialEpoch: row.notification.run_epoch, initialClaim: row.residency_claim,
        control, recovered: association, recoveryFingerprint: recoveryFingerprint(association), recoveryResult: association.result,
        chain: chain(rootToken, undefined, true) })
      return task
    },
    provision(token: IssuedToolCall, spec: ManagerStartSpec): ProvisionalNotificationGrant {
      if (!issuing) fail("Notification grant issuance stopped")
      callAuthority.assertCall(token); current(token)
      if (callAuthority.parent(token) !== lease || token.sessionID !== lease.sessionID) fail("Foreign notification caller lease")
      bindings.info(receiver, true)
      if (spec.parent_session_id !== lease.sessionID || (spec.root_session_id ?? spec.parent_session_id) !== root.sessionID || spec.depth !== receiverInfo.depth + 1) fail("Notification original spec ancestry differs")
      const grant = Object.freeze({ [provisionalBrand]: true as const })
      provisionals.set(grant, { token, spec: new WeakRef(spec), parent: spec.parent_session_id, root: spec.root_session_id ?? spec.parent_session_id, depth: spec.depth, bound: false, chain: chain(token) })
      return grant
    },
    bindStaged(grant: ProvisionalNotificationGrant, managed: ManagedStartSpec, control: OwnedTaskControl): AcceptedNotificationTask {
      const parent = provisionals.get(grant), association = evidence().staged?.get(control)
      if (!parent || !association || association.original.deref() !== parent.spec?.deref() || !association.original.deref()
        || association.managed.deref() !== managed || !managed.admission?.hostAuthority || association.hostAuthority !== managed.admission.hostAuthority
        || managed.taskId !== control.handle.task_id || managed.parentSessionId !== parent.parent || managed.rootSessionId !== parent.root || managed.depth !== parent.depth) fail("Original staged notification association unavailable")
      return taskFrom(grant, control.handle.task_id, association.identity, control)
    },
    bindAcceptedWithoutChild(grant: ProvisionalNotificationGrant, result: StartResult): AcceptedNotificationTask {
      const parent = provisionals.get(grant), spec = parent?.spec?.deref(), association = spec && evidence().returned?.get(spec)
      if (!parent || !association || association.result !== result || !("task_id" in result) || !result.task_id
        || result.kind !== "started" && result.kind !== "start_failed") fail("Original returned notification acceptance unavailable")
      return taskFrom(grant, result.task_id, association.identity)
    },
    bindCurrentOwnedRun(task: AcceptedNotificationTask): Promise<NotificationRunBinding> {
      const captured = tasks.get(task)
      if (!captured) return Promise.reject(new NotificationAuthorityError("Unissued notification task"))
      const work = Promise.resolve().then(async () => {
        const row = custody(captured), identity = relationship(row), epoch = row.notification.run_epoch
        const control = captured.control
        let closed: NotificationClosedSource | undefined
        let closedRow: ChildRecord | undefined
        let closedReferenceRevision: number | undefined
        let admissionProof: (() => void) | undefined
        if (control) {
          checkControl(row, control)
          closed = evidence().closed?.get(row.task_id)
          if (closed) {
            closedReferenceRevision = closed.referenceRevision
            closedRow = closedRowSnapshot(closed.row) // Copy BEFORE the first await, not after it.
            if (closed.control !== control || !Number.isSafeInteger(closed.referenceRevision)
              || closed.referenceRevision !== ownedRef(row).journalRevision) fail("Closed source control/reference differs")
            await control.backend.confirmClosed(control.child)
            const fresh = custody(captured)
            if (relationship(fresh) !== identity || evidence().closed?.get(row.task_id) !== closed
              || ownedRef(fresh).journalRevision !== closedReferenceRevision || closed.referenceRevision !== closedReferenceRevision
              || JSON.stringify(closed.row) !== JSON.stringify(closedRow)) fail("Closed source changed during confirmation")
          } else { if (!control.handle.assertOwned) fail("Source custody guard unavailable"); control.handle.assertOwned(); control.backend.observationGuard(control.child)() }
          const actual = await evidence().journal.read(ownedRef(row).journalKey)
          const fresh = custody(captured)
          if (relationship(fresh) !== identity || !actual || actual.owner !== evidence().journal.owner || actual.key !== ownedRef(row).journalKey
            || actual.locator.sessionID !== row.child_session_id || actual.locator.parentID !== row.parent_session_id
            || actual.locator.backendID !== control.child.locator.backendID || actual.locator.location !== control.child.locator.location
            || actual.locator.hostVersion !== hostVersion || actual.locator.generation !== control.child.locator.generation
            || actual.revision < ownedRef(fresh).journalRevision) fail("Native notification turn/journal proof differs")
          evidence().journal.assertCurrent(actual)
          if (actual.turn) { if (actual.turn.nativeEpoch !== epoch) fail("Native notification turn epoch differs") }
          else admissionProof = uncheckpointedProof(captured, fresh, actual)
          if (closed && (actual.phase !== "closed" || evidence().closed?.get(row.task_id) !== closed
            || ownedRef(fresh).journalRevision !== closedReferenceRevision || closed.referenceRevision !== closedReferenceRevision
            || JSON.stringify(actual) !== JSON.stringify(closedRow) || JSON.stringify(closed.row) !== JSON.stringify(closedRow))) fail("Closed source receipt/reference changed during journal read")
        }
        const binding = Object.freeze({ [runBrand]: true as const })
        const run: Run = { task: captured, epoch, identity, revision: row.owned_session?.journalRevision ?? 0, control, closed, closedRow, closedReferenceRevision, admissionProof }
        runs.set(binding, run)
        sourceCurrent(run)
        return binding
      })
      pending.add(work); void work.finally(()=>pending.delete(work)).catch(()=>{})
      return work
    },
    validateForDispatch(binding: NotificationRunBinding, source: CompletionDeliverySource): Promise<NotificationDispatchPermit> {
      const run = runs.get(binding)
      if (!run) return Promise.reject(new NotificationAuthorityError("Unissued notification run"))
      const work = Promise.resolve().then(async () => {
        const ports = evidence()
        notificationSourceCurrent(run, source)
        let snapshot = chain(run.task.token, undefined, run.task.rootBasis)
        const rows = lease === root ? [] : ownedAncestorPath(root.sessionID, ports.store.list().records, lease.sessionID, true)
        const targets = [{ id: lease.sessionID, parent: rows[0]?.parent_session_id, directory }, ...rows.map((ancestor,index)=>({ id: ancestor.parent_session_id, parent: rows[index+1]?.parent_session_id, directory: rows[index+1]?.owned_session?.location ?? rootDirectory }))]
        for (const target of targets) {
          let actual: Awaited<ReturnType<SessionBackendApi["get"]>>
          const signal = AbortSignal.any([stop.signal, root.signal, lease.signal, run.task.token.lifetimeSignal])
          try { actual = await session.get({ sessionID: target.id }, { signal }) }
          catch (error) { if (!(signal.aborted && Object.is(error, signal.reason))) queryErrors.push(error); throw error }
          notificationSourceCurrent(run, source); snapshot = chain(run.task.token, snapshot, run.task.rootBasis)
          if (actual.id !== target.id || actual.location.directory !== target.directory || (target.parent ? actual.parentID !== target.parent : !!actual.parentID)) fail("Actual notification receiver identity differs")
        }
        const permit = Object.freeze({ [permitBrand]: true as const })
        permits.set(permit, { run, source, chain: snapshot })
        return permit
      })
      pending.add(work); void work.finally(()=>pending.delete(work)).catch(()=>{})
      return work
    },
    assertDispatchCurrent(permit: NotificationDispatchPermit): void {
      const value = permits.get(permit)
      if (!value) fail("Unissued notification dispatch permit")
      notificationSourceCurrent(value.run, value.source)
      chain(value.run.task.token, value.chain, value.run.task.rootBasis)
    },
    stopIssuing() { issuing = false },
    quiesce() { issuing = false; if (state === "open") { state = "quiescing"; stop.abort(new NotificationAuthorityError("Notification receiver quiescing")) } },
    retire(): Promise<void> {
      if (state === "retired") return Promise.resolve()
      if (retirement) return retirement
      issuing = false; state = "quiescing"; stop.abort(new NotificationAuthorityError("Notification receiver retiring"))
      const work = (async () => {
        while (pending.size) await Promise.allSettled([...pending])
        if (queryErrors.length > reportedErrors) { const errors = queryErrors.slice(reportedErrors); reportedErrors = queryErrors.length; throw new AggregateError(errors, "Joined notification query failures") }
        state = "retired"
      })()
      retirement = work
      void work.catch(()=>{if(retirement===work)retirement=undefined})
      return work
    },
    diagnostics() { return Object.freeze({ state, pending: pending.size, queryFailures: queryErrors.length }) },
  }
}
