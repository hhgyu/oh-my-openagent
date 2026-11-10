import { assertCanonicalNativeTaskTarget } from "../../tools/native-task"
import { AsyncLocalStorage } from "node:async_hooks"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { ListedTool } from "../../host/tool-registry"
import { hasJoinedPermissionCancellation } from "../../host/effect-permission-api"
import type { IssuedToolCall, ToolCallAuthority } from "../../host/tool-kernel"
import type { VerifiedParentBinding } from "./parent-binding"
import type { SessionLease } from "../../host/session-state"
import { createNativeOwnedTaskRuntime, retainedNativeTaskInitializationCleanup, type NativeOwnedTaskRuntimeOptions } from "./runtime"
import type { OwnedTaskHost } from "./owned-runner"
import type { NativeOperationOwner } from "./operation-ports"
import { createHostBuildAuthorizer, type HostGrantPreparationInput } from "./host-grant"
import type { JoinedPermissionApi } from "../../host/effect-permission-api"
import { filterSharedParentTools } from "@oh-my-opencode/senpi-task/task-operations"
import type { ManagedStartSpec } from "@oh-my-opencode/senpi-task/manager-kernel"

const targetPermissionBrand: unique symbol = Symbol("Native task target permission")
export interface NativeTaskTargetPermission { readonly [targetPermissionBrand]: true }
export interface NativeTaskTargetPermissionAssociation { readonly tool: ListedTool; readonly permission: NativeTaskTargetPermission }
type TargetOwner = { assertCurrent(): void }
type TargetPermission = { owner: object; state: TargetOwner; tool: ListedTool; execute: ListedTool["execute"]; id: string; name: string }
const targetOwners = new WeakMap<object, TargetOwner>()
const targetPermissions = new WeakMap<NativeTaskTargetPermission, TargetPermission>()

/** Internal binder only. Only an actual service instance can mint associations. */
export function bindNativeTaskTargetPermission(permission: NativeTaskTargetPermission, original: ListedTool, lifetime: {
  readonly signal: AbortSignal; readonly assertCurrent: () => void
}) {
  const issued = targetPermissions.get(permission)
  if (!issued || issued.tool !== original) throw Error("Unissued or mismatched Native task permission")
  const assertCurrent = () => {
    lifetime.signal.throwIfAborted(); lifetime.assertCurrent()
    if (targetOwners.get(issued.owner) !== issued.state || original.execute !== issued.execute || original.id !== issued.id || original.name !== issued.name || !Object.isFrozen(original)) throw Error("Changed Native task permission target")
    issued.state.assertCurrent()
  }
  issued.state.assertCurrent()
  return Object.freeze({ permission, assertCurrent, assertOwner(owner: object) {
    assertCurrent()
    if (owner !== issued.owner || targetOwners.get(owner) !== issued.state) throw Error("Foreign Native task permission owner")
  } })
}

type Runtime = Awaited<ReturnType<typeof createNativeOwnedTaskRuntime>>
type Options = Omit<NativeOwnedTaskRuntimeOptions, "stateDir" | "parent" | "captureStartAuthority" | "initializationSignal" | "notification" | "authorizePlannedStart" | "authorizeRecovery"> & {
  readonly callAuthority: ToolCallAuthority
  stateDirFor(parentID: ToolContext["sessionID"]): string
  readonly hostGrant?: {
    readonly permission: JoinedPermissionApi
    assertCurrent(): void
    /** Current actual catalog facts. Recovery passes its rebuilt ManagedStartSpec and no plan. */
    preparationFor(spec: HostGrantPreparationInput["spec"] | ManagedStartSpec, plan: HostGrantPreparationInput["plan"] | undefined, signal: AbortSignal): Promise<Omit<HostGrantPreparationInput, "spec" | "plan" | "includeTaskTools" | "canonical">>
  }
}
interface Entry {
  readonly lease: SessionLease
  readonly root?: Entry
  readonly binding?: VerifiedParentBinding
  readonly stop: AbortController
  state: "open" | "closing" | "closed"
  runtime?: Runtime
  initializing?: Promise<Runtime>
  initializationCleanup?: () => Promise<void>
  retiring?: Promise<void>
  registryGeneration?: number
  notificationRootToken?: IssuedToolCall
  removeRetirement?: () => void
}

