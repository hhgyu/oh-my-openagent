import { AsyncLocalStorage } from "node:async_hooks"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { getPidLiveness } from "@oh-my-opencode/memory-core/process-identity"
import { OmoTaskSettingsSchema, type OmoConfig } from "@oh-my-opencode/omo-config-core"
import type { AgentDefinition, StartResult } from "@oh-my-opencode/senpi-task"
import { createTaskManagerImplementation, createTaskRecordStore, createTaskLifecycle, AdmissionBarrier, NO_HOST_ENDPOINT, ChildObservationUncertain,
  type ReattachingTaskManager, type TaskLifecycle, type TaskRecoveryRuntime, type ManagerStartSpec, type ManagedStartSpec, type TaskRecord, type ResidencyRegistry, type ChildCreationPort, type HostStartAuthority } from "@oh-my-opencode/senpi-task/manager-kernel"
import { createTaskTerminalObservers, type CompletionDeliverySource } from "@oh-my-opencode/senpi-task/task-operations"
import { createModelCatalog } from "../../host/model-catalog"
import { openChildJournal } from "../../host/child-journal"
import { openCompletionIntentJournal } from "../../host/completion-intent-journal"
import { openReleasedControlJournal, type ReleasedControlReceipt } from "../../host/released-control-journal"
import { openOwnedChildObservationStore } from "../../host/owned-child-observation-store"
import type { SessionLease, SessionScopes, SessionToolPolicy } from "../../host/session-state"
import type { OwnedToolMetadataSource } from "../../host/effect-tool-metadata-source"
import type { IssuedToolCall, ToolCallAuthority } from "../../host/tool-kernel"
import { hasJoinedSessionCancellation } from "../../host/session-cancellation"
import type { ChildRecord, ChildHandle } from "../../host/session-backend"
import type { OwnedChildToolGuard, ChildGuardApproval, ChildGuardBinding } from "../../host/owned-child-tool-guard"
import { createOwnedTaskPlanner } from "./planner"
import { createOwnedManagedRunner, type OwnedTaskHost } from "./owned-runner"
import { createFreshRecoveryApprovals, type RecoveryAuthorization } from "./parked-recovery"
import { createOwnedTaskRecovery, assertRecoverableOwnedRecord, assertOwnedTreeRecord } from "./owned-recovery"
import { createOwnedTaskLifecyclePort } from "./owned-lifecycle"
import type { OwnedTaskControl } from "./owned-handle"
import { readOwnedTaskOutput } from "./task-output"
import { createOwnedAncestry, ownedAncestorPath } from "./ancestry"
import { createParentBindings, type VerifiedParentBinding } from "./parent-binding"
import { createAcceptedOperationRegistry, createAcceptedOperationLifetime } from "./accepted-operation"
import { createNativeOperationPorts, type AcceptedTaskProof, type NativeOperationResolution } from "./operation-ports"
import type { createHostBuildAuthorizer } from "./host-grant"
import type { NativeChildGuardOrigin } from "./child-guard-binding"
import { createOwnedCompletionStore, type OpenStartCreationScope, type ParentCompletionChannel, type TaskBirth } from "./completion-store"
import { createParentNotificationOwner, type ParentNotificationOwner } from "./parent-notification-owner"
import { createParentNotificationAuthorityIssuer, type AcceptedNotificationTask, type ProvisionalNotificationGrant,
  type NotificationAcceptedCustody, type NotificationStagedAssociation, type NotificationReturnedAssociation,
  type NotificationClosedSource, type NotificationInitialInputAssociation, type NotificationFailedStartAssociation,
  type NotificationRecoveredAssociation } from "./parent-notification-authority"

interface NotificationStartOrigin {
  readonly identity: object
  readonly original: WeakRef<ManagerStartSpec>
  readonly binding: VerifiedParentBinding
  readonly births: Map<string, Readonly<TaskBirth>>
  readonly creation: OpenStartCreationScope
  closeCreation(): void
  authority?: HostStartAuthority
  provisional?: ProvisionalNotificationGrant
  task?: AcceptedNotificationTask
  installed?: { readonly identity: object; readonly control: OwnedTaskControl; readonly epoch: number; beginInvoked: boolean }
}
interface NotificationStage {
  readonly identity: object
  readonly origin: NotificationStartOrigin
  readonly managed: ManagedStartSpec
  readonly epoch: number
  open: boolean
  verified: boolean
  beginInvoked: boolean
  control?: OwnedTaskControl
}
interface NotificationRecoveryOrigin {
  readonly identity: object
  readonly taskId: string
  readonly birth: NotificationAcceptedCustody["birth"]
  readonly beforeEpoch: number
  readonly journalKey: string
}
interface NotificationRecoveryScope extends NotificationRecoveryOrigin {
  readonly managed: ManagedStartSpec
  open: boolean
  verified: boolean
  control?: OwnedTaskControl
}

/** Native's continuation for a child whose turn a host process restart cut off
 * (`senpi-task` `runners/rpc-host/reconcile-turn.ts` `HOST_RESPAWN_CONTINUATION`, which the package
 * does not export), delivered by `manager-respawn.ts` `continueInterruptedTurn`. */
const HOST_RESTART_CONTINUATION =
  "Your previous turn was interrupted by a host process restart. Resume your task from its current state and finish it - do not restart from scratch, and do not repeat work already recorded in this session."

export interface NativeTaskNotificationBasis {
  readonly callAuthority: ToolCallAuthority
  readonly rootToken: IssuedToolCall
  captureCall(): IssuedToolCall
}
export interface NativeOwnedTaskRuntimeOptions {
  stateDir: string; scopes: SessionScopes; parent: SessionLease; policy: SessionToolPolicy;
  metadataSource: OwnedToolMetadataSource; config(): OmoConfig | Promise<OmoConfig>;
  agents: Readonly<Record<string, AgentDefinition>>;
  captureStartAuthority(spec?: ManagerStartSpec): HostStartAuthority;
  readonly notification?: NativeTaskNotificationBasis;
  readonly authorizePlannedStart?: (spec: ManagerStartSpec, plan: Parameters<ReturnType<ReturnType<typeof createHostBuildAuthorizer>["forCall"]>["authorize"]>[0]["plan"]) => ReturnType<ReturnType<ReturnType<typeof createHostBuildAuthorizer>["forCall"]>["authorize"]>;
  /** Trusted unregistered component injection. Both ports are required together;
   * bindings must come from original approved live producers, never catalog DATA. */
  readonly childToolGuard?: OwnedChildToolGuard
  readonly childGuardBinding?: (spec: ManagedStartSpec, prepared: Awaited<ReturnType<NonNullable<NativeOwnedTaskRuntimeOptions["authorizePlannedStart"]>>>,
    /** Original task store appender and approved or recovered team identity. */
    origin?: NativeChildGuardOrigin) => {
    readonly coverage?: ChildGuardBinding["coverage"]
    assertCurrent(): void
    bind(child: ChildHandle, assertBackendCurrent: () => void): ChildGuardBinding
  }
  initializationSignal?: AbortSignal;
  /** Aborted once OpenCode closes this plugin's location: a shutdown park's idle barrier is then met. */
  readonly locationReleased?: AbortSignal
  /** Genuine CURRENT-call G2 approval over a rebuilt persisted spec (service-owned). Required for
   * any guarded recovery; without a current call it must throw, so autonomous recovery refuses. */
  readonly authorizeRecovery?: (spec: ManagedStartSpec) => Promise<RecoveryAuthorization>
}
type ApprovedTeam = { readonly runId: string; readonly memberName: string }
const failedInitialization = new WeakMap<object, () => Promise<void>>()
/** Retained unpublished factory resources remain owned and retryable. */
export function retainedNativeTaskInitializationCleanup(error: unknown): (() => Promise<void>) | undefined {
  return typeof error === "object" && error !== null ? failedInitialization.get(error) : undefined
}

