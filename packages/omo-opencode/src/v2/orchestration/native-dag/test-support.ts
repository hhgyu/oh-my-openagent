import type { DagTaskOwner, OwnedStartResult } from "@oh-my-opencode/senpi-task/dag"
import type { ManagerStartSpec, TaskRecord } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { NativeOperationOwner } from "../native-task/operation-ports"

type Operation = Pick<NativeOperationOwner, "task" | "dag">

/** A fake Native per-call operation for DAG tests: owned starts are recorded, children finish only
 * when the test completes them, and a revoked operation refuses like a returned call does. */
export function createFakeDagOperation(parentSessionID: string) {
  const starts: { readonly nodeId: string; readonly spec: ManagerStartSpec }[] = []
  const tasks = new Map<string, { record: TaskRecord; readonly done: PromiseWithResolvers<TaskRecord> }>()
  const startedSignals = new Map<string, PromiseWithResolvers<void>>()
  let revoked = false
  function live() { if (revoked) throw Error("Native operation callback is closed") }
  function byNode(nodeId: string) { return [...tasks.values()].find(entry => entry.record.owner?.nodeId === nodeId) }
  async function startOwned(spec: ManagerStartSpec, owner: DagTaskOwner): Promise<OwnedStartResult> {
    live()
    const nodeId = String(owner.nodeId), taskId = `task-${tasks.size + 1}`
    const at = "2026-11-11T00:00:00.000Z"
    tasks.set(taskId, { done: Promise.withResolvers<TaskRecord>(), record: {
      task_id: taskId, name: nodeId, parent_session_id: parentSessionID, root_session_id: parentSessionID, depth: 1,
      category: "quick", execution_mode: "in-process", model: "fake-model", notify_on_terminal: true, owner,
      status: "running", residency_state: "resident", created_at: at, updated_at: at, notification: { run_epoch: 1, notified_epoch: 0 },
    } })
    starts.push({ nodeId, spec })
    startedSignals.get(nodeId)?.resolve()
    return { kind: "started", reused: false, task_id: taskId, status: "running", name: nodeId }
  }
  const fake = {
    dag: {
      startOwned,
      findOwnedTask: (key: { readonly nodeId: string }) => { live(); return byNode(String(key.nodeId))?.record },
      residencyChanged: () => { live(); return new Promise<void>(() => {}) },
    },
    task: {
      get: (id: string) => { live(); return tasks.get(id)?.record },
      subscribeChild: () => { live(); return () => {} },
      waitFor: (id: string) => {
        live()
        const entry = tasks.get(id)
        if (!entry) throw Error(`unknown fake task ${id}`)
        return entry.done.promise
      },
      cancelTask: () => Promise.reject(Error("cancel is not part of this fake")),
    },
  }
  return {
    // The fake implements only the slice the DAG call port reads.
    operation: fake as unknown as Operation,
    starts,
    whenStarted(nodeId: string): Promise<void> {
      if (starts.some(start => start.nodeId === nodeId)) return Promise.resolve()
      const signal = startedSignals.get(nodeId) ?? Promise.withResolvers<void>()
      startedSignals.set(nodeId, signal)
      return signal.promise
    },
    complete(nodeId: string): void {
      const entry = byNode(nodeId)
      if (!entry) throw Error(`no fake task for ${nodeId}`)
      entry.record = { ...entry.record, status: "completed", final_response: `done ${nodeId}`, updated_at: "2026-11-11T00:00:01.000Z" }
      entry.done.resolve(entry.record)
    },
    /** Shares this operation's children with a later call's operation, like one runtime's manager. */
    adopt(other: { readonly tasksFrom: () => Map<string, { record: TaskRecord; readonly done: PromiseWithResolvers<TaskRecord> }> }): void {
      for (const [id, entry] of other.tasksFrom()) tasks.set(id, entry)
    },
    tasksFrom: () => tasks,
    revoke(): void { revoked = true },
  }
}
