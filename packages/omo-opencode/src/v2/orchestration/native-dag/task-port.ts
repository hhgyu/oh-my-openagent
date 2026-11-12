import type { DagRunId, DagTaskPort } from "@oh-my-opencode/senpi-task/dag"
import type { NativeOperationOwner } from "../native-task/operation-ports"
import { NativeDagRefusal } from "./refusals"

/** The DAG engine slice ONE `workflow` call lends to a run's scheduler, its control verbs and its
 * recovery, over that call's Native per-call operation. Never retained past the call: the held port
 * drops it when the call ends. */
export type NativeDagCallPort = DagTaskPort & {
  /** Native task's lazy restore of a child its previous runtime parked (or a dead host stranded),
   * under THIS call's fresh approval (S5e). True once a live control is installed. */
  restoreAfterReload(id: string): Promise<boolean>
  /** Whether THIS call's runtime owns the child, read without capturing it (D-1): a row a reload
   * parked or a dead host stranded answers false, and the call's `get` would refuse it. */
  isOwned(id: string): boolean
}

/** Every node start goes through THIS call's operation, so it uses this call's host authority.
 * Nodes run attached (`run_in_background:false`), exactly as the Native DAG runtime admits them. */
export function nativeDagCallPort(operation: Pick<NativeOperationOwner, "task" | "dag" | "send" | "recovery">): NativeDagCallPort {
  return Object.freeze({
    startOwned: (spec, owner) => operation.dag.startOwned({ ...spec, run_in_background: false }, owner),
    findOwnedTask: key => operation.dag.findOwnedTask(key),
    residencyChanged: parentSessionID => operation.dag.residencyChanged(parentSessionID),
    getResidentHandle: id => operation.recovery.residentHandle(id),
    restoreAfterReload: id => operation.recovery.restoreAfterReload(id),
    isOwned: id => operation.recovery.owned(id),
    get: id => operation.task.get(id),
    subscribeChild: (id, listener) => operation.task.subscribeChild(id, listener),
    waitFor: (id, options) => operation.task.waitFor(id, options),
    cancelTask: (id, reason, extra) => operation.task.cancelTask(id, reason, extra),
    // `send` steers or revives a node's child through THIS call's own scoped send port and its
    // receipts. The engine asks for all-scope authority; a DAG node child is an owned child of this
    // root, so it needs none, and the cross-parent request is dropped instead of widened.
    sendToTask: input => {
      const taskId = ownedNodeChild(operation, input.idOrName)
      const { allScope: _crossParent, callerSessionId: _caller, ...scoped } = input
      return operation.send.sendToTask({ ...scoped, idOrName: taskId })
    },
  } satisfies NativeDagCallPort)
}

function refuseForeignSend(taskId: string, scope: string): never {
  throw new NativeDagRefusal("node_not_found", `Task ${taskId} is not a node child of ${scope}, so workflow send does not reach it. Send targets only this run's own nodes.`)
}

/** Proves `taskId` is a DAG node child THIS root owns: its record names a DAG owner, and the owned
 * lookup of that owner key, which answers only inside this call's root, resolves to the same task. */
function ownedNodeChild(operation: Pick<NativeOperationOwner, "task" | "dag">, taskId: string): string {
  const record = operation.task.get(taskId), owner = record?.owner
  const owned = owner?.kind === "dag" ? operation.dag.findOwnedTask({ kind: "dag", runId: owner.runId, nodeId: owner.nodeId }) : undefined
  if (record === undefined || owned?.task_id !== record.task_id) refuseForeignSend(taskId, "this session's workflow runs")
  return record.task_id
}

/** Thrown into an admission that waited while no call was bound, once its scheduler retires. */
export class NativeDagAdmissionHeld extends Error {
  constructor() { super("DAG node admission is held: no workflow call is in progress") }
}

/** The scheduler's `DagTaskPort` for run `runId`. While a call is bound, every method delegates to
 * that call's port. Unbound, a node start is HELD (it waits and never touches the host) and every
 * other method refuses: there is no authority to act outside a call. A send reaches only a node
 * child of THIS run. */
export function createHeldDagTaskPort(runId: DagRunId) {
  let bound: NativeDagCallPort | undefined, starting = 0
  const waiting = new Set<{ resolve(call: NativeDagCallPort): void; reject(error: Error): void }>()
  function live(): NativeDagCallPort {
    if (!bound) throw new NativeDagAdmissionHeld()
    return bound
  }
  function admitted(): Promise<NativeDagCallPort> {
    if (bound) return Promise.resolve(bound)
    return new Promise((resolve, reject) => { waiting.add({ resolve, reject }) })
  }
  const port: DagTaskPort = Object.freeze({
    async startOwned(spec, owner) {
      const call = await admitted()
      starting++
      try { return await call.startOwned(spec, owner) } finally { starting-- }
    },
    findOwnedTask: key => live().findOwnedTask(key),
    get: id => live().get(id),
    subscribeChild: (id, listener) => live().subscribeChild(id, listener),
    waitFor: (id, options) => live().waitFor(id, options),
    cancelTask: (id, reason, extra) => live().cancelTask(id, reason, extra),
    residencyChanged: parentSessionID => live().residencyChanged(parentSessionID),
    getResidentHandle: id => live().getResidentHandle(id),
    sendToTask: input => {
      const call = live(), owner = call.get(input.idOrName)?.owner
      if (owner?.kind !== "dag" || owner.runId !== runId) refuseForeignSend(input.idOrName, `workflow run ${runId}`)
      return call.sendToTask(input)
    },
  } satisfies DagTaskPort)
  return Object.freeze({
    port,
    /** Lends `call` to the scheduler until the returned release runs. One call at a time. */
    bind(call: NativeDagCallPort): () => void {
      if (bound) throw Error("A workflow call already drives this run")
      bound = call
      for (const waiter of waiting) waiter.resolve(call)
      waiting.clear()
      return () => { if (bound === call) bound = undefined }
    },
    /** Number of node starts currently held for a call. */
    held: () => waiting.size,
    /** Number of node starts a bound call is performing right now. */
    starting: () => starting,
    /** Ends every held start once its scheduler is retiring; nothing reaches the host. */
    dropHeld(): void {
      for (const waiter of waiting) waiter.reject(new NativeDagAdmissionHeld())
      waiting.clear()
    },
  })
}
