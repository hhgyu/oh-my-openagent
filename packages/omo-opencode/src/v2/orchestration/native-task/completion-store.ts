import type { TaskManager, TaskRecord, TaskRecordStore } from "@oh-my-opencode/senpi-task/manager-kernel"
import { createCompletionObservingStore, createConfigGenerationStampingStore, createMutationNotifyingStore,
  type CompletionBridgeDeps, type CompletionNotifier, type StoreMutation, type TaskTerminalObservers } from "@oh-my-opencode/senpi-task/task-operations"
import type { createParentBindings, VerifiedParentBinding } from "./parent-binding"

export type CompletionParentState = ReturnType<CompletionBridgeDeps["parentState"]>
export interface TaskBirth {
  readonly taskId: string
  readonly createdAt: string
  readonly parentSessionId: string
  readonly rootSessionId: string
  readonly depth: number
}
export interface OpenStartCreationScope {
  readonly identity: object
  readonly open: boolean
  readonly onCreated: (birth: Readonly<TaskBirth>) => undefined
}
export interface ParentCompletionChannel {
  readonly binding: VerifiedParentBinding
  readonly parentSessionId: string
  readonly rootSessionId: string
  readonly notifier: CompletionNotifier
  readonly parentState: () => CompletionParentState | undefined
  readonly ownsTerminal: (record: TaskRecord) => boolean
  /** Must include actual known cached state AND source readiness; never a guessed idle. */
  readonly notificationReady: (record: TaskRecord) => boolean
  readonly onTerminal?: (record: TaskRecord) => void
}
export interface OwnedCompletionStoreOptions {
  readonly baseStore: TaskRecordStore
  readonly bindings: ReturnType<typeof createParentBindings>
  readonly channels: ReadonlyMap<VerifiedParentBinding, ParentCompletionChannel>
  readonly wasBackground: TaskManager["wasBackground"]
  readonly currentGeneration: () => number | undefined
  readonly terminalObservers?: TaskTerminalObservers
  readonly creationScope?: () => OpenStartCreationScope | undefined
}

/** Explicit forwarding retains the SAME base receiver, callbacks, owners and results. */
function forwardStore(backing: TaskRecordStore): TaskRecordStore {
  return {
    stateDir: backing.stateDir,
    save: record => backing.save(record),
    replace: record => backing.replace(record),
    mutate: (taskId, mutation) => backing.mutate(taskId, mutation),
    transition: (taskId, transition) => backing.transition(taskId, transition),
    load: taskId => backing.load(taskId),
    list: () => backing.list(),
    appendEvent: (taskId, event) => backing.appendEvent(taskId, event),
    remove: taskId => backing.remove(taskId),
    tombstoneIfExpired: (taskId, shouldRetain, owner) => backing.tombstoneIfExpired(taskId, shouldRetain, owner),
    completeExpunge: (taskId, owner) => backing.completeExpunge(taskId, owner),
    listExpunging: () => backing.listExpunging(),
    loadExpunging: taskId => backing.loadExpunging(taskId),
    restoreExpunging: (taskId, owner) => backing.restoreExpunging(taskId, owner),
    readExpungeOwner: taskId => backing.readExpungeOwner(taskId),
    takeOverExpunging: (taskId, from, to) => backing.takeOverExpunging(taskId, from, to),
  }
}

/** Private composition only: rows/births route observation, never mint task authority.
 * Runtime must supply actual issued channels and retain their lifetime through cleanup.
 * Canonical notifier bookkeeping must use baseStore, not this observed wrapper. */