/** Internal SAME manager composition; no constructor ToolContext or public task namespace. */
export async function createNativeOwnedTaskRuntime(ctx: OwnedTaskHost, options: NativeOwnedTaskRuntimeOptions) {
  const acceptedOperations = createAcceptedOperationRegistry()
  const startAuthorities = new WeakMap<ManagerStartSpec, HostStartAuthority>()
  type Admission = NonNullable<ManagerStartSpec["admission"]>
  type Planned = Awaited<ReturnType<NonNullable<NativeOwnedTaskRuntimeOptions["authorizePlannedStart"]>>>
  const plannedGrants = new WeakMap<Admission, { authority: HostStartAuthority; parent: VerifiedParentBinding; prepared: Planned; spec: ManagerStartSpec; plan: Parameters<NonNullable<NativeOwnedTaskRuntimeOptions["authorizePlannedStart"]>>[1]; policyBasis: string; footprint: string; kernelTools: ManagerStartSpec["kernelTools"]; members: ManagerStartSpec["memberScopedTools"]; team?: ApprovedTeam; guardApproval?: ChildGuardApproval; assertLifetime(): void }>()
  const grantFootprint = (value: { parent: string; root: string; depth: number; instructions?: string; agentType?: string; allow?: readonly string[]; deny?: readonly string[]; includeTaskTools: boolean }) => JSON.stringify(value)
  const acceptedStarts = new Map<string, { authority: HostStartAuthority; epoch: number }>()
  const closedControls = new Map<string, { identity: string; revision: number } & NotificationClosedSource>()
  // Custody receipts for children THIS runtime released itself (detached to persisted_only, or a
  // retained session it closed): the exact identity and journal revision at release. A later read
  // proves the stored row is still that same released child, never a foreign or changed one. Each
  // receipt is also journaled durably, so a reloaded runtime over the same state keeps the proof.
  const releasedControls = new Map<string, ReleasedControlReceipt>()
  // Set while this runtime parks its own children for a reload/dispose, so their receipts say so.
  const suspendingForShutdown = new AsyncLocalStorage<true>()
  if (ctx.app.version !== "2.2.6" || !hasJoinedSessionCancellation(ctx.session)) throw new Error("Native task binding requires pinned joined Effect host")
  if (typeof options.captureStartAuthority !== "function") throw new Error("Native task runtime requires a start authority producer")
  if (options.childToolGuard && (!options.authorizePlannedStart || !options.childGuardBinding) || options.childGuardBinding && !options.childToolGuard) throw Error("Child tool guard requires original planned authorization and live binding producer")
  const parentID = options.parent.sessionID
  options.scopes.assert(options.parent); options.initializationSignal?.throwIfAborted()
  options.notification?.callAuthority.assert(options.notification.rootToken, options.parent)
  mkdirSync(options.stateDir, { recursive: true })
  const planner = createOwnedTaskPlanner({ catalog: createModelCatalog(ctx), config: options.config, agents: options.agents })
  await planner.prepare()
  options.scopes.assert(options.parent); options.initializationSignal?.throwIfAborted()
  const config = OmoTaskSettingsSchema.parse(planner.config().task ?? {})
  // These fields are consumed by Native #startResolved, not carried on
  // ManagedStartSpec. Preserve/recheck their ORIGINAL basis, not invented DTOs.
  const nativePolicyBasis = (spec: ManagerStartSpec, plan: Parameters<NonNullable<NativeOwnedTaskRuntimeOptions["authorizePlannedStart"]>>[1]) => JSON.stringify({
    allowedSubagents: spec.allowed_subagents, agentSubagents: plan.allowedSubagents,
    maxDepth: plan.maxDepth ?? config.max_depth, specMode: spec.execution_mode,
    agentMode: plan.agentExecutionMode, configMode: config.default_execution_mode,
  })
  const initializers: { close(): Promise<void> | void; done: boolean }[] = []
  async function closeInitialization() {
    const errors: unknown[] = []
    for (const item of [...initializers].reverse()) if (!item.done) {
      try { await item.close(); item.done = true } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, "Native task initialization cleanup incomplete")
  }
  const baseStore = createTaskRecordStore({ project_dir: ctx.location.directory, task: { state_dir: options.stateDir } })
  initializers.push({ close: () => baseStore.close(), done: false })
  try {
  const journal = await openChildJournal({ path: join(options.stateDir, "owned-children.sqlite") })
  initializers.push({ close: () => journal.close(), done: false })
  const observationStore = openOwnedChildObservationStore({ path: join(options.stateDir, "owned-observations.sqlite") })
  initializers.push({ close: () => observationStore.close(), done: false })
  const completionJournal = options.notification ? await openCompletionIntentJournal({
    path: join(options.stateDir, "owned-completions.sqlite"),
    namespace: "opencode2:" + createHash("sha256").update(JSON.stringify([ctx.location.directory, parentID, ctx.app.version])).digest("hex"),
  }) : undefined
  if (completionJournal) initializers.push({ close: () => completionJournal.close(), done: false })
  const releaseJournal = openReleasedControlJournal({ path: join(options.stateDir, "owned-releases.sqlite"),
    namespace: "opencode2-released:" + createHash("sha256").update(JSON.stringify([ctx.location.directory, parentID])).digest("hex") })
  initializers.push({ close: () => releaseJournal.close(), done: false })
  /** This runtime's own release receipt for a task: in memory, else the durable one of a previous runtime. */
  function releaseReceipt(id: string): ReleasedControlReceipt | undefined { return releasedControls.get(id) ?? releaseJournal.read(id) }
  function forgetRelease(id: string): void { releasedControls.delete(id); releaseJournal.forget(id) }
  options.scopes.assert(options.parent); options.initializationSignal?.throwIfAborted()
  const barrier = new AdmissionBarrier(), controls = new Map<string, OwnedTaskControl>()
  let manager!: ReattachingTaskManager, lifecycle!: TaskLifecycle, closing = false
  const parentContext = new AsyncLocalStorage<VerifiedParentBinding>()
  const bindings = createParentBindings(options.parent, options.scopes.assert(options.parent).policy, () => options.scopes.assert(options.parent))
  const notificationOrigins = new AsyncLocalStorage<NotificationStartOrigin>()
  const notificationStages = new AsyncLocalStorage<NotificationStage>()
  const notificationRecoveries = new AsyncLocalStorage<NotificationRecoveryScope>()
  const notificationRecoveryRequests = new AsyncLocalStorage<NotificationRecoveryOrigin>()
  const pendingNotificationReattachments = new WeakMap<OwnedTaskControl["handle"], {
    readonly origin: NotificationRecoveryOrigin; readonly control: OwnedTaskControl; readonly claimed: ChildRecord
  }>()
  const notificationBindingFailures: unknown[] = []
  const notificationOriginsByAuthority = new WeakMap<HostStartAuthority, NotificationStartOrigin>()
  const notificationAccepted = new Map<string, NotificationAcceptedCustody>()
  const notificationTasks = new Map<string, { binding: VerifiedParentBinding; task: AcceptedNotificationTask }>()
  const notificationStaged = new WeakMap<OwnedTaskControl, NotificationStagedAssociation>()
  const notificationReturned = new WeakMap<ManagerStartSpec, NotificationReturnedAssociation>()
  const notificationInitialInputs = new WeakMap<OwnedTaskControl, NotificationInitialInputAssociation>()
  const notificationFailedStarts = new WeakMap<OwnedTaskControl, NotificationFailedStartAssociation>()
  const notificationRecovered = new WeakMap<OwnedTaskControl, NotificationRecoveredAssociation>()
  const notificationSources = new WeakSet<CompletionDeliverySource>()
  const notificationChannels = new Map<VerifiedParentBinding, ParentCompletionChannel>()
  const notificationOwners = new Map<VerifiedParentBinding, {
    owner: ParentNotificationOwner; issuer: ReturnType<typeof createParentNotificationAuthorityIssuer>;
    readonly stopSignal: AbortSignal; ready: boolean; failed: boolean; initializing?: Promise<void>
  }>()
  const terminalObservers = createTaskTerminalObservers()
  const store = options.notification ? createOwnedCompletionStore({ baseStore, bindings, channels: notificationChannels,
    wasBackground: taskId => manager.wasBackground(taskId), currentGeneration: () => undefined, terminalObservers,
    creationScope: () => notificationOrigins.getStore()?.creation,
  }).store : baseStore
  const accepted = new Map<string, import("@oh-my-opencode/senpi-task/manager-kernel").TaskRecord>()
  const currentParent = () => parentContext.getStore() ?? bindings.root
  function notificationOwner(binding: VerifiedParentBinding) {
    const entry = notificationOwners.get(binding)
    if (!entry?.ready) throw Error("Original parent completion owner is unavailable")
    return entry
  }
  function ownsNotificationTerminal(record: TaskRecord, binding: VerifiedParentBinding) {
    const owner = notificationOwners.get(binding)
    if (closing || !owner?.ready || owner.stopSignal.aborted || options.notification?.rootToken.lifetimeSignal.aborted) return false
    const task = notificationTasks.get(record.task_id), custody = notificationAccepted.get(record.task_id)
    if (!task || task.binding !== binding || !custody) return false
    const birth = custody.birth
    if (record.created_at !== birth.createdAt || record.parent_session_id !== birth.parentSessionId
      || record.root_session_id !== birth.rootSessionId || record.depth !== birth.depth) return false
    if (custody.control) {
      if ((controls.get(record.task_id) ?? closedControls.get(record.task_id)?.control) !== custody.control) return false
    } else if (record.child_session_id || record.owned_session || record.notification.run_epoch !== custody.epoch
      || record.residency_claim !== custody.claim) return false
    const receivers = ownedAncestorPath(parentID, baseStore.list().records, record.parent_session_id, true)
    if (receivers.some(parent => parent.killed || parent.status === "cancelled" || parent.status === "lost" || parent.cancel_requested)) return false
    owner.issuer.assertAcceptedTaskCurrent(task.task, record)
    return true
  }
  async function ensureNotificationOwner(binding: VerifiedParentBinding): Promise<ParentNotificationOwner | undefined> {
    const basis = options.notification
    if (!basis || !completionJournal || closing) return undefined
    let existing = notificationOwners.get(binding)
    if (existing?.failed) {
      await existing.owner.close()
      if (notificationOwners.get(binding) === existing) { notificationChannels.delete(binding); notificationOwners.delete(binding) }
      existing = undefined
    }
    if (!existing) {
      basis.callAuthority.assert(basis.rootToken, options.parent)
      const parent = bindings.info(binding)
      const control = binding === bindings.root ? undefined : [...controls.values()].find(value => value.child.lease === parent.lease)
      if (binding !== bindings.root && !control) throw Error("Nested completion receiver has no exact actual control")
      control?.backend.observationGuard(control.child)()
      const directory = control?.child.locator.location ?? ctx.location.directory
      const issuer = createParentNotificationAuthorityIssuer({
        callAuthority: basis.callAuthority, rootToken: basis.rootToken, scopes: options.scopes,
        bindings, receiver: binding, root: options.parent, registryGeneration: basis.rootToken.registryGeneration,
        directory, rootDirectory: ctx.location.directory, hostVersion: ctx.app.version, session: ctx.session,
        readers: { store: baseStore, journal, controls, accepted: notificationAccepted, staged: notificationStaged,
          returned: notificationReturned, closed: closedControls, sources: notificationSources,
          initialInputs: notificationInitialInputs, failedStarts: notificationFailedStarts, recovered: notificationRecovered },
      })
      const owner = createParentNotificationOwner({ ctx, baseStore, stateDir: options.stateDir, bindings, binding, issuer, journal: completionJournal,
        receiver: Object.freeze({ backendID: "opencode2", directory, hostVersion: ctx.app.version,
          sessionID: parent.lease.sessionID, rootSessionID: parent.rootSessionId,
          leaseGeneration: parent.lease.generation, registryGeneration: basis.rootToken.registryGeneration }),
        taskFor: record => { const current = notificationTasks.get(record.task_id); return current?.binding === binding ? current.task : undefined },
        ownsTerminal: record => ownsNotificationTerminal(record, binding), wasBackground: taskId => manager.wasBackground(taskId),
        registerSource: source => { notificationSources.add(source) },
      })
      existing = { owner, issuer, stopSignal: parent.stop.signal, ready: false, failed: false }
      notificationOwners.set(binding, existing)
      notificationChannels.set(binding, owner.channel)
    }
    const entry = existing
    if (!entry.ready && !entry.initializing) {
      const pending = entry.owner.initialize().then(() => { entry.ready = true }, error => { entry.failed = true; throw error })
      entry.initializing = pending
      void pending.finally(() => { if (entry.initializing === pending) entry.initializing = undefined }).catch(() => {})
    }
    if (entry.initializing) await entry.initializing
    return entry.owner
  }
  async function closeNotificationOwner(binding: VerifiedParentBinding) {
    const entry = notificationOwners.get(binding)
    if (!entry) return
    entry.owner.stop()
    await entry.owner.close()
    if (notificationOwners.get(binding) === entry) { notificationChannels.delete(binding); notificationOwners.delete(binding) }
  }
  async function closeNotificationOwners() {
    for (const entry of notificationOwners.values()) entry.owner.stop()
    const settled = await Promise.allSettled([...notificationOwners.keys()].map(closeNotificationOwner))
    const failures = settled.flatMap(result => result.status === "rejected" ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, "Original completion owners retain cleanup")
  }
  initializers.push({ close: closeNotificationOwners, done: false })
  const ancestry = createOwnedAncestry({ root: options.parent, directory: ctx.location.directory, hostVersion: ctx.app.version, records: () => store.list().records,
    get: (sessionID, signal) => ctx.session.get({ sessionID }, { signal }), assertRoot: () => options.scopes.assert(options.parent),
    assertControl(record) { const control = controls.get(record.task_id); if (!control || !control.handle.assertOwned || control.child.locator.sessionID !== record.child_session_id) throw Error("Owned ancestor control unavailable"); control.handle.assertOwned() },
  })
  function acceptedBirth(origin: NotificationStartOrigin, record: TaskRecord): NotificationAcceptedCustody["birth"] {
    const birth = origin.births.get(record.task_id)
    if (!birth || birth.createdAt !== record.created_at || birth.parentSessionId !== record.parent_session_id
      || birth.rootSessionId !== record.root_session_id || birth.depth !== record.depth) throw Error("Actual start has no matching original creation witness")
    return Object.freeze({ createdAt: birth.createdAt, parentSessionId: birth.parentSessionId, rootSessionId: birth.rootSessionId, depth: birth.depth })
  }
  function acceptNotificationStage(stage: NotificationStage, control: OwnedTaskControl, record: TaskRecord) {
    const origin = stage.origin
    if (!stage.open || !stage.verified || stage.control || stage.managed.taskId !== record.task_id
      || stage.managed.taskId !== control.handle.task_id || !origin.authority || !origin.provisional
      || stage.managed.admission?.hostAuthority !== origin.authority
      || record.notification.run_epoch !== stage.epoch) throw Error("Actual installed stage differs from its original admitted request")
    const prior = notificationAccepted.get(record.task_id)
    if (prior && (prior.identity !== origin.identity || prior.control && prior.control !== control)) throw Error("Accepted notification control was replaced without a new binding")
    const birth = acceptedBirth(origin, record)
    const association: NotificationStagedAssociation = Object.freeze({ original: origin.original, managed: new WeakRef(stage.managed),
      hostAuthority: origin.authority, identity: origin.identity, stageIdentity: stage.identity })
    notificationStaged.set(control, association)
    notificationAccepted.set(record.task_id, Object.freeze({ identity: origin.identity, birth, epoch: stage.epoch, claim: record.residency_claim, control }))
    const entry = notificationOwner(origin.binding)
    const task = origin.task ?? entry.issuer.bindStaged(origin.provisional, stage.managed, control)
    entry.issuer.assertAcceptedTaskCurrent(task, record)
    stage.control = control
    origin.installed = { identity: stage.identity, control, epoch: stage.epoch, beginInvoked: false }
    origin.task = task
    notificationTasks.set(record.task_id, { binding: origin.binding, task })
    entry.owner.requestReconcile()
  }
  function registerInstalledNotification(control: OwnedTaskControl, record: TaskRecord) {
    if (!options.notification) return
    const stage = notificationStages.getStore()
    if (stage) { acceptNotificationStage(stage, control, record); return }
    const recovery = notificationRecoveries.getStore()
    if (!recovery?.open || !recovery.verified || recovery.control || recovery.managed.taskId !== control.handle.task_id
      || recovery.taskId !== record.task_id || recovery.birth.createdAt !== record.created_at
      || recovery.birth.parentSessionId !== record.parent_session_id || recovery.birth.rootSessionId !== record.root_session_id
      || recovery.birth.depth !== record.depth) throw Error("Installed recovery has no original actual recovery scope")
    recovery.control = control
  }
  function remember(record: import("@oh-my-opencode/senpi-task/manager-kernel").TaskRecord) {
    const prior = accepted.get(record.task_id)
    if (prior && (prior.parent_session_id !== record.parent_session_id || prior.root_session_id !== record.root_session_id || prior.depth !== record.depth || prior.child_session_id && record.child_session_id !== prior.child_session_id)) throw Error("Owned tree membership changed")
    // Relationship evidence must not alias a caller's mutable manager.get result.
    accepted.set(record.task_id, { ...record, notification: { ...record.notification }, owned_session: record.owned_session && { ...record.owned_session } })
  }
  function owns(record: import("@oh-my-opencode/senpi-task/manager-kernel").TaskRecord): boolean {
    try {
      const indexed = accepted.get(record.task_id)
      if (!indexed || indexed.parent_session_id !== record.parent_session_id || indexed.root_session_id !== record.root_session_id || indexed.depth !== record.depth || indexed.child_session_id && indexed.child_session_id !== record.child_session_id) return false
      const parents = ownedAncestorPath(parentID, [...accepted.values()], record.parent_session_id, true)
      return record.root_session_id === parentID && record.depth === (parents[0]?.depth ?? 0) + 1
    } catch { return false }
  }
  async function verifyParent(sessionID: string, signal?: AbortSignal): Promise<VerifiedParentBinding> {
    const verified = await ancestry.verify(sessionID, signal)
    if (sessionID === parentID) { await ensureNotificationOwner(bindings.root); return bindings.root }
    const record = verified.rows[0], control = controls.get(record.task_id)
    if (!control || manager.findTaskByChildSession?.(sessionID)?.task_id !== record.task_id) throw Error("Caller is not this manager's running live child")
    const binding = bindings.adopt(control.backend.borrowParent(control.child), verified.depth, () => { control.handle.assertOwned?.(); if (controls.get(record.task_id) !== control) throw Error("Owned parent control replaced") }, verified.assertCurrent)
    await ensureNotificationOwner(binding)
    return binding
  }
  const recovering = new Map<string, Promise<void>>()
  /** Tasks a host restart left behind that `restoreAfterReload` is recovering right now: their
   * reattach continues the turn the restart cut off (Native `continueInterruptedTurn`). */
  const restartRecoveries = new Set<string>()
  async function recoveryParent(record: import("@oh-my-opencode/senpi-task/manager-kernel").TaskRecord) {
    const rows = ancestry.path(record.parent_session_id)
    for (const ancestor of [...rows].reverse()) if (!controls.has(ancestor.task_id)) await recoverControl(ancestor)
    if (record.parent_session_id === parentID) { await ensureNotificationOwner(bindings.root); return bindings.info(bindings.root) }
    const verified = await ancestry.verify(record.parent_session_id)
    const ancestor = verified.rows[0], control = controls.get(ancestor.task_id)
    if (!control) throw Error("Recovery parent control unavailable")
    const binding = bindings.adopt(control.backend.borrowParent(control.child), ancestor.depth, () => { control.handle.assertOwned?.(); if (controls.get(ancestor.task_id) !== control) throw Error("Recovery parent replaced") }, verified.assertCurrent)
    await ensureNotificationOwner(binding)
    return bindings.info(binding)
  }
  async function cleanupParent(record: import("@oh-my-opencode/senpi-task/manager-kernel").TaskRecord) {
    if (record.parent_session_id === parentID) return bindings.info(bindings.root)
    const indexed = [...accepted.values()].filter(row => row.child_session_id === record.parent_session_id)
    if (indexed.length !== 1) return recoveryParent(record)
    const parentRecord = indexed[0], control = controls.get(parentRecord.task_id)
    if (!control || control.child.locator.sessionID !== record.parent_session_id) return recoveryParent(record)
    // Retained cleanup custody is not NEW borrowing/admission. Cancellation may already have
    // changed the Native parent's status, while its exact backend lease must stay live to close descendants.
    control.backend.observationGuard(control.child)()
    const scope = options.scopes.assert(control.child.lease)
    return { lease: control.child.lease, policy: scope.policy }
  }
  const retiringParents = new Map<string, Promise<void>>()
  async function retireChildren(sessionID: string, intent: "end" | "detach" | "dispose") {
    const retiring = retiringParents.get(sessionID)
    if (retiring) return retiring
    const binding = bindings.stop(sessionID)
    if (binding) notificationOwners.get(binding)?.owner.stop()
    const work = (async () => {
      // Stop body waits and join accepted work without dropping the original cleanup custody.
      if (binding) await bindings.drain(binding)
      const records = store.list().records.filter(row => owns(row) && (intent === "end" || controls.has(row.task_id) || row.status === "pending" && row.residency_state !== "persisted_only"))
      const isDescendant = (record: typeof records[number]) => record.parent_session_id === sessionID || ownedAncestorPath(parentID, records, record.parent_session_id, true).some(row => row.child_session_id === sessionID)
      const descendants = records.filter(isDescendant).sort((a, b) => b.depth - a.depth)
      const parents = [...new Set(descendants.map(row => row.parent_session_id))]
      for (const parent of parents) {
        if (intent === "end") {
          for (const record of descendants.filter(row => row.parent_session_id === parent)) {
            if (record.status === "running" || record.status === "pending" || record.status === "paused") await manager.cancelTask(record.task_id, "Owned ancestor ended")
            await lifecycle.destroyResidentTask(record.task_id, "cancel")
          }
        } else {
          const owner = records.find(row => row.child_session_id === parent)
          const summary = await suspendingForShutdown.run(true, () => lifecycle.suspendOnSessionShutdown({ parentSessionId: parent, ...(owner ? { ownTaskId: owner.task_id } : {}), reason: "reload" }))
          if (summary.failures.length) throw new AggregateError(summary.failures, "Owned descendant suspension incomplete")
        }
      }
      // Descendant teardown can register more original work. Join it before releasing the binding;
      // a failed teardown retains this exact binding so the same cleanup can retry.
      if (binding) { await closeNotificationOwner(binding); await bindings.release(binding) }
    })()
    retiringParents.set(sessionID, work)
    void work.finally(() => { if (retiringParents.get(sessionID) === work) retiringParents.delete(sessionID) }).catch(() => {})
    return work
  }
  const controlTails = new Map<string, Promise<unknown>>()
  const controlWork = new Set<Promise<unknown>>()
  const inputAdmissions = new Map<string, Set<AbortController>>()
  let closeAttempt: Promise<void> | undefined, closed = false
  const cleanup = { controls: false, workpools: false, launches: false, suspended: false, notifications: false,
    lifecycle: false, runner: false, observations: false, journal: false, releases: false, completionJournal: false, store: false }
  const controlFailures: unknown[] = []
  function active() { if (closing) throw new Error("Native task runtime closing"); options.scopes.assert(options.parent); options.initializationSignal?.throwIfAborted() }
  const freshRecoveries = options.childToolGuard && createFreshRecoveryApprovals({ guard: options.childToolGuard, stateDir: options.stateDir,
    ...(options.authorizeRecovery && { authorize: options.authorizeRecovery }), capture: () => options.captureStartAuthority() })
  /** Team identity of a recovered member: the persisted record's own team fields, written from the
   * ORIGINAL approved spec at its start. The member producer re-fences every send against live
   * team-core state (team live, led by this parent, member listed), so a stale identity sends nothing. */
  function recoveredTeam(spec: ManagedStartSpec): ApprovedTeam | undefined {
    const record = store.load(spec.taskId)
    if (!record || record.team_role !== "member" || !record.team_run_id || !record.team_member_name || record.parent_session_id !== spec.parentSessionId) return undefined
    return Object.freeze({ runId: record.team_run_id, memberName: record.team_member_name })
  }
  /** Guarded child bindings from ONE original producer: planned admission or fresh recovery. */
  function guardFor(spec: ManagedStartSpec, approval: ChildGuardApproval, prepared: Planned, assertLifetime: () => void, assertStageAdmission?: () => void, team?: ApprovedTeam) {
    if (!options.childGuardBinding) throw Error("Child tool guard requires original planned authorization and live binding producer")
    const producer = options.childGuardBinding(spec, prepared, { ...(team && { team }), appendTaskEvent: event => store.appendEvent(spec.taskId, event) }), footprint = JSON.stringify(producer.coverage)
    const assertProducer = () => { assertLifetime(); producer.assertCurrent(); if (JSON.stringify(producer.coverage) !== footprint) throw Error("Original child binding targets changed") }
    assertProducer()
    return { approval, selection: prepared.selection, coverage: producer.coverage, buildAgentID: prepared.buildAgentID, assertLifetime: assertProducer,
      ...(assertStageAdmission && { assertStageAdmission }),
      bind: (child: ChildHandle, assertBackendCurrent: () => void) => { assertProducer(); const binding = producer.bind(child, assertBackendCurrent); if (JSON.stringify(binding.coverage) !== footprint) throw Error("Actual child binding targets differ from original producer"); return binding } }
  }
  const runner = createOwnedManagedRunner({ ctx, journal, observationStore, store, stateDir: options.stateDir, parent: options.parent, scopes: options.scopes,
    policy: options.policy, planner, metadataSource: options.metadataSource, assertAdmission: active,
    ...(options.locationReleased && { locationReleased: options.locationReleased }),
    ...(options.childToolGuard && { childGuard: { owner: options.childToolGuard, forSpec(spec: ManagedStartSpec) {
      const recovery = freshRecoveries?.forSpec(spec)
      if (recovery) return guardFor(spec, recovery.guardApproval, recovery.prepared, () => recovery.authority.assertLifetime(), () => recovery.authority.assertAdmission(), recoveredTeam(spec))
      const admission = spec.admission, grant = admission && plannedGrants.get(admission)
      if (!admission || !grant?.guardApproval || admission.hostAuthority !== grant.authority) throw Error("Child stage has no original approved guard admission")
      grant.assertLifetime()
      return guardFor(spec, grant.guardApproval, grant.prepared, () => grant.assertLifetime(), undefined, grant.team)
    } } }),
    async parentForSpec(spec, recovery) {
      if (recovery) {
        const scope = notificationRecoveries.getStore()
        if (options.notification && (!scope?.open || scope.managed !== spec || scope.taskId !== spec.taskId
          || spec.parentSessionId !== scope.birth.parentSessionId || spec.rootSessionId !== scope.birth.rootSessionId
          || spec.depth !== scope.birth.depth)) throw Error("Recovery stage has no exact actual managed scope")
        const record = store.load(spec.taskId); if (!record) throw Error("Recovery record missing")
        const parent = await recoveryParent(record)
        if (scope) { if (!scope.open || scope.managed !== spec) throw Error("Original recovery stage closed"); scope.verified = true }
        return { parent: parent.lease, policy: parent.policy }
      }
      const binding = bindings.fromAuthority(spec.admission?.hostAuthority), parent = bindings.info(binding, true)
      if (spec.parentSessionId !== parent.lease.sessionID || spec.rootSessionId !== parent.rootSessionId || spec.depth !== parent.depth + 1) throw Error("Managed start ancestry differs")
      if (options.notification) {
        const stage = notificationStages.getStore()
        if (!stage?.open || stage.managed !== spec || stage.origin.binding !== binding
          || stage.origin.authority !== spec.admission?.hostAuthority) throw Error("Managed creation has no exact original notification stage")
        stage.verified = true
      }
      return { parent: parent.lease, policy: parent.policy }
    },
    async parentForRecord(record) { assertCandidate(record, true); const parent = await cleanupParent(record); return { parent: parent.lease, policy: parent.policy } },
    beforeLeaseRetire: (child, intent) => retireChildren(child.locator.sessionID, intent),
    installed(control) { forgetRelease(control.handle.task_id); if (restartRecoveries.has(control.handle.task_id)) control.continueAfterRestart(HOST_RESTART_CONTINUATION); controls.set(control.handle.task_id, control); const record = store.load(control.handle.task_id); if (!record || record.child_session_id !== control.child.locator.sessionID || record.parent_session_id !== control.child.locator.parentID) throw Error("Installed control tree identity differs"); remember(record); registerInstalledNotification(control, record) } })
  function captureNotificationRecovery(record: TaskRecord): NotificationRecoveryOrigin {
    if (!record.owned_session) throw Error("Actual recovery request has no owned journal reference")
    return Object.freeze({ identity: Object.freeze({}), taskId: record.task_id, beforeEpoch: record.notification.run_epoch,
      journalKey: record.owned_session.journalKey, birth: Object.freeze({ createdAt: record.created_at,
        parentSessionId: record.parent_session_id, rootSessionId: record.root_session_id, depth: record.depth }) })
  }
  async function recoverOwnedControl(spec: ManagedStartSpec, key: string, origin?: NotificationRecoveryOrigin) {
    if (!options.notification) return runner.recover(spec, key)
    if (!origin || origin.taskId !== spec.taskId || origin.journalKey !== key) throw Error("Actual recovery runner has no original request association")
    const before = store.load(spec.taskId)
    if (!before || before.notification.run_epoch !== origin.beforeEpoch || before.created_at !== origin.birth.createdAt
      || before.parent_session_id !== origin.birth.parentSessionId || before.root_session_id !== origin.birth.rootSessionId
      || before.depth !== origin.birth.depth) throw Error("Original recovery request moved before the actual claim")
    const scope: NotificationRecoveryScope = { ...origin, managed: spec, open: true, verified: false }
    try {
      const control = await notificationRecoveries.run(scope, () => runner.recover(spec, key))
      if (scope.control !== control) throw Error("Recovered return differs from actual installed control")
      const claimed = await journal.read(key)
      if (!claimed) throw Error("Actual recovery journal claim unavailable")
      control.handle.assertOwned?.(); control.backend.observationGuard(control.child)(); journal.assertCurrent(claimed)
      pendingNotificationReattachments.set(control.handle, { origin, control, claimed })
      return control
    } finally { scope.open = false }
  }
  function registerReattachedNotification(candidate: NonNullable<ReturnType<typeof pendingNotificationReattachments.get>>,
    result: Awaited<ReturnType<ReattachingTaskManager["reattach"]>>) {
    if (!options.notification || closing || !result.ok) return
    const { origin, control, claimed } = candidate, birth = origin.birth
    const binding = bindings.get(birth.parentSessionId), current = store.load(origin.taskId)
    if (!binding || !current || controls.get(origin.taskId) !== control || current.created_at !== birth.createdAt
      || current.parent_session_id !== birth.parentSessionId || current.root_session_id !== birth.rootSessionId
      || current.depth !== birth.depth) throw Error("Actual recovered notification identity moved")
    control.handle.assertOwned?.()
    const entry = notificationOwner(binding)
    const initialInput = current.notification.run_epoch === origin.beforeEpoch && claimed.turn === undefined
      && claimed.admission === "accepted" && claimed.inboxID && claimed.receipts[claimed.inboxID] === "accepted"
      ? Object.freeze({ inputID: claimed.inboxID, row: claimed }) : undefined
    notificationRecovered.set(control, Object.freeze({ identity: origin.identity, control, birth, beforeEpoch: origin.beforeEpoch,
      nativeEpoch: current.notification.run_epoch, claim: current.residency_claim, result,
      ...(initialInput ? { initialInput } : {}) }))
    notificationTasks.delete(origin.taskId)
    notificationAccepted.set(origin.taskId, Object.freeze({ identity: origin.identity, birth, epoch: current.notification.run_epoch,
      claim: current.residency_claim, control }))
    const task = entry.issuer.bindRecovered(control)
    notificationTasks.set(origin.taskId, { binding, task })
    entry.owner.requestReconcile()
  }
  function createNotificationRecoveryRuntime(): TaskRecoveryRuntime {
    const actual = createOwnedTaskRecovery(options.notification ? { ...runner,
      recover: (spec, key) => recoverOwnedControl(spec, key, notificationRecoveryRequests.getStore()),
    } : runner, options.stateDir, { verifyRecord: async (record, spec) => { assertCandidate(record); await recoveryParent(record); freshRecoveries?.verify(record, spec) } })
    if (!options.notification) return actual
    return { ...actual, respawn(request, workers, epoch) {
      if (!request.record.owned_session) return actual.respawn(request, workers, epoch)
      const origin = notificationRecoveryRequests.getStore() ?? captureNotificationRecovery(request.record)
      if (origin.taskId !== request.record.task_id) throw Error("Another recovery request inherited this original scope")
      return notificationRecoveryRequests.run(origin, () => actual.respawn(request, workers, epoch))
    } }
  }
  async function recoverControl(record: ReturnType<typeof store.load> & {}) {
    const prior = recovering.get(record.task_id); if (prior) return prior
    const work = recoverControlNow(record); recovering.set(record.task_id, work)
    try { await work } finally { if (recovering.get(record.task_id) === work) recovering.delete(record.task_id) }
  }
  async function recoverControlNow(record: ReturnType<typeof store.load> & {}) {
    assertCandidate(record)
    assertRecoverableOwnedRecord(record, record.parent_session_id)
    const origin = captureNotificationRecovery(record)
    // Guarded: the CURRENT call's fresh approval precedes residency admission/claim/reattach.
    const approval = freshRecoveries ? await freshRecoveries.approve(record) : undefined
    await recoveryParent(record)
    approval?.authority.assertAdmission()
    const admitted = await lifecycle.admitResident(record.parent_session_id)
    if (admitted.kind === "rejected") throw admitted.error
    approval?.authority.assertAdmission()
    const respawned = await notificationRecoveryRequests.run(origin, () => approval && freshRecoveries ? freshRecoveries.run(approval, () => manager.respawn(record)) : manager.respawn(record))
    if (!respawned.ok) throw new Error(respawned.reason)
    const control = controls.get(record.task_id)
    if (!control || control.handle !== respawned.handle) throw Error("Actual Native recovery runtime returned another control")
    store.mutate(record.task_id, fresh => {
      control.handle.assertOwned?.()
      if (fresh.notification.run_epoch !== origin.beforeEpoch) throw new Error("Task epoch moved during owned recovery")
      return { ...fresh, host_pid: process.pid, residency_state: "resident" }
    })
    const restored = store.load(record.task_id); if (restored) remember(restored)
    const fresh = store.load(record.task_id)
    if (!fresh) throw Error("Recovered task record is absent after residency restore")
    const attached = await manager.reattach(fresh, control.handle)
    if (!attached.ok) throw new Error(attached.reason)
  }
  /** A parked guarded child is revived only inside a genuine current send: fresh approval, new
   * guard generation, verified restore, then Native's own revive delivery. Conflict refuses. */
  async function reviveParkedBeforeSend(id: string) {
    if (!freshRecoveries || controls.has(id) || manager.getResidentHandle(id)) return
    const record = store.load(id), ref = record?.owned_session
    if (!record || !ref || record.residency_state !== "persisted_only") return
    const state = (await journal.read(ref.journalKey))?.parking?.state
    if (state === "conflict") throw Error("Parked child is in permission conflict; host rules were preserved. Resolve it explicitly (END) before sending")
    if (state === "parked" || state === "restoring") await recoverControl(record)
  }
  /** Revives, inside a genuine current call, a child a previous runtime left behind:
   * - parked by that runtime's shutdown: its receipt must say `suspended` and still match the row
   *   exactly; a child the parent RELEASED stays released;
   * - stranded resident by a host that died without parking it: the dead host is proven by its pid,
   *   and the journal claim itself refuses any owner that is still live or unverified.
   * Anything else is left to the ordinary send path. */
  async function restoreAfterReload(id: string): Promise<boolean> {
    if (controls.has(id) || manager.getResidentHandle(id)) return false
    const record = store.load(id)
    if (!record || !record.owned_session) return false
    if (record.residency_state === "resident" && record.host_pid !== undefined && record.host_pid !== process.pid && getPidLiveness(record.host_pid) === "dead") {
      await afterRestart(id, () => recoverControl(record))
      return controls.has(id)
    }
    if (record.residency_state !== "persisted_only") return false
    const receipt = releaseReceipt(id)
    if (receipt?.kind !== "suspended") return false
    if (receipt.identity !== operationIdentity(record) || receipt.revision !== record.owned_session.journalRevision) throw Error("Suspended child changed since its runtime parked it")
    await afterRestart(id, () => reviveParkedBeforeSend(id))
    return controls.has(id)
  }
  /** Runs one restore of a child a host restart left behind; a cut-off turn it reattaches continues. */
  async function afterRestart(id: string, restore: () => Promise<void>): Promise<void> {
    restartRecoveries.add(id)
    try { await restore() } finally { restartRecoveries.delete(id) }
  }
  /** Record our own release only when the durable journal row is this record's exact child. */
  async function recordRelease(id: string): Promise<void> {
    const fresh = store.load(id), ref = fresh?.owned_session
    if (!fresh || !ref) return
    const row = await journal.read(ref.journalKey)
    if (!row || row.locator.sessionID !== ref.sessionID || row.locator.parentID !== ref.parentID || row.locator.backendID !== ref.backendID || row.locator.location !== ref.location) return
    const current = store.load(id)
    if (!current?.owned_session || operationIdentity(current) !== operationIdentity(fresh) || current.owned_session.journalRevision !== ref.journalRevision) return
    const receipt: ReleasedControlReceipt = Object.freeze({ taskID: id, identity: operationIdentity(current), revision: ref.journalRevision,
      kind: suspendingForShutdown.getStore() ? "suspended" : "released" })
    releasedControls.set(id, receipt)
    releaseJournal.record(receipt)
  }
  const ownedSessions = createOwnedTaskLifecyclePort({ controls, recover: recoverControl, closeRetained: async record => { await runner.closeRetained(record); await recordRelease(record.task_id) },
    beforeRetire: async (record, intent) => { if (record.child_session_id) await retireChildren(record.child_session_id, intent) },
    async releaseControl(record, control) {
      const managed = manager?.getResidentHandle(record.task_id)
      if (managed && managed !== control.handle) {
        if (managed.sessionId !== control.handle.sessionId || managed.task_id !== control.handle.task_id) throw Error("Managed cleanup owner differs from actual control")
        await managed.dispose()
      }
      const fresh = store.load(record.task_id), row = fresh?.owned_session && await journal.read(fresh.owned_session.journalKey)
      if (fresh?.owned_session && row?.phase === "closed") {
        await control.backend.confirmClosed(control.child)
        const current = store.load(record.task_id)
        if (!current?.owned_session || operationIdentity(current) !== operationIdentity(fresh)) throw Error("Closed source identity moved during confirmation")
        journal.assertCurrent(row)
        closedControls.set(record.task_id, Object.freeze({ identity: operationIdentity(current), revision: current.owned_session.journalRevision,
          control, row, referenceRevision: current.owned_session.journalRevision }))
        forgetRelease(record.task_id)
      } else await recordRelease(record.task_id)
    },
    async isClosed(record) {
      const ref = record.owned_session
      if (!ref) return false
      const row = await journal.read(ref.journalKey)
      return row?.phase === "closed" && row.locator.sessionID === ref.sessionID && row.locator.parentID === ref.parentID && row.locator.backendID === ref.backendID && row.locator.location === ref.location && row.revision >= ref.journalRevision
    },
    beforeDetach(record) { if (record.status === "running" || record.status === "pending" || record.status === "paused") manager?.markObservationUncertain(record.task_id, new ChildObservationUncertain("observer-detached")) },
    report(message, context) { console.warn(`[oh-my-openagent/v2] ${message}`, context) } })
  const registry: ResidencyRegistry = {
    get(id) { const handle = manager?.getResidentHandle(id); return handle ? { ...handle, kind: handle.kind ?? "in-process", terminate: handle.terminate ?? (async () => { throw new Error("Resident has no end port") }) } : undefined },
    entries() { return (manager?.residentTaskIds() ?? []).flatMap(id => { const handle = registry.get(id); return handle ? [handle] : [] }) },
    forget: (id, intent) => manager.forget(id, intent), hasPendingSends: id => manager?.hasPendingSends?.(id) ?? false,
    ownsRecord: owns,
  }
  lifecycle = createTaskLifecycle({ store, registry, config, ownedSessions, hostPid: process.pid, hostEndpoint: NO_HOST_ENDPOINT,
    dequeuePending(id) { const record = store.load(id); if (record) manager.concurrency?.remove(record.model, id); manager.forget(id, { path: "park" }) },
  })
  initializers.push({ close: () => lifecycle.dispose?.(), done: false }, { close: () => runner.dispose(), done: false })
  const creation: ChildCreationPort = { async startPaused(spec, selected, ticket) {
    if (options.authorizePlannedStart) {
      const admission = spec.admission, grant = admission && plannedGrants.get(admission)
      if (!admission || !grant || admission.hostAuthority !== grant.authority || bindings.fromAuthority(grant.authority) !== grant.parent) throw Error("Managed stage has no original planned grant admission")
      admission.assertOpen()
      if (selected !== runner.runner || grant.policyBasis !== nativePolicyBasis(grant.spec, grant.plan)) throw Error("Native descendant/execution policy differs from original approved admission")
      if (grant.kernelTools !== spec.kernelTools || grant.members !== spec.memberScopedTools || grant.footprint !== grantFootprint({
        parent: spec.parentSessionId, root: spec.rootSessionId, depth: spec.depth, instructions: spec.instructions,
        agentType: spec.agentType, allow: spec.toolAllowlist, deny: spec.toolDenylist, includeTaskTools: spec.includeTaskTools === true,
      })) throw Error("Managed persona/tool grant differs from original approved plan")
    }
    let stage: NotificationStage | undefined
    if (options.notification) {
      const authority = spec.admission?.hostAuthority, origin = authority && notificationOriginsByAuthority.get(authority)
      const record = store.load(spec.taskId)
      if (!origin || !record || origin.authority !== authority || !origin.provisional) throw Error("Actual creation has no original notification admission")
      acceptedBirth(origin, record)
      stage = { identity: Object.freeze({}), origin, managed: spec, epoch: record.notification.run_epoch,
        open: true, verified: false, beginInvoked: false }
    }
    const activeStage = stage
    const staged = await (activeStage ? notificationStages.run(activeStage, async () => {
      try { return await selected.startStaged?.(spec) } finally { activeStage.open = false }
    }) : selected.startStaged?.(spec))
    if (!staged) throw new Error("Owned runner must stage before first input")
    if (stage && (!stage.control || stage.control.handle !== staged.child)) throw Error("Staged return differs from actual installed notification control")
    return { child: staged.child, async activate() {
      spec.admission?.assertOpen(); active(); staged.child.assertOwned?.()
      if (ticket.commit().kind !== "launch") {
        // Throw through the original branded held-admission path; no child sequence/ACK invented.
        if (!spec.admission) throw Error("Managed start has no original Native admission")
        return spec.admission.assertOpen() as never
      }
      if (stage) {
        if (stage.origin.installed?.identity !== stage.identity || stage.origin.installed.control !== stage.control) throw Error("Original installed stage changed before first input")
        stage.beginInvoked = true; stage.origin.installed.beginInvoked = true
      }
      const begun = staged.begin()
      if (stage?.control) {
        notificationInitialInputs.set(stage.control, Object.freeze({ identity: stage.origin.identity, control: stage.control,
          stageIdentity: stage.identity, nativeEpoch: stage.epoch, inputID: begun.turnId, begin: begun }))
      }
      return begun
    } }
  } }
  manager = createTaskManagerImplementation({ cwd: ctx.location.directory, store, config, planner: planner.plan,
    runnerPort: { resolve: mode => mode === "in-process" ? runner.runner : undefined, all: () => [runner.runner] },
    admissionBarrier: barrier, childCreationPort: creation, destruction: lifecycle,
    captureStartAuthority: spec => {
      active()
      const binding = currentParent()
      const origin = notificationOrigins.getStore()
      if (options.notification) {
        const token = options.notification.captureCall()
        options.notification.callAuthority.assertCall(token)
        options.notification.callAuthority.assert(token, bindings.info(binding, true).lease)
        if (!origin || !origin.creation.open || origin.original.deref() !== spec || origin.binding !== binding) throw Error("Actual start has no original notification creation scope")
        origin.provisional = notificationOwner(binding).issuer.provision(token, spec)
      }
      const authority = options.captureStartAuthority(spec)
      if (!authority) throw new Error("Missing host start authority")
      authority.assertAdmission()
      const captured = bindings.capture(binding, authority, spec)
      startAuthorities.set(spec, captured)
      if (origin) { origin.authority = captured; notificationOriginsByAuthority.set(captured, origin) }
      return captured
    },
    admit: async parent => { const result = await lifecycle.admitResident(parent); return result.kind === "rejected" ? { kind: "rejected", message: result.error.message, max_children: result.error.max_children, residents: result.error.residents } : result },
  }, { preparePlanning: async () => { active(); await planner.prepare(); active() }, createRecoveryRuntime: createNotificationRecoveryRuntime,
    ...(options.authorizePlannedStart && { authorizePlannedStart(spec: ManagerStartSpec, plan: Parameters<NonNullable<NativeOwnedTaskRuntimeOptions["authorizePlannedStart"]>>[1]) {
      active()
      const admission = spec.admission, authority = admission?.hostAuthority
      if (!admission || !authority || plannedGrants.has(admission)) throw Error("Original planned host admission missing or reused")
      const parent = bindings.fromAuthority(authority), actual = bindings.info(parent, true)
      if (parent !== currentParent() || spec.parent_session_id !== actual.lease.sessionID || (spec.root_session_id ?? spec.parent_session_id) !== actual.rootSessionId || spec.depth !== actual.depth + 1) throw Error("Planned grant parent differs from original authority")
      admission.assertOpen()
      const footprint = grantFootprint({ parent: spec.parent_session_id, root: spec.root_session_id ?? spec.parent_session_id,
        depth: spec.depth, instructions: spec.instructions ?? plan.instructions, agentType: spec.subagent_type ?? plan.agentType,
        allow: plan.toolAllowlist, deny: plan.toolDenylist, includeTaskTools: admission.runRef.kind !== "dag" })
      const kernelTools = spec.kernelTools, members = spec.memberScopedTools
      // Team identity is snapshotted from the ORIGINAL approved spec before any hook work runs.
      const team: ApprovedTeam | undefined = spec.team_role === "member" && spec.team_run_id && spec.team_member_name
        ? Object.freeze({ runId: spec.team_run_id, memberName: spec.team_member_name }) : undefined
      const policyBasis = nativePolicyBasis(spec, plan)
      // Register ORIGINAL queued hook work before its producer can begin. This
      // nests under the original service/task operation, not its report waiter.
      const original = Promise.resolve().then(() => {
        const authorize = options.authorizePlannedStart
        if (!authorize) throw Error("Original planned host authorization is no longer configured")
        return authorize.call(options, spec, plan)
      }).then(prepared => {
        active(); admission.assertOpen()
        if (bindings.fromAuthority(authority) !== parent || spec.admission !== admission || admission.hostAuthority !== authority ||
          kernelTools !== spec.kernelTools || members !== spec.memberScopedTools || policyBasis !== nativePolicyBasis(spec, plan) || footprint !== grantFootprint({
            parent: spec.parent_session_id, root: spec.root_session_id ?? spec.parent_session_id, depth: spec.depth,
            instructions: spec.instructions ?? plan.instructions, agentType: spec.subagent_type ?? plan.agentType,
            allow: plan.toolAllowlist, deny: plan.toolDenylist, includeTaskTools: admission.runRef.kind !== "dag",
          })) throw Error("Original planned grant changed during authorization")
        const assertLifetime = () => {
          active(); authority.assertLifetime(); bindings.info(parent)
          if (spec.admission !== admission || admission.hostAuthority !== authority || kernelTools !== spec.kernelTools || members !== spec.memberScopedTools || policyBasis !== nativePolicyBasis(spec, plan)) throw Error("Original approved child lifetime changed")
        }
        const guardApproval = options.childToolGuard?.approve(admission, { selection: prepared.selection, buildAgentID: prepared.buildAgentID, assertCurrent: assertLifetime })
        plannedGrants.set(admission, { authority, parent, prepared, spec, plan, policyBasis, footprint, kernelTools, members, ...(team && { team }), assertLifetime, ...(guardApproval && { guardApproval }) })
      })
      return bindings.track(parent, original)
    } }),
  })
  const nativeReattach = manager.reattach.bind(manager)
  manager.reattach = async (record, handle, awaitingInput) => {
    const candidate = pendingNotificationReattachments.get(handle)
    try {
      const result = await nativeReattach(record, handle, awaitingInput)
      if (result.ok && candidate) {
        try { registerReattachedNotification(candidate, result) }
        catch (error) {
          // Native has already accepted this control. Retain the notification error without
          // turning that real success into a failed reattach that a caller could replay.
          notificationBindingFailures.push(error)
        }
      }
      return result
    } finally {
      if (candidate && pendingNotificationReattachments.get(handle) === candidate) pendingNotificationReattachments.delete(handle)
    }
  }
  const nativeStart = manager.start.bind(manager), nativeStartOwned = manager.startOwned.bind(manager)
  // Ordinary and DAG-owned starts share ONE notification origin: the original request witness, its
  // provisional grant and the accepted-without-child binding. A reused or conflicting owned start
  // creates no child, so it binds nothing new.
  async function notifiedStart<R extends { readonly kind: string }>(spec: ManagerStartSpec, run: () => Promise<R>, accepted: (result: R) => StartResult | undefined): Promise<R> {
    let origin: NotificationStartOrigin | undefined
    if (options.notification) {
      const identity = Object.freeze({}), births = new Map<string, Readonly<TaskBirth>>()
      const creation = { identity, open: true, onCreated(birth: Readonly<TaskBirth>): undefined {
        if (!creation.open || notificationOrigins.getStore()?.creation !== creation || births.has(birth.taskId)) throw Error("Creation witness has no unique open original request")
        births.set(birth.taskId, birth); return undefined
      } }
      origin = { identity, original: new WeakRef(spec), binding: currentParent(), births, creation, closeCreation() { creation.open = false } }
    }
    try {
      const result = await (origin ? notificationOrigins.run(origin, run) : run())
      if ("task_id" in result && typeof result.task_id === "string" && result.task_id) {
        const record = store.load(result.task_id)
        if (record) {
          remember(record)
          const authority = origin?.authority ?? startAuthorities.get(spec)
          if (authority && !record.child_session_id) acceptedStarts.set(record.task_id, { authority, epoch: record.notification.run_epoch })
          const started = accepted(result)
          if (origin?.provisional && started) {
            const entry = notificationOwner(origin.binding)
            if (started.kind === "started" || started.kind === "start_failed") {
              if (!record.child_session_id && !record.owned_session) {
                const birth = acceptedBirth(origin, record)
                notificationReturned.set(spec, Object.freeze({ result: started, identity: origin.identity }))
                notificationAccepted.set(record.task_id, Object.freeze({ identity: origin.identity, birth,
                  epoch: record.notification.run_epoch, claim: record.residency_claim }))
                origin.task = entry.issuer.bindAcceptedWithoutChild(origin.provisional, started)
                notificationTasks.set(record.task_id, { binding: origin.binding, task: origin.task })
              } else if (started.kind === "start_failed" && origin.installed?.control && !origin.installed.beginInvoked) {
                const stage = origin.installed, control = stage.control
                if (!control) throw Error("Failed notification start has no owned control")
                notificationFailedStarts.set(control, Object.freeze({ identity: origin.identity, control,
                  stageIdentity: stage.identity, nativeEpoch: stage.epoch, result: started, beginInvoked: false }))
              }
              entry.owner.requestReconcile()
            }
          }
        }
      }
      return result
    } finally { origin?.closeCreation() }
  }
  manager.start = spec => notifiedStart(spec, () => nativeStart(spec), result => result)
  manager.startOwned = (spec, owner) => notifiedStart(spec, () => nativeStartOwned(spec, owner),
    result => result.kind === "owner_conflict" || result.kind === "started" && result.reused ? undefined : result)
  initializers.push({ close: () => manager.workpools.dispose(), done: false })
  async function detach(id: string) {
    const record = store.load(id)
    if (!record || !owns(record)) throw new Error("Unknown owned task")
    await ownedSessions.suspend(record, "reload")
    manager.forget(id, { path: "park" })
    store.transition(id, { type: "persist_only", timestamp: new Date().toISOString() })
  }
  function assertCandidate(record: import("@oh-my-opencode/senpi-task/manager-kernel").TaskRecord, cleanup = false) {
    assertOwnedTreeRecord(record, parentID)
    if (store.list().records.filter(row => row.child_session_id === record.child_session_id).length !== 1) throw Error("Owned recovery child identity is ambiguous")
    ownedAncestorPath(parentID, store.list().records, record.parent_session_id, cleanup)
  }
  function readable(id: string) {
    const record = manager.get(id), parent = bindings.info(currentParent())
    if (!record || record.root_session_id !== parentID || record.parent_session_id !== parent.lease.sessionID && record.root_session_id !== parent.lease.sessionID) throw Error("Task outside parent scope")
    return record
  }
  function scoped(id: string, allowStored = false, cleanupStored = false) {
    const record = readable(id)
    if (!owns(record)) { if (!allowStored) throw Error("Task outside parent scope"); assertCandidate(record, cleanupStored) }
    return record
  }
  function operationIdentity(record: import("@oh-my-opencode/senpi-task/manager-kernel").TaskRecord): string {
    return JSON.stringify([record.task_id, record.parent_session_id, record.root_session_id, record.depth,
      record.notification.run_epoch, record.residency_claim, record.child_session_id,
      record.owned_session && { ...record.owned_session, journalRevision: undefined }])
  }
  /** Whether `captureOperationTask` would admit `id` for this call, read WITHOUT capturing it (no
   * receipt, no re-admission): owned by this runtime, or released by its previous runtime and still
   * exactly that released child. A row merely parked by a shutdown, or stranded by a dead host,
   * answers false; such a row is restored only through restoreAfterReload. */
  function operationTaskOwned(binding: VerifiedParentBinding, id: string): boolean {
    const parent = bindings.info(binding)
    const row = manager.get(id)
    if (!row || row.root_session_id !== parentID || row.parent_session_id !== parent.lease.sessionID && row.root_session_id !== parent.lease.sessionID) return false
    if (owns(row)) return true
    const receipt = row.child_session_id && !controls.has(id) && !manager.getResidentHandle(id) ? releaseReceipt(id) : undefined
    return receipt?.kind === "released" && receipt.identity === operationIdentity(row) && receipt.revision === row.owned_session?.journalRevision
  }
  function captureOperationTask(binding: VerifiedParentBinding, id: string): AcceptedTaskProof {
    const parent = bindings.info(binding)
    const initial = manager.get(id)
    if (!initial || initial.root_session_id !== parentID || initial.parent_session_id !== parent.lease.sessionID && initial.root_session_id !== parent.lease.sessionID) throw Error("Operation task outside original parent")
    if (!owns(initial)) {
      // A reloaded runtime re-admits ONLY a row its previous runtime RELEASED itself, while that row
      // is still exactly the released child. A row merely parked by that runtime's shutdown stays a
      // stored row (restored only through restoreAfterReload); anything else stays outside.
      const receipt = initial.child_session_id && !controls.has(id) && !manager.getResidentHandle(id) ? releaseReceipt(id) : undefined
      if (!receipt || receipt.kind !== "released" || receipt.identity !== operationIdentity(initial) || receipt.revision !== initial.owned_session?.journalRevision) throw Error("Operation task has no original owned membership")
      assertCandidate(initial, true)
      remember(initial)
      if (!owns(initial)) throw Error("Operation task has no original owned membership")
    }
    if (initial.child_session_id) assertCandidate(initial, true)
    const epoch = initial.notification.run_epoch
    const queuedClaim = initial.residency_claim
    const initialRelation = JSON.stringify([initial.task_id, initial.parent_session_id, initial.root_session_id, initial.depth, epoch])
    let identity = initial.child_session_id ? operationIdentity(initial) : undefined
    let originalControl = initial.child_session_id ? controls.get(id) : undefined
    let revision = initial.owned_session?.journalRevision ?? 0
    const accepted = acceptedStarts.get(id)
    function read() {
      bindings.info(binding)
      const row = manager.get(id)
      if (row && !owns(row)) throw Error("Accepted Native membership changed")
      if (!row || JSON.stringify([row.task_id, row.parent_session_id, row.root_session_id, row.depth, row.notification.run_epoch]) !== initialRelation) throw Error("Accepted Native operation identity changed")
      if (row.child_session_id) {
        const control = controls.get(id)
        if (control) {
          if (originalControl && originalControl !== control) throw Error("Accepted Native control replaced")
          originalControl ??= control
          if (control.child.locator.sessionID !== row.child_session_id || control.child.locator.parentID !== row.parent_session_id) throw Error("Accepted control child differs")
          if (!control.handle.assertOwned) throw Error("Accepted control has no private custody proof")
          control.handle.assertOwned()
        } else {
          // No live control: only our own closed or released receipt for this exact row is custody.
          const closed = closedControls.get(id) ?? (manager.getResidentHandle(id) ? undefined : releaseReceipt(id))
          if (!closed || closed.identity !== operationIdentity(row) || closed.revision !== row.owned_session?.journalRevision) throw Error("Accepted Native custody unavailable")
        }
        const next = operationIdentity(row)
        if (identity !== undefined && next !== identity) throw Error("Accepted Native epoch or owner changed")
        const nextRevision = row.owned_session?.journalRevision
        if (nextRevision === undefined || nextRevision < revision) throw Error("Accepted Native journal rolled back")
        identity = next; revision = nextRevision
      } else {
        if (identity !== undefined || row.owned_session || row.residency_claim !== queuedClaim || !accepted || accepted.epoch !== epoch || acceptedStarts.get(id) !== accepted) throw Error("Queued operation has no original Native admission")
        accepted.authority.assertLifetime()
      }
      return row
    }
    read()
    return Object.freeze({ taskID: id, epoch, read })
  }
  async function controlled<T>(id: string, operation: () => Promise<T>, stopInputs = false, allowStored = false, cleanupStored = false, acceptedCleanup = false): Promise<T> {
    if (!acceptedCleanup) active()
    scoped(id, allowStored, cleanupStored)
    if (stopInputs) for (const controller of inputAdmissions.get(id) ?? []) controller.abort(new Error("Managed input stopped before its admission settled"))
    const inputStop = stopInputs ? controls.get(id)?.stopInputs() : undefined
    const previous = controlTails.get(id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => { await inputStop; return operation() })
    controlTails.set(id, next); controlWork.add(next)
    void next.finally(() => {
      controlWork.delete(next)
      if (controlTails.get(id) === next) controlTails.delete(id)
    }).catch(() => {})
    return next
  }
  const runtime = {
    manager, store: baseStore, barrier,
    completionDiagnostics() { return { custodyRecords: notificationAccepted.size, acceptedTaskGrants: notificationTasks.size,
      failures: notificationBindingFailures.map(error => String(error)), owners: [...notificationOwners.values()].map(entry => entry.owner.diagnostics()) } },
    rootParent: bindings.root, parentInfo: bindings.info, verifyParent,
    ownsSession(sessionID: string) { try { return sessionID === parentID || ancestry.path(sessionID).length > 0 } catch { return false } },
    withParent<T>(binding: VerifiedParentBinding, work: () => T): T { bindings.info(binding, true); return parentContext.run(binding, work) },
    resolveAncestry(sessionID: string) { const parent = bindings.info(currentParent(), true); if (sessionID !== parent.lease.sessionID) throw Error("Foreign ancestry request"); return { rootSessionId: parent.rootSessionId, depth: parent.depth } },
    trackParent: bindings.track, releaseParent: async (binding: VerifiedParentBinding) => { const parent = bindings.info(binding); await retireChildren(parent.lease.sessionID, "detach") },
    operationOwner(binding: VerifiedParentBinding, lifetimeOptions: Omit<Parameters<typeof createAcceptedOperationLifetime>[0], "registry">) {
      const parent = bindings.info(binding, true)
      const issuedAdmission = options.captureStartAuthority()
      issuedAdmission.assertAdmission()
      if (lifetimeOptions.source.sessionID !== parent.lease.sessionID) throw Error("Foreign operation source")
      const acceptedSignal = lifetimeOptions.acceptedSignal
      const assertOperationLifetime = lifetimeOptions.assertLifetime
      /** A child its previous runtime parked mid-turn for a reload (still `running`, its receipt says
       * `suspended` for exactly this row): a send revives it the way restoreAfterReload does, so the
       * cut-off turn continues once as a new observed turn, and the sent message then steers it. */
      function parkedMidTurn(record: TaskRecord): boolean {
        if (!["running", "pending", "paused"].includes(record.status) || !record.owned_session) return false
        const receipt = releaseReceipt(record.task_id)
        return receipt?.kind === "suspended" && receipt.identity === operationIdentity(record) && receipt.revision === record.owned_session.journalRevision
      }
      function storedSendRefusal(record: TaskRecord): NativeOperationResolution | undefined {
        if (owns(record) || record.runner_kind !== "owned-session" || record.residency_state !== "persisted_only"
          || !(["completed", "error", "interrupted"].includes(record.status) || parkedMidTurn(record)) || record.host_session
          || !record.child_session_id || !record.owned_session || controls.has(record.task_id) || manager.getResidentHandle(record.task_id)) return
        assertCandidate(record, true)
        const snapshot = JSON.stringify(record), id = record.task_id, epoch = record.notification.run_epoch
        return Object.freeze({ kind: "stored-refusal" as const, send(input: Parameters<typeof manager.sendToTask>[0]) {
          lifetime.assertAction(); issuedAdmission.assertAdmission(); bindings.info(binding, true)
          if (input.allScope || input.callerSessionId !== undefined && input.callerSessionId !== parent.lease.sessionID) throw Error("Cross-parent stored send is not issued")
          const originalInput = { ...input }
          return lifetime.track(controlled(id, async () => {
            // Joining recovery does not turn an old stored snapshot into live
            // custody. Re-resolve through a new current call if it changed.
            lifetime.assertAction(); issuedAdmission.assertAdmission(); bindings.info(binding, true)
            const fresh = manager.get(id)
            if (!fresh || JSON.stringify(fresh) !== snapshot || owns(fresh) || controls.has(id) || manager.getResidentHandle(id)) throw Error("Stored send refusal identity changed")
            assertCandidate(fresh, true)
            if (parkedMidTurn(fresh)) await afterRestart(id, () => reviveParkedBeforeSend(id))
            else await reviveParkedBeforeSend(id)
            lifetime.assertAction(); issuedAdmission.assertAdmission()
            // Reattaching a child parked mid-turn publishes a new run epoch; a settled child keeps its own.
            const revivedEpoch = manager.get(id)?.notification.run_epoch ?? epoch
            return manager.sendToTask({ ...originalInput, idOrName: id, callerSessionId: parent.lease.sessionID, allScope: false, expectedRunEpoch: originalInput.expectedRunEpoch ?? revivedEpoch })
          }, false, true, true))
        } })
      }
      function resolve(input: string, resolveOptions?: { readonly storedSendRefusal: true }): NativeOperationResolution {
        const direct = manager.get(input)
        if (direct) {
          if (direct.root_session_id !== parentID || direct.parent_session_id !== parent.lease.sessionID && direct.root_session_id !== parent.lease.sessionID) return { kind: "missing-in-original-scope" }
          const stored = resolveOptions?.storedSendRefusal && storedSendRefusal(direct)
          if (stored) return stored
          captureOperationTask(binding, direct.task_id).read()
          return { kind: "found", taskID: direct.task_id }
        }
        const rows = manager.list({ scope: "parent-session", session_id: parent.lease.sessionID })
        const directNames = rows.filter(item => item.record.parent_session_id === parent.lease.sessionID && item.record.name === input)
        const named = directNames.length ? directNames : parent.lease.sessionID === parentID ? rows.filter(item => item.record.name === input) : []
        if (named.length > 1) return { kind: "denied", reason: "Ambiguous task name in original scope" }
        if (!named.length) return { kind: "missing-in-original-scope" }
        const stored = resolveOptions?.storedSendRefusal && storedSendRefusal(named[0].record)
        if (stored) return stored
        captureOperationTask(binding, named[0].record.task_id).read()
        return { kind: "found", taskID: named[0].record.task_id }
      }
      const lifetime = createAcceptedOperationLifetime({ ...lifetimeOptions, registry: acceptedOperations })
      return createNativeOperationPorts(lifetime, {
        manager, parentSessionID: parent.lease.sessionID,
        assertCurrent() { active(); issuedAdmission.assertAdmission(); bindings.info(binding, true) },
        capture: id => captureOperationTask(binding, id),
        owned: id => operationTaskOwned(binding, id),
        resolve,
        captureSendFormattingScope() {
          // Issued only while the original send is still in its authorized frame.
          lifetime.assertAction(); bindings.info(binding, true)
          const lease = parent.lease, directory = ctx.location.directory
          return () => {
            assertOperationLifetime()
            const current = bindings.info(binding)
            if (closed || cleanup.store || current.lease !== lease || ctx.location.directory !== directory) throw Error("Original send formatting scope retired")
            return manager.list({ scope: "parent-session", session_id: lease.sessionID })
          }
        },
        assertParentPark(id, epoch, continuation) { bindings.info(binding, !continuation); const row = manager.findTaskByChildSession?.(parent.lease.sessionID), control = controls.get(id); if (!row || row.task_id !== id || row.notification.run_epoch !== epoch || !control || control.child.lease !== parent.lease || !control.handle.assertOwned) throw Error("Foreign parent lane"); control.handle.assertOwned() },
        start: spec => { const current = bindings.info(binding, true); if (spec.parent_session_id !== current.lease.sessionID || (spec.root_session_id ?? spec.parent_session_id) !== current.rootSessionId || spec.depth !== current.depth + 1) throw Error("Operation start ancestry differs"); return manager.start(spec) },
        startOwned: (spec, owner) => { const current = bindings.info(binding, true); if (spec.parent_session_id !== current.lease.sessionID || (spec.root_session_id ?? spec.parent_session_id) !== current.rootSessionId || spec.depth !== current.depth + 1) throw Error("Operation start ancestry differs"); return manager.startOwned(spec, owner) },
        // This invocation enters controlled's private queue synchronously. Reporting
        // cancellation is deliberately not the accepted transport's abort signal.
        send: input => { if (input.allScope || input.callerSessionId !== undefined && input.callerSessionId !== parent.lease.sessionID) throw Error("Cross-parent operation send is not issued"); const resolved = resolve(input.idOrName); if (resolved.kind !== "found") throw Error("Accepted send target proof unavailable"); return runtime.send({ ...input, idOrName: resolved.taskID, callerSessionId: parent.lease.sessionID }, { signal: AbortSignal.any([acceptedSignal, parent.lease.signal, parent.stop.signal]) }) },
        cancel: (id, reason, extra) => controlled(id, () => manager.cancelTask(id, reason, extra), true, true, true, true),
        waitFor: (id, extra) => { const current = bindings.info(binding); return manager.waitFor(id, { signal: AbortSignal.any([current.stop.signal, ...(extra?.signal ? [extra.signal] : [])]) }) },
        // The lifecycle single-writer port, serialized with this task's other controls like END.
        destroyResidentTask: (id, cause) => controlled(id, () => lifecycle.destroyResidentTask(id, cause), true, true, true),
        restoreAfterReload: id => controlled(id, () => restoreAfterReload(id), false, true, true),
      })
    },
    capabilities: Object.freeze({ activeRunPause: false, processMode: false, continuousOldTurnRecovery: false, nativeSteerOrdering: false, nativeTaskRecursion: true }),
    async start(spec: Omit<ManagerStartSpec, "parent_session_id" | "root_session_id" | "depth">) { active(); const parent = bindings.info(currentParent(), true); return manager.start({ ...spec, parent_session_id: parent.lease.sessionID, root_session_id: parent.rootSessionId, depth: parent.depth + 1 }) },
    get(id: string) { return readable(id) },
    async wait(id: string, signal?: AbortSignal) { const waiting = readable(id); if (!owns(waiting) && (waiting.status === "running" || waiting.status === "pending" || waiting.status === "paused")) throw new ChildObservationUncertain("owned-control-not-attached"); const parent = bindings.info(currentParent()); const result = await manager.waitFor(id, { signal: AbortSignal.any([parent.stop.signal, ...(signal ? [signal] : [])]) }); controls.get(id)?.flush(); return result },
    output: (input: Parameters<typeof readOwnedTaskOutput>[3]) => readOwnedTaskOutput(manager, options.stateDir, bindings.info(currentParent()).lease.sessionID, input),
    async send(input: Parameters<typeof manager.sendToTask>[0], invocation?: { signal?: AbortSignal }): ReturnType<typeof manager.sendToTask> {
      active(); invocation?.signal?.throwIfAborted()
      const callerID = bindings.info(currentParent(), true).lease.sessionID
      let record = manager.get(input.idOrName)
      if (!record) record = manager.list({ scope: "all" }).find(item => item.record.name === input.idOrName)?.record
      if (!record) return manager.sendToTask({ ...input, callerSessionId: callerID, allScope: false })
      scoped(record.task_id)
      if (input.allScope || input.callerSessionId !== undefined && input.callerSessionId !== callerID) throw new Error("Task outside parent scope")
      const id = record.task_id
      const admission = new AbortController(), admissions = inputAdmissions.get(id) ?? new Set<AbortController>()
      inputAdmissions.set(id, admissions); admissions.add(admission)
      const signal = AbortSignal.any([admission.signal, ...(invocation?.signal ? [invocation.signal] : [])])
      try { return await controlled(id, () => (async () => {
        signal.throwIfAborted(); active()
        await reviveParkedBeforeSend(id)
        signal.throwIfAborted(); active()
        const current = scoped(id)
        const operation = () => manager.sendToTask({ ...input, idOrName: id, callerSessionId: callerID, allScope: false })
        try {
          const control = controls.get(id)
          const result = control ? await control.withInputSignal(signal, operation) : await operation()
          if (result.kind === "uncertain") manager.markObservationUncertain(id, new ChildObservationUncertain("input-admission-uncertain"))
          return result
        } catch (error) {
          if (!ChildObservationUncertain.is(error)) throw error
          manager.markObservationUncertain(id, error)
          return { kind: "delivery_uncertain" as const, task_id: id, run_epoch: current.notification.run_epoch,
            reason: error.message, suggestion: "Inspect task_output; no automatic resend is permitted." }
        }
      })().catch(error => {
        // This is an expected pre-admission control result, not a failed owned closer.
        // Normalize it before controlWork observes the operation's settlement.
        if (!admission.signal.aborted || error !== admission.signal.reason) throw error
        return { kind: "not_continuable" as const, task_id: id, reason: "Managed input stopped before dispatch; no new input was admitted.", suggestion: "Inspect task_output." }
      })) } catch (error) {
        if (!admission.signal.aborted || error !== admission.signal.reason) throw error
        return { kind: "not_continuable", task_id: id, reason: "Managed input stopped before dispatch; no new input was admitted.", suggestion: "Inspect task_output." }
      } finally { admissions.delete(admission); if (admissions.size === 0) inputAdmissions.delete(id) }
    },
    interrupt: (id: string) => controlled(id, () => manager.interruptTask(id), true),
    cancel: (id: string) => controlled(id, () => manager.cancelTask(id), true, true, true),
    detach: (id: string) => controlled(id, () => detach(id), true),
    recover: (id: string) => controlled(id, async () => { const record = store.load(id); if (!record) throw new Error("Task missing"); await recoverControl(record); return manager.get(id) }, false, true),
    end: (id: string) => controlled(id, async () => { const record = scoped(id, true, true); await controls.get(id)?.prepareEnd(); if (record.status === "running" || record.status === "pending" || record.status === "paused") { await manager.cancelTask(id, "Owned task explicitly ended", { abort: "skip" }); return }; await lifecycle.destroyResidentTask(id, "cancel") }, true, true, true, closing && options.childToolGuard !== undefined),
    close(): Promise<void> {
      if (closed) return Promise.resolve()
      if (closeAttempt) return closeAttempt
      closing = true
      for (const entry of notificationOwners.values()) entry.owner.stop()
      let acceptedStopError: unknown
      try { acceptedOperations.stop() } catch (error) { acceptedStopError = error }
      barrier.close(parentID, Date.now())
      for (const binding of bindings.entries()) bindings.stop(bindings.info(binding).lease.sessionID)
      for (const controllers of inputAdmissions.values()) for (const controller of controllers) controller.abort(new Error("Managed input stopped by runtime close"))
      const attempt = (async () => {
        const errors: unknown[] = []
        if (acceptedStopError !== undefined) errors.push(acceptedStopError)
        if (!cleanup.controls) {
          const stopped = await Promise.allSettled([...controls.values()].map(control => control.stopInputs()))
          controlFailures.push(...stopped.flatMap(result => result.status === "rejected" ? [result.reason] : []))
          const joined = await Promise.allSettled([...controlWork])
          controlFailures.push(...joined.flatMap(result => result.status === "rejected" ? [result.reason] : []))
          cleanup.controls = true
        }
        if (!cleanup.workpools) {
          try { manager.workpools.dispose(); cleanup.workpools = true } catch (error) { errors.push(error) }
        }
        if (!cleanup.launches) {
          try { await manager.settleLaunchesForShutdown?.(10_000); cleanup.launches = true } catch (error) { errors.push(error) }
        }
        if (cleanup.launches && !cleanup.suspended) {
          try {
            await retireChildren(parentID, "dispose")
            cleanup.suspended = true
          } catch (error) { errors.push(error) }
        }
        if (cleanup.suspended && !cleanup.notifications) {
          try { await closeNotificationOwners(); cleanup.notifications = true } catch (error) { errors.push(error) }
        }
        if (cleanup.suspended && cleanup.notifications) {
          if (!cleanup.lifecycle) { try { lifecycle.dispose?.(); cleanup.lifecycle = true } catch (error) { errors.push(error) } }
          if (!cleanup.runner) { try { await runner.dispose(); cleanup.runner = true } catch (error) { errors.push(error) } }
        }
        // These closers no longer depend on manager/store reads once all producers are joined.
        // Successful stages stay complete; a later close retries ONLY retained failed resources.
        if (cleanup.runner && cleanup.workpools && cleanup.notifications) {
          await acceptedOperations.join()
          if (!cleanup.observations) { try { observationStore.close(); cleanup.observations = true } catch (error) { errors.push(error) } }
          if (!cleanup.journal) { try { journal.close(); cleanup.journal = true } catch (error) { errors.push(error) } }
          if (!cleanup.releases) { try { releaseJournal.close(); cleanup.releases = true } catch (error) { errors.push(error) } }
          if (!cleanup.completionJournal) { try { await completionJournal?.close(); cleanup.completionJournal = true } catch (error) { errors.push(error) } }
          if (!cleanup.store) {
            try {
              baseStore.close()
              const retained = baseStore.residentFigures()
              if (retained.openEventLogs !== 0 || retained.cachedRecords !== 0) throw new Error("Owned store resources retained after close")
              cleanup.store = true
            } catch (error) { errors.push(error) }
          }
        }
        if (errors.length || controlFailures.length || notificationBindingFailures.length) {
          // Report accepted control-call errors once. Actual failed resources remain
          // represented by unfinished cleanup stages and retry on the next close.
          const reported = [...controlFailures.splice(0), ...notificationBindingFailures.splice(0)]
          throw new AggregateError([...reported, ...errors], "Native owned task cleanup incomplete")
        }
        if (!Object.values(cleanup).every(Boolean)) throw new Error("Native owned task cleanup incomplete")
        closed = true
      })()
      closeAttempt = attempt
      void attempt.finally(() => { if (!closed && closeAttempt === attempt) closeAttempt = undefined }).catch(() => {})
      return attempt
    },
  }
  await ensureNotificationOwner(bindings.root)
  options.scopes.assert(options.parent); options.initializationSignal?.throwIfAborted()
  return runtime
  } catch (error) {
    try { await closeInitialization() }
    catch (cleanupError) {
      const failure = new AggregateError([error, cleanupError], "Native task runtime initialization failed with retained resources")
      failedInitialization.set(failure, closeInitialization)
      throw failure
    }
    throw error
  }
}