/** A component-owned lifetime for the SAME Native manager. No tools or caller contexts escape. */
export function createNativeTaskService(ctx: OwnedTaskHost, options: Options) {
  const entries = new Map<string, Entry>(), closedLeases = new WeakSet<SessionLease>()
  const hostAuthorizer = options.hostGrant && createHostBuildAuthorizer({ callAuthority: options.callAuthority,
    permission: options.hostGrant.permission, agents: ctx.agent, assertCurrent: () => options.hostGrant!.assertCurrent() })
  const targetBasis = { grant: options.hostGrant, permission: options.hostGrant?.permission,
    prepare: options.hostGrant?.preparationFor, current: options.hostGrant?.assertCurrent,
    guard: options.childToolGuard, bind: options.childGuardBinding }
  const assertTargetOwner = () => {
    if (closing || closed) throw Error("Native task permission owner is closing")
    if (!hostAuthorizer || !targetBasis.grant || !targetBasis.permission || !hasJoinedPermissionCancellation(targetBasis.permission) || !targetBasis.guard || typeof targetBasis.bind !== "function") throw Error("Native task permission requires owned G2 authorizer and G3 binding")
    if (options.hostGrant !== targetBasis.grant || options.hostGrant.permission !== targetBasis.permission || options.hostGrant.preparationFor !== targetBasis.prepare || options.hostGrant.assertCurrent !== targetBasis.current || options.childToolGuard !== targetBasis.guard || options.childGuardBinding !== targetBasis.bind) throw Error("Changed Native task permission owner configuration")
  }
  const targetState: TargetOwner = { assertCurrent() {
    assertTargetOwner()
    targetBasis.current!.call(targetBasis.grant)
    assertTargetOwner()
  } }
  const issuedTargets = new WeakMap<ListedTool, NativeTaskTargetPermission>()
  const invocation = new AsyncLocalStorage<{ token: IssuedToolCall; entry: Entry; bodySignal: AbortSignal; grantCall?: ReturnType<ReturnType<typeof createHostBuildAuthorizer>["forCall"]> }>()
  let closing = false, closed = false, closeAttempt: Promise<void> | undefined
  function open(entry: Entry) {
    if (closing || entry.state !== "open") throw new Error("Parent task service is closing")
    options.scopes.assert(entry.lease)
    entry.stop.signal.throwIfAborted()
  }
  function initialize(entry: Entry): Promise<Runtime> {
    open(entry)
    if (entry.runtime) return Promise.resolve(entry.runtime)
    if (entry.initializationCleanup) return Promise.reject(new Error("Parent task initialization retains failed cleanup"))
    if (entry.initializing) return entry.initializing
    if (entry.root) return initialize(entry.root)
    const rootToken = entry.notificationRootToken
    if (!rootToken) throw new Error("Parent task initialization has no original root notification basis")
    options.callAuthority.assert(rootToken, entry.lease)
    function currentInvocation() {
      const calling = invocation.getStore()
      if (!calling || (calling.entry.root ?? calling.entry) !== entry) throw new Error("Native start has no issued invocation for this root")
      options.callAuthority.assertCall(calling.token)
      options.callAuthority.assert(calling.token, calling.entry.lease)
      open(calling.entry); open(entry)
      return calling
    }
    const work = createNativeOwnedTaskRuntime(ctx, {
      stateDir: options.stateDirFor(entry.lease.sessionID), scopes: options.scopes, parent: entry.lease, policy: options.policy,
      metadataSource: options.metadataSource, config: options.config, agents: options.agents,
      initializationSignal: entry.stop.signal,
      ...(options.childToolGuard && { childToolGuard: options.childToolGuard }),
      ...(options.childGuardBinding && { childGuardBinding: options.childGuardBinding }),
      notification: { callAuthority: options.callAuthority, rootToken, captureCall: () => currentInvocation().token },
      ...(options.hostGrant && { authorizePlannedStart: async (spec: HostGrantPreparationInput["spec"], plan: HostGrantPreparationInput["plan"]) => {
        const original = currentInvocation(), grantCall = original.grantCall
        if (!grantCall || !spec.admission) throw Error("Original host-grant call/admission missing")
        original.bodySignal.throwIfAborted()
        const prepared = await options.hostGrant!.preparationFor(spec, plan, original.bodySignal)
        if (currentInvocation() !== original) throw Error("Original planned invocation changed")
        original.bodySignal.throwIfAborted(); spec.admission.assertOpen()
        return grantCall.authorize({ ...prepared, spec, plan,
          includeTaskTools: spec.admission.runRef.kind !== "dag", canonical: { filterSharedParentTools } }, original.bodySignal)
      },
      // Fresh recovery approval from THIS genuine current invocation only; never the stale
      // pre-reload custody. Without a current call this throws, so autonomous recovery refuses.
      authorizeRecovery: async (spec: ManagedStartSpec) => {
        const original = currentInvocation(), grantCall = original.grantCall
        if (!grantCall) throw Error("Original host-grant call missing for recovery")
        original.bodySignal.throwIfAborted()
        const prepared = await options.hostGrant!.preparationFor(spec, undefined, original.bodySignal)
        if (currentInvocation() !== original) throw Error("Original recovery invocation changed")
        original.bodySignal.throwIfAborted()
        return grantCall.authorizeRecovery({ ...prepared, spec, includeTaskTools: spec.includeTaskTools !== false, canonical: { filterSharedParentTools } }, original.bodySignal)
      } }),
      captureStartAuthority() {
        const calling = currentInvocation(), token = calling.token
        return Object.freeze({
          admissionSignal: AbortSignal.any([token.admissionSignal, entry.stop.signal, calling.entry.stop.signal]),
          lifetimeSignal: AbortSignal.any([token.lifetimeSignal, entry.stop.signal]),
          assertAdmission() { entry.stop.signal.throwIfAborted(); options.callAuthority.assert(token, calling.entry.lease); calling.entry.stop.signal.throwIfAborted(); token.assertAdmission() },
          assertLifetime() { entry.stop.signal.throwIfAborted(); options.callAuthority.assert(token, calling.entry.lease); token.assertLifetime() },
        })
      },
    }).then(runtime => { entry.runtime = runtime; return runtime }, error => {
      entry.initializationCleanup = retainedNativeTaskInitializationCleanup(error)
      throw error
    })
    entry.initializing = work
    void work.finally(() => { if (entry.initializing === work) entry.initializing = undefined }).catch(() => {})
    return work
  }
  function waitForInitialization(work: Promise<Runtime>, signals: readonly AbortSignal[]): Promise<Runtime> {
    return new Promise((resolve, reject) => {
      let settled = false
      const listeners: (() => void)[] = []
      function finish(result: () => void) {
        if (settled) return
        settled = true
        for (const remove of listeners) remove()
        result()
      }
      // Observe shared rejection even if this invocation has already stopped waiting.
      void work.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
      for (const signal of signals) {
        const abort = () => finish(() => reject(signal.reason))
        if (signal.aborted) { abort(); return }
        signal.addEventListener("abort", abort, { once: true })
        listeners.push(() => signal.removeEventListener("abort", abort))
        if (signal.aborted) { abort(); return }
      }
    })
  }
  async function retire(lease: SessionLease): Promise<void> {
    if (closedLeases.has(lease)) return
    const entry = entries.get(lease.sessionID)
    if (!entry || entry.lease !== lease) throw new Error("Unknown or foreign task service parent lease")
    if (entry.retiring) return entry.retiring
    entry.state = "closing"
    // Revoke admission, not cleanup custody: the actual parent lease stays live until joined.
    entry.stop.abort(new Error("Parent task service retiring"))
    const work = (async () => {
      if (entry.root) {
        const runtime = await initialize(entry.root)
        await runtime.releaseParent(entry.binding!)
        entry.removeRetirement?.(); entry.state = "closed"
        if (entries.get(lease.sessionID) === entry) entries.delete(lease.sessionID)
        return
      }
      if (entry.initializing) await entry.initializing.catch(() => {})
      if (entry.initializationCleanup) { await entry.initializationCleanup(); entry.initializationCleanup = undefined }
      if (entry.runtime) await entry.runtime.close()
      for (const [id, child] of entries) if (child.root === entry) { child.stop.abort(Error("Root task service retired")); child.removeRetirement?.(); child.state = "closed"; entries.delete(id) }
      options.scopes.assert(lease)
      entry.removeRetirement?.()
      options.scopes.retire(lease)
      entry.state = "closed"; closedLeases.add(lease)
      if (entries.get(lease.sessionID) === entry) entries.delete(lease.sessionID)
    })()
    entry.retiring = work
    void work.finally(() => { if (entry.state !== "closed" && entry.retiring === work) entry.retiring = undefined }).catch(() => {})
    return work
  }
  const service = Object.freeze({
    targetPermission(target: ListedTool): NativeTaskTargetPermission {
      targetState.assertCurrent()
      assertCanonicalNativeTaskTarget(target)
      if (!Object.isFrozen(target) || !["task", "task_output", "task_send", "task_cancel"].includes(target.name) || target.id !== `omo.native.${target.name}` || target.options !== undefined || typeof target.execute !== "function") throw Error("Noncanonical Native task permission target")
      if (issuedTargets.has(target)) throw Error("Duplicate Native task permission target")
      const permission = Object.freeze({}) as NativeTaskTargetPermission
      targetPermissions.set(permission, { owner: service, state: targetState, tool: target, execute: target.execute, id: target.id, name: target.name })
      issuedTargets.set(target, permission)
      return permission
    },
    /** Trusted outer genuine SDK callback only. This allocates no manager, planner or store. */
    async parent(caller: ToolContext): Promise<SessionLease> {
      caller.signal.throwIfAborted()
      if (closing) throw new Error("Task service is closing")
      const actual = await ctx.session.get({ sessionID: caller.sessionID }, { signal: caller.signal })
      caller.signal.throwIfAborted()
      if (actual.id !== caller.sessionID || actual.location.directory !== ctx.location.directory) throw Error("Foreign actual task caller")
      for (;;) {
        const previous = entries.get(caller.sessionID)
        if (!previous) break
        if (previous.root && previous.lease.signal.aborted) { previous.stop.abort(Error("Borrowed backend lease retired")); previous.removeRetirement?.(); previous.state = "closed"; entries.delete(caller.sessionID); continue }
        if (previous.state === "open") {
          if (previous.root) {
            const runtime = await initialize(previous.root)
            const binding = await runtime.verifyParent(caller.sessionID, caller.signal)
            if (binding !== previous.binding) throw Error("Borrowed caller generation changed")
          } else if (actual.parentID) throw Error("Root caller acquired an unexpected ancestor")
          open(previous); return previous.lease
        }
        if (!previous.retiring) throw Error("Parent task service cleanup remains incomplete")
        await previous.retiring
        caller.signal.throwIfAborted()
        if (closing) throw Error("Task service is closing")
      }
      if (actual.parentID) {
        const roots = [...entries.values()].filter(entry => !entry.root && entry.state === "open" && entry.runtime?.ownsSession(caller.sessionID))
        if (roots.length !== 1) throw Error("Nested caller has no unique owned root manager")
        const root = roots[0], runtime = root.runtime!
        const binding = await runtime.verifyParent(caller.sessionID, caller.signal), parent = runtime.parentInfo(binding, true)
        caller.signal.throwIfAborted(); open(root)
        const concurrent = entries.get(caller.sessionID)
        if (concurrent) {
          if (concurrent.state !== "open" || concurrent.root !== root || concurrent.binding !== binding) throw Error("Competing child parent adoption")
          return concurrent.lease
        }
        entries.set(caller.sessionID, { root, binding, lease: parent.lease, stop: new AbortController(), state: "open" })
        return parent.lease
      }
      // No await between final lookup and root mint; owned children NEVER pass this branch.
      const concurrent = entries.get(caller.sessionID)
      if (concurrent) { open(concurrent); return concurrent.lease }
      const lease = options.scopes.open(caller.sessionID, options.policy)
      entries.set(caller.sessionID, { lease, stop: new AbortController(), state: "open" })
      return lease
    },
    async forCall(caller: ToolContext) {
      const source = Object.freeze({ sessionID: caller.sessionID, agent: caller.agent, messageID: caller.messageID, id: caller.id })
      const progressIdentity = new WeakRef(caller.progress)
      const querySignal = caller.signal
      const token = options.callAuthority.capture(caller)
      options.callAuthority.assertCall(token)
      // Genuine capture occurs synchronously before shared runtime initialization.
      const grantCall = hostAuthorizer?.forCall(caller)
      const lease = options.callAuthority.parent(token), entry = entries.get(token.sessionID)
      if (!entry || entry.lease !== lease) throw new Error("Tool call does not name this service's parent")
      options.callAuthority.assert(token, entry.lease); open(entry)
      const root = entry.root ?? entry
      if (root.registryGeneration === undefined) {
        options.callAuthority.assert(token, root.lease)
        root.registryGeneration = token.registryGeneration
        root.notificationRootToken = token
        const onRetire = () => { void retire(root.lease).catch(() => { /* Retained owner is retried by explicit retire/close. */ }) }
        token.lifetimeSignal.addEventListener("abort", onRetire, { once: true })
        root.removeRetirement = () => token.lifetimeSignal.removeEventListener("abort", onRetire)
      } else if (root.registryGeneration !== token.registryGeneration) throw new Error("Retired service registry generation")
      const runtime = await waitForInitialization(initialize(root), [querySignal, entry.stop.signal, root.stop.signal])
      options.callAuthority.assertCall(token); options.callAuthority.assert(token, lease); open(entry)
      const parent = entry.binding ?? runtime.rootParent
      const bodySignal = AbortSignal.any([querySignal, entry.stop.signal, root.stop.signal, runtime.parentInfo(parent).stop.signal])
      const ownedEntry = entry
      function action<T>(operation: () => T): T {
        // A persistent admission token is NOT permission to initiate another call later.
        options.callAuthority.assertCall(token); options.callAuthority.assert(token, lease); open(ownedEntry)
        const result = invocation.run({ token, entry: ownedEntry, bodySignal, grantCall }, () => runtime.withParent(parent, operation))
        if (result && typeof result === "object" && "then" in result) return runtime.trackParent(parent, Promise.resolve(result)) as T
        return result
      }
      return Object.freeze({
        operation: <T>(run: (manager: Runtime["manager"], resolveAncestry: Runtime["resolveAncestry"], signal: AbortSignal, owner: NativeOperationOwner) => Promise<T>, reporting?: { progress: ToolContext["progress"] }) => action(() => {
          if (reporting && reporting.progress !== progressIdentity.deref()) throw Error("Foreign Native operation reporter")
          const owner = runtime.operationOwner(parent, {
            source, progress: reporting?.progress,
            acceptedSignal: AbortSignal.any([token.lifetimeSignal, entry.stop.signal, root.stop.signal]),
            reportingSignal: bodySignal,
            assertAction() { options.callAuthority.assertCall(token); token.assertAdmission(); open(ownedEntry) },
            assertLifetime() { options.callAuthority.assert(token, lease) },
          })
          let work: Promise<T>
          try { work = run(runtime.manager, runtime.resolveAncestry, bodySignal, owner) }
          catch (error) { work = Promise.reject(error) }
          return work.finally(async () => { owner.closeReporting(); await owner.joinReporting() })
        }),
        start: (spec: Parameters<Runtime["start"]>[0]) => action(() => runtime.start(spec)),
        send: (input: Parameters<Runtime["send"]>[0], extra?: { signal?: AbortSignal }) => action(() => runtime.send(input, { signal: extra?.signal ? AbortSignal.any([bodySignal, extra.signal]) : bodySignal })),
        wait: (id: string, signal?: AbortSignal) => action(() => runtime.wait(id, signal ? AbortSignal.any([bodySignal, signal]) : bodySignal)),
        get: (id: string) => action(() => runtime.get(id)),
        output: (input: Parameters<Runtime["output"]>[0]) => action(() => runtime.output(input)),
        cancel: (id: string) => action(() => runtime.cancel(id)),
        interrupt: (id: string) => action(() => runtime.interrupt(id)),
        end: (id: string) => action(() => runtime.end(id)),
        detach: (id: string) => action(() => runtime.detach(id)),
        recover: (id: string) => action(() => runtime.recover(id)),
      })
    },
    retire,
    close(): Promise<void> {
      if (closed) return Promise.resolve()
      if (closeAttempt) return closeAttempt
      closing = true
      const work = (async () => {
        const results = await Promise.allSettled([...entries.values()].filter(entry => !entry.root).map(entry => retire(entry.lease)))
        const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, "Task service cleanup incomplete")
        closed = true
      })()
      closeAttempt = work
      void work.finally(() => { if (!closed && closeAttempt === work) closeAttempt = undefined }).catch(() => {})
      return work
    },
  })
  targetOwners.set(service, targetState)
  return service
}