export function createOwnedCompletionStore(options: OwnedCompletionStoreOptions) {
  const birthStore: TaskRecordStore = {
    ...forwardStore(options.baseStore),
    save(record) {
      const scope = options.creationScope?.()
      const identity = scope?.identity, callback = scope?.onCreated
      const originallyOpen = scope?.open === true
      // Copy before INSERT: neither the draft nor a later persisted-row lookup is a witness.
      const birth: Readonly<TaskBirth> = Object.freeze({ taskId: record.task_id, createdAt: record.created_at,
        parentSessionId: record.parent_session_id, rootSessionId: record.root_session_id, depth: record.depth })
      options.baseStore.save(record)
      if (!scope || !originallyOpen || options.creationScope?.() !== scope || scope.identity !== identity
        || scope.open !== true || scope.onCreated !== callback) return
      if (!callback) throw new TypeError("Creation scope has no onCreated callback")
      const result: unknown = callback.call(scope, birth)
      if (result !== undefined) throw new TypeError("Creation callback must return synchronous undefined", { cause: result })
    },
  }
  const wrappers = new WeakMap<ParentCompletionChannel, TaskRecordStore>()
  function observe(channel: ParentCompletionChannel, binding: VerifiedParentBinding): TaskRecordStore {
    const cached = wrappers.get(channel)
    if (cached) return cached
    // Immutable association for this channel's lifetime. Changes require a NEW channel object.
    const { parentSessionId, rootSessionId, notifier, parentState, ownsTerminal, notificationReady, onTerminal } = channel
    const matches = (record: TaskRecord) => options.bindings.get(parentSessionId) === binding
      && options.channels.get(binding) === channel && channel.binding === binding
      && channel.parentSessionId === parentSessionId && channel.rootSessionId === rootSessionId
      && channel.notifier === notifier && channel.parentState === parentState
      && channel.ownsTerminal === ownsTerminal && channel.notificationReady === notificationReady && channel.onTerminal === onTerminal
      && record.parent_session_id === parentSessionId && record.root_session_id === rootSessionId
    const observed = createCompletionObservingStore(birthStore, {
      notifier,
      currentSessionId: () => parentSessionId,
      wasBackground: taskId => options.wasBackground(taskId),
      parentState() {
        const state = parentState.call(channel)
        if (state === undefined) throw new TypeError("Notification ready but original parent state is unknown")
        return state
      },
      ownsTerminal(record) {
        if (!matches(record)) return false
        const owned: unknown = ownsTerminal.call(channel, record)
        if (typeof owned !== "boolean") throw new TypeError("Terminal predicate must return a synchronous boolean", { cause: owned })
        if (!owned || !matches(record)) return false
        // Proof errors propagate EXACTLY after commit; a false known-ownership result
        // above does not call a retired private control/journal proof.
        const parent = options.bindings.info(binding)
        return matches(record) && parent.lease.sessionID === parentSessionId && parent.rootSessionId === rootSessionId
      },
      notificationReady: record => notificationReady.call(channel, record),
      ...(onTerminal === undefined ? {} : { onTerminal: (record: TaskRecord) => onTerminal.call(channel, record) }),
    })
    wrappers.set(channel, observed)
    return observed
  }
  function select(taskId: string): TaskRecordStore {
    // An index hint ONLY. All effects validate the ACTUAL post-write returned row.
    const candidate = options.baseStore.load(taskId)
    if (!candidate) return birthStore
    const binding = options.bindings.get(candidate.parent_session_id)
    if (!binding) return birthStore
    const channel = options.channels.get(binding)
    if (!channel || channel.binding !== binding || channel.parentSessionId !== candidate.parent_session_id) return birthStore
    return observe(channel, binding)
  }
  const routed: TaskRecordStore = {
    ...birthStore,
    mutate: (taskId, mutation) => select(taskId).mutate(taskId, mutation),
    transition: (taskId, transition) => select(taskId).transition(taskId, transition),
  }
  const listeners = new Set<(change: StoreMutation) => void>()
  const store = createMutationNotifyingStore(createConfigGenerationStampingStore(routed, () => options.currentGeneration()), change => {
    for (const listener of listeners) listener(change)
  }, options.terminalObservers)
  return { store, onMutation(listener: (change: StoreMutation) => void) { listeners.add(listener); return () => { listeners.delete(listener) } } }
}
