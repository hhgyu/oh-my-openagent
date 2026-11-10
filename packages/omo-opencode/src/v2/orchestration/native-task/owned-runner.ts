import type { Context } from "@opencode/plugin/promise/plugin"
import type { EffectSessionBackendApi } from "../../host/effect-session-backend-api"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { RunnerError, type ManagedRunner, type ManagedStartSpec, type TaskRecord, type TaskRecordStore } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { DurableChildJournal } from "../../host/child-journal"
import { createSessionBackend, type SessionBackendApi } from "../../host/session-backend"
import type { SessionLease, SessionScopes, SessionToolPolicy } from "../../host/session-state"
import { createOwnedChildObserver } from "../../host/owned-child-observer"
import type { OwnedChildObservationStore } from "../../host/owned-child-observation-types"
import type { OwnedToolMetadataSource } from "../../host/effect-tool-metadata-source"
import type { OwnedChildToolGuard, ChildGuardApproval, ChildGuardBinding } from "../../host/owned-child-tool-guard"
import { checkHostGrantTarget, type PreparedHostTaskGrant } from "./host-grant"
import type { createOwnedTaskPlanner } from "./planner"
import { createOwnedTaskHandle, type OwnedTaskControl } from "./owned-handle"
import { createGuardCustody, type GuardClaim } from "./owned-guard-custody"

