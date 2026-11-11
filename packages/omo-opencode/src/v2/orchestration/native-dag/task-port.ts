import type { DagTaskPort } from "@oh-my-opencode/senpi-task/dag"
import type { NativeOperationOwner } from "../native-task/operation-ports"

/** The DAG engine slice ONE `workflow` call lends to a run's scheduler, over that call's Native
 * per-call operation. Never retained past the call: the held port drops it when the call ends. */
export type NativeDagCallPort = Omit<DagTaskPort, "getResidentHandle" | "sendToTask">

/** Every node start goes through THIS call's operation, so it uses this call's host authority.
 * Nodes run attached (`run_in_background:false`), exactly as the Native DAG runtime admits them. */
export function nativeDagCallPort(operation: Pick<NativeOperationOwner, "task" | "dag">): NativeDagCallPort {
  return Object.freeze({
    startOwned: (spec, owner) => operation.dag.startOwned({ ...spec, run_in_background: false }, owner),
    findOwnedTask: key => operation.dag.findOwnedTask(key),
    residencyChanged: parentSessionID => operation.dag.residencyChanged(parentSessionID),
    get: id => operation.task.get(id),
    subscribeChild: (id, listener) => operation.task.subscribeChild(id, listener),
    waitFor: (id, options) => operation.task.waitFor(id, options),
    cancelTask: (id, reason, extra) => operation.task.cancelTask(id, reason, extra),
  } satisfies NativeDagCallPort)
}

/** Thrown into an admission that waited while no call was bound, once its scheduler retires. */
export class NativeDagAdmissionHeld extends Error {
  constructor() { super("DAG node admission is held: no workflow call is in progress") }
}

/** The scheduler's `DagTaskPort` for one run. While a call is bound, every method delegates to that
 * call's port. Unbound, a node start is HELD (it waits and never touches the host) and every other
 * method refuses: there is no authority to act outside a call. */
export function createHeldDagTaskPort() {
  let bound: NativeDagCallPort | undefined
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
    async startOwned(spec, owner) { return (await admitted()).startOwned(spec, owner) },
    findOwnedTask: key => live().findOwnedTask(key),
    get: id => live().get(id),
    subscribeChild: (id, listener) => live().subscribeChild(id, listener),
    waitFor: (id, options) => live().waitFor(id, options),
    cancelTask: (id, reason, extra) => live().cancelTask(id, reason, extra),
    residencyChanged: parentSessionID => live().residencyChanged(parentSessionID),
    getResidentHandle() { throw Error("Resident DAG node handles arrive with workflow recovery (S6f)") },
    sendToTask() { return Promise.reject(Error("Sending to a DAG node arrives with workflow controls (S6e)")) },
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
    /** Ends every held start once its scheduler is retiring; nothing reaches the host. */
    dropHeld(): void {
      for (const waiter of waiting) waiter.reject(new NativeDagAdmissionHeld())
      waiting.clear()
    },
  })
}