export type OwnedTaskHost = Omit<Context, "session"> & { readonly session: Context["session"] & EffectSessionBackendApi }
export interface OwnedRunnerOptions {
  ctx: OwnedTaskHost; journal: DurableChildJournal; store: TaskRecordStore; stateDir: string;
  parent: SessionLease; scopes: SessionScopes; policy: SessionToolPolicy;
  planner: ReturnType<typeof createOwnedTaskPlanner>; metadataSource: OwnedToolMetadataSource; observationStore: OwnedChildObservationStore;
  parentForSpec?(spec: ManagedStartSpec, recovery: boolean): Promise<{ parent: SessionLease; policy: SessionToolPolicy }>
  parentForRecord?(record: TaskRecord): Promise<{ parent: SessionLease; policy: SessionToolPolicy }>
  beforeLeaseRetire?: Parameters<typeof createSessionBackend>[1]["beforeLeaseRetire"]
  assertAdmission(): void
  installed(control: OwnedTaskControl): void
  readonly childGuard?: { readonly owner: OwnedChildToolGuard; forSpec(spec: ManagedStartSpec): {
    readonly approval: ChildGuardApproval; readonly buildAgentID: string; assertLifetime(): void
    /** Stage admission of the SAME approval: original Native admission, or a fresh recovery action. */
    assertStageAdmission?(): void
    readonly selection: PreparedHostTaskGrant; readonly coverage?: ChildGuardBinding["coverage"]
    bind(child: Awaited<ReturnType<ReturnType<typeof createSessionBackend>["stage"]>>, assertBackendCurrent: () => void): ChildGuardBinding
  } }
}
export function createOwnedManagedRunner(options: OwnedRunnerOptions) {
  const backends = new Set<ReturnType<typeof createSessionBackend>>()
  const custody = createGuardCustody({ owner: () => { if (!options.childGuard) throw Error("Owned runner has no child guard owner"); return options.childGuard.owner }, journal: options.journal, scopes: options.scopes, hostVersion: options.ctx.app.version, location: options.ctx.location.directory })
  const guardClaims = custody.claims, stopGuard = custody.stop, releaseGuard = custody.release
  const retainedCleanup = new Map<string, { backend: ReturnType<typeof createSessionBackend>; child?: Awaited<ReturnType<ReturnType<typeof createSessionBackend>["recover"]>> }>()
  async function closeRetained(record: TaskRecord) {
    await stopGuard(guardClaims.get(record.owned_session?.journalKey ?? ""))
    const selectedParent = options.parentForRecord ? await options.parentForRecord(record) : { parent: options.parent, policy: options.policy }
    const parent = selectedParent.parent
    options.scopes.assert(parent)
    const reference = record.owned_session
    if (!reference || record.parent_session_id !== parent.sessionID || reference.parentID !== parent.sessionID ||
      reference.format !== 1 || reference.backendID !== "omo-native-task-opencode" || reference.hostVersion !== options.ctx.app.version || record.spawn_spec?.cwd !== reference.location) {
      throw new Error("Foreign retained task cleanup reference")
    }
    const row = await options.journal.read(reference.journalKey)
    options.scopes.assert(parent)
    if (!row || row.locator.format !== 1 || row.locator.backendID !== reference.backendID || row.locator.hostVersion !== reference.hostVersion ||
      row.locator.parentID !== reference.parentID || row.locator.sessionID !== reference.sessionID || row.locator.location !== reference.location ||
      row.locator.generation < reference.generation || row.revision < reference.journalRevision) throw new Error("Retained cleanup journal identity differs from task reference")
    let retained = retainedCleanup.get(reference.journalKey)
    // A confirmed exact closed row is a cleanup receipt, never an execution-revival capability.
    if (row.phase === "closed") {
      if (retained) { await retained.backend.dispose(); backends.delete(retained.backend); retainedCleanup.delete(reference.journalKey) }
      await releaseGuard(guardClaims.get(reference.journalKey))
      return
    }
    if (!retained) {
      const backend = createSessionBackend({ app: options.ctx.app, location: { directory: reference.location }, session: options.ctx.session }, {
        backendID: reference.backendID, owner: options.journal.owner, parent, scopes: options.scopes,
        policy: selectedParent.policy, journal: options.journal, beforeLeaseRetire: options.beforeLeaseRetire, gate: { assertActive() { options.scopes.assert(parent) } },
      })
      backends.add(backend)
      retained = { backend }
      retainedCleanup.set(reference.journalKey, retained)
    }
    // No planner, observer, prompt or ManagedChildHandle is involved in cleanup custody.
    retained.child ??= await retained.backend.recoverForCleanup(reference.journalKey)
    await retained.backend.close(retained.child)
    await retained.backend.dispose()
    backends.delete(retained.backend)
    retainedCleanup.delete(reference.journalKey)
    await releaseGuard(guardClaims.get(reference.journalKey))
  }
  async function stage(spec: ManagedStartSpec, recoveringKey?: string): Promise<OwnedTaskControl> {
    const selectedParent = options.parentForSpec ? await options.parentForSpec(spec, recoveringKey !== undefined) : { parent: options.parent, policy: options.policy }
    const parent = selectedParent.parent, parentPolicy = selectedParent.policy
    // The runtime resolves this ONLY from its original private G2 admission.
    // Rebuilt persisted names do not create a recovery execution approval.
    const guarded = options.childGuard?.forSpec(spec)
    let guardClaim: GuardClaim | undefined
    if (!recoveringKey) {
      options.assertAdmission()
      if (!spec.admission?.hostAuthority) throw new RunnerError({ kind: "session_unavailable", message: "Owned first input requires its captured host authority" })
      spec.admission.assertOpen()
    }
    if (parent.sessionID !== spec.parentSessionId) throw new Error("Foreign parent task start")
    options.scopes.assert(parent)
    let assertBound: (() => void) | undefined
    let tools: readonly string[], policy: SessionToolPolicy
    if (guarded) {
      guarded.assertLifetime()
      const targets = [...guarded.selection.selected.map(pair => pair.hostID), ...(guarded.coverage?.targets ?? []).map(pair => pair.hostID)]
      const covered = new Set(guarded.coverage?.boundRequirements)
      const missing = guarded.selection.requirements.some(requirement => !covered.has(requirement)) || guarded.selection.bindingSlots.some(slot => !(guarded.coverage?.targets ?? []).some(target => target.requirement === slot.requirement && target.nativeName === slot.nativeName && target.hostID))
      if (missing || targets.some(id => checkHostGrantTarget(guarded.selection, id, guarded.coverage) !== "selected")) throw new RunnerError({ kind: "tools_unavailable", message: "Original live child grant bindings are incomplete" })
      tools = [...new Set([...targets, ...(guarded.selection.allowsCodeModeTransport ? ["execute"] : [])])]
      policy = { tools, authorize(call) {
        guarded.assertLifetime(); if (!assertBound) throw Error("Original child guard binding not installed")
        assertBound()
        if (!tools.includes(call.requested) || !tools.includes(call.routed)) throw Error("Child tool outside approved actual SDK identifiers")
      } }
    } else {
      if (spec.kernelTools || spec.memberScopedTools?.length) throw new RunnerError({ kind: "session_unavailable", message: "Native live kernel/member tool grant is not bound to this owned host" })
      const allowed = spec.toolAllowlist ?? parentPolicy.tools
      if (allowed.some(name => !parentPolicy.tools.includes(name))) throw new RunnerError({ kind: "session_unavailable", message: "Task tool allowlist names unavailable host capabilities" })
      const denied = new Set(spec.toolDenylist)
      tools = allowed.filter(name => !denied.has(name))
      policy = { tools, authorize: parentPolicy.authorize }
    }
    let firstInputPending = recoveringKey === undefined
    const firstInput = () => {
      if (!firstInputPending) return
      if (!spec.admission?.hostAuthority) throw new Error("Owned first input authority missing")
      spec.admission.assertOpen()
    }
    const prompt: SessionBackendApi["prompt"] = (...args) => {
      // Last same-stack boundary before the genuine joined RPC is invoked. Once sent,
      // an initiating invocation's signal cannot cancel an already-admitted child lifetime.
      firstInput()
      spec.admission?.assertOpen()
      firstInputPending = false
      return options.ctx.session.prompt(...args)
    }
    const host = { app: options.ctx.app, location: { directory: spec.cwd }, session: { ...options.ctx.session, prompt } }
    const backend = createSessionBackend(host, { backendID: "omo-native-task-opencode", owner: options.journal.owner, parent,
      scopes: options.scopes, policy, journal: options.journal, beforeLeaseRetire: options.childGuard ? async (child, intent) => { await stopGuard(guardClaim); await options.beforeLeaseRetire?.(child, intent) } : options.beforeLeaseRetire,
      // Guarded detach PARKS durably (Native suspend semantics), never ends the child.
      ...(guarded && { parking: { join: () => stopGuard(guardClaim) } }), gate: { assertActive() { if (recoveringKey) options.scopes.assert(parent); else { options.assertAdmission(); firstInput() } } } })
    backends.add(backend)
    const record = options.store.load(spec.taskId)
    if (!record) throw new Error("Task record missing before owned child stage")
    const journalKey = recoveringKey ?? `${spec.taskId}:${record.notification.run_epoch}`
    let child: Awaited<ReturnType<typeof backend.stage>> | undefined
    let restoring = false
    let instructions: { dispose(): Promise<void> | void } | undefined
    let observer: Awaited<ReturnType<typeof createOwnedChildObserver>> | undefined
    try {
      // Refuse a missing/mismatched run selection BEFORE claiming or touching the retained child.
      const selectedRow = recoveringKey ? await options.journal.read(journalKey) : undefined
      // A parked child is reacquired ONLY under a fresh guarded approval, then restored below.
      restoring = guarded !== undefined && (selectedRow?.parking?.state === "parked" || selectedRow?.parking?.state === "restoring")
      if (recoveringKey && (selectedRow?.turn ? selectedRow.turn.nativeEpoch !== record.notification.run_epoch : record.notification.run_epoch !== 0)) throw new Error("Owned recovered turn descriptor is unavailable or mismatched")
      const model = recoveringKey ? undefined : options.planner.binding({ model: spec.model ?? record.model, resolved_model: spec.resolvedModel, variant: spec.variant })
      const candidateID = recoveringKey ? selectedRow?.locator.sessionID : `ses_native_${randomUUID().replaceAll("-", "")}` as SessionLease["sessionID"]
      if (guarded) {
        if (!candidateID || guardClaims.has(journalKey)) throw Error("Original guard stage cleanup/recovery claim is still retained")
        const token = custody.begin(guarded.approval, candidateID, guarded.assertStageAdmission ?? (() => {
          if (!spec.admission?.hostAuthority) throw Error("Stage has no original Native admission")
          spec.admission.assertOpen()
        }), restoring)
        const claim: GuardClaim = { token, sessionID: candidateID, parent, key: journalKey, hooksClosed: false, released: false,
          parkedReceipt: () => child && backend.parkedReceipt(child), assertParked: (receipt, issued) => backend.assertParked(receipt, issued) }
        guardClaim = claim
        claim.closeHooks = async () => {
          const cleaned = await Promise.allSettled([Promise.resolve().then(() => instructions?.dispose()), Promise.resolve().then(() => observer?.dispose())])
          if (cleaned.some(result => result.status === "rejected")) throw new AggregateError(cleaned.flatMap(result => result.status === "rejected" ? [result.reason] : []), "Original child registrations cleanup incomplete")
          claim.hooksClosed = true
        }
        guardClaims.set(journalKey, claim)
      }
      if (recoveringKey) child = await backend.recover(journalKey, { restoreParked: restoring })
      else {
        if (!candidateID) throw Error("Native task stage has no candidate session")
        child = await backend.stage({ key: journalKey, sessionID: candidateID, agent: guarded?.buildAgentID ?? "build", model }, { signal: spec.admission?.hostSignal?.() })
      }
      if (guarded && guardClaim) {
        const originalCurrent = backend.observationGuard(child)
        const binding = guarded.bind(child, originalCurrent)
        if (binding.child !== child || binding.agent !== guarded.buildAgentID) throw Error("Guard binding differs from actual approved child")
        assertBound = () => { guarded.assertLifetime(); originalCurrent(); binding.assertCurrent() }
        if (!options.childGuard) throw Error("Owned runner has no child guard owner")
        options.childGuard.owner.bind(guardClaim.token, { ...binding, child, agent: guarded.buildAgentID, assertCurrent: assertBound })
      }
      firstInput()
      const ownedChild = child
      // Public context hook carries actual model instructions and tool exposure. It is scoped
      // to this exact issued child, installed before any input, and joined on disposal.
      instructions = await options.ctx.session.hook("context", context => {
        if (context.sessionID !== ownedChild.locator.sessionID) return
        backend.observationGuard(ownedChild)()
        if (spec.instructions) context.system.push({ type: "text", text: spec.instructions })
        for (const name of Object.keys(context.tools)) if (!tools.includes(name)) delete context.tools[name]
      })
      firstInput()
      const currentRow = await options.journal.read(journalKey)
      const openObserver = (key: string, signal: AbortSignal) => createOwnedChildObserver(options.ctx, { key, child: ownedChild, guard: backend.observationGuard(ownedChild),
        store: options.observationStore,
        title: `Native task ${spec.taskId}`, completion: "final-text", toolMetadataSource: options.metadataSource, signal: AbortSignal.any([parent.signal, signal]) })
      observer = await openObserver(currentRow?.turn?.observationKey ?? journalKey, parent.signal)
      firstInput()
      // New guard generation, producer bindings, context policy and observer are installed:
      // only now lift OUR deny rule and marker. Conflict refuses with the host deny retained.
      if (restoring) {
        if (!guarded) throw Error("Parked restore requires the original guard approval")
        await backend.restoreParked(ownedChild, guarded.buildAgentID)
      }
      const control = await createOwnedTaskHandle({ spec, child: ownedChild, backend, journal: options.journal, observer, store: options.store, journalKey, stateDir: options.stateDir, openObserver, closeRetained,
        recovered: recoveringKey !== undefined,
        firstInputAccepted: () => spec.admission?.hostAccepted?.() })
      const detach = control.detach, end = control.end, prepareEnd = control.prepareEnd
      let hookClose: Promise<void> | undefined
      let hooksClosed = false, endCompleted = false
      function closeHooks(): Promise<void> {
        if (hooksClosed) return Promise.resolve()
        if (hookClose) return hookClose
        const pending = Promise.resolve().then(() => instructions?.dispose()).then(() => { hooksClosed = true })
        hookClose = pending
        void pending.catch(() => { if (hookClose === pending) hookClose = undefined })
        return pending
      }
      const retainedClaim = guardClaim
      if (retainedClaim) retainedClaim.closeHooks = async () => { await closeHooks(); retainedClaim.hooksClosed = true }
      const originalDispose = control.handle.dispose
      control.handle.dispose = async () => { await stopGuard(guardClaim); await originalDispose(); await closeHooks(); if (guardClaim) guardClaim.hooksClosed = true; await custody.retireParked(guardClaim) }
      control.detach = async () => { await stopGuard(guardClaim); await detach(); await closeHooks(); if (guardClaim) guardClaim.hooksClosed = true; await custody.retireParked(guardClaim) }
      control.end = async () => { await stopGuard(guardClaim); await end(); endCompleted = true; await closeHooks(); if (guardClaim) guardClaim.hooksClosed = true; await releaseGuard(guardClaim) }
      control.prepareEnd = async () => {
        if (!endCompleted) return prepareEnd()
        // The actual child/observer end succeeded, but the owned policy registration
        // may still need retry. Its retired execution handle is not a new run capability.
        options.scopes.assert(parent)
        const current = options.store.load(spec.taskId), ref = current?.owned_session
        if (!current || !ref || current.parent_session_id !== parent.sessionID || ref.parentID !== parent.sessionID
          || ref.format !== ownedChild.locator.format || ref.backendID !== ownedChild.locator.backendID || ref.location !== ownedChild.locator.location
          || ref.hostVersion !== ownedChild.locator.hostVersion || ref.sessionID !== ownedChild.locator.sessionID || ref.generation !== ownedChild.locator.generation || ref.journalKey !== journalKey
          || ref.journalOwner !== options.journal.owner || ref.runEpoch !== current.notification.run_epoch || ref.residencyClaim !== current.residency_claim) throw new Error("Closed task registration custody changed")
        await backend.confirmClosed(ownedChild)
        const actual = await options.journal.read(journalKey), fresh = options.store.load(spec.taskId)
        options.scopes.assert(parent)
        if (!actual || actual.phase !== "closed" || actual.owner !== ref.journalOwner || actual.revision < ref.journalRevision
          || fresh?.parent_session_id !== current.parent_session_id || fresh.notification.run_epoch !== ref.runEpoch || fresh.residency_claim !== ref.residencyClaim
          || JSON.stringify(fresh.owned_session) !== JSON.stringify(ref)) throw new Error("Closed task registration fence moved")
        await closeHooks(); if (guardClaim) guardClaim.hooksClosed = true
        await releaseGuard(guardClaim)
      }
      control.handle.terminate = control.end
      options.installed(control)
      return control
    } catch (error) {
      const guardCleanup = await Promise.allSettled([stopGuard(guardClaim)])
      const cleanup = await Promise.allSettled([Promise.resolve().then(() => instructions?.dispose()), Promise.resolve().then(() => observer?.dispose())])
      const failures: unknown[] = [...guardCleanup, ...cleanup].flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (guardClaim && cleanup.every(result => result.status === "fulfilled")) guardClaim.hooksClosed = true
      // A failed restore never ends the preserved SDK child: it re-parks (or keeps conflict custody).
      let conflicted = false
      try { if (child) await (restoring ? backend.detach(child) : backend.close(child)) } catch (failure) {
        failures.push(failure)
        // Conflict: release only local custody. The host child, its current rules and the
        // durable conflict stay as observed; the unretired guard claim awaits explicit END.
        if (restoring && child && parkingState(backend, child) === "conflict") { conflicted = true; try { await backend.relinquishConflict(child) } catch (release) { failures.push(release) } }
      }
      try { await backend.dispose() } catch (failure) { failures.push(failure) }
      if (!failures.length) try { await (restoring ? custody.finish(guardClaim) : releaseGuard(guardClaim)) } catch (failure) { failures.push(failure) }
      if (conflicted) throw new AggregateError([error, ...failures], "Parked child restore conflict; host rules preserved and custody retained for explicit END")
      if (failures.length) throw new AggregateError([error, ...failures], "Owned unadmitted cleanup incomplete")
      throw error
    }
  }
  const runner: ManagedRunner = {
    async start() { throw new Error("Owned tasks require guarded staged creation") },
    async startStaged(spec) {
      const control = await stage(spec)
      return { child: control.handle, firstPrompt: spec.prompt, begin: () => control.begin() }
    },
  }
  return { runner, closeRetained, recover: (spec: ManagedStartSpec, key: string) => stage(spec, key), async dispose() {
    const stopping = await Promise.allSettled([...guardClaims.values()].map(stopGuard))
    const results = await Promise.allSettled([...backends].map(backend => backend.dispose()))
    const released = await Promise.allSettled([...guardClaims.values()].map(custody.finish))
    if ([...stopping, ...results, ...released].some(result => result.status === "rejected")) throw new Error("Owned backend/guard cleanup incomplete")
  } }
}
function parkingState(backend: ReturnType<typeof createSessionBackend>, child: Parameters<ReturnType<typeof createSessionBackend>["currentRecord"]>[0]) {
  try { return backend.currentRecord(child).parking?.state } catch { return undefined }
}
