import { join } from "node:path"
import type { DagLeasePort, DagRunId, DagTaskOwner, DagTaskOwnerKey, OwnedStartResult } from "@oh-my-opencode/senpi-task/dag"
import type { DagToolInput } from "@oh-my-opencode/senpi-task/dag-operations"
import type { ManagerStartSpec, TaskRecord } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { NativeOperationOwner } from "../native-task/operation-ports"
import { createNativeDagRuntime } from "./runtime"
import { nativeDagCallPort } from "./task-port"
import { createNativeDagWakeOwner } from "./wake"
import { runNativeWorkflow } from "./workflow-call"

type Operation = Pick<NativeOperationOwner, "task" | "dag" | "send">
type SendInput = Parameters<Operation["send"]["sendToTask"]>[0]

/** A fake Native per-call operation for DAG tests: owned starts are recorded, children finish only
 * when the test completes them, and a revoked operation refuses like a returned call does. */
export function createFakeDagOperation(parentSessionID: string) {
  const starts: { readonly nodeId: string; readonly spec: ManagerStartSpec }[] = []
  const tasks = new Map<string, { record: TaskRecord; readonly done: PromiseWithResolvers<TaskRecord> }>()
  const startedSignals = new Map<string, PromiseWithResolvers<void>>()
  const sent: { readonly taskId: string; readonly message: string }[] = [], cancelled: string[] = []
  let revoked = false
  function live() { if (revoked) throw Error("Native operation callback is closed") }
  function byNode(nodeId: string) { return [...tasks.values()].findLast(entry => entry.record.owner?.nodeId === nodeId) }
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
      // Like the Native operation: the owner key's latest child, only inside this root.
      findOwnedTask: (key: DagTaskOwnerKey) => {
        live()
        return [...tasks.values()].findLast(({ record }) => record.parent_session_id === parentSessionID && record.owner?.kind === key.kind &&
          record.owner.runId === key.runId && record.owner.nodeId === key.nodeId)?.record
      },
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
      cancelTask: async (id: string) => {
        live()
        const entry = tasks.get(id)
        if (!entry) return { kind: "not_found", reason: `unknown fake task ${id}` }
        cancelled.push(id)
        finish(entry, "cancelled")
        return { kind: "cancelled", task_id: id, previous_status: "running" }
      },
    },
    send: {
      // Refuses exactly like the Native operation send (`native-task/runtime.ts`): never all-scope or
      // cross-parent authority, and a task outside this parent's scope is not found.
      sendToTask: async (input: SendInput) => {
        live()
        if (input.allScope || input.callerSessionId !== undefined && input.callerSessionId !== parentSessionID) throw Error("Cross-parent operation send is not issued")
        const target = tasks.get(input.idOrName)?.record
        if (target?.parent_session_id !== parentSessionID) return { kind: "not_found", reason: `No task found for "${input.idOrName}".` }
        sent.push({ taskId: input.idOrName, message: input.message })
        return { kind: "steered", task_id: input.idOrName }
      },
    },
  }
  /** Settles the node's LATEST child; a retried node gets a new one. */
  function settle(nodeId: string, status: "completed" | "error"): void {
    const entry = byNode(nodeId)
    if (!entry) throw Error(`no fake task for ${nodeId}`)
    finish(entry, status)
  }
  function finish(entry: { record: TaskRecord; readonly done: PromiseWithResolvers<TaskRecord> }, status: "completed" | "error" | "cancelled") {
    entry.record = { ...entry.record, status, updated_at: "2026-11-11T00:00:01.000Z", ...(status === "completed" ? { final_response: `done ${entry.record.name}` } : { error_message: `${status} ${entry.record.name}` }) }
    entry.done.resolve(entry.record)
  }
  return {
    // The fake implements only the slice the DAG call port reads.
    operation: fake as unknown as Operation,
    starts,
    sent,
    cancelled,
    whenStarted(nodeId: string): Promise<void> {
      if (starts.some(start => start.nodeId === nodeId)) return Promise.resolve()
      const signal = startedSignals.get(nodeId) ?? Promise.withResolvers<void>()
      startedSignals.set(nodeId, signal)
      return signal.promise
    },
    complete: (nodeId: string): void => settle(nodeId, "completed"),
    /** A running child this fake did not start for a DAG node: `owner` names another run's node, or
     * none for a plain task. `parent` defaults to this root. */
    seed(taskId: string, options: { readonly owner?: DagTaskOwner; readonly parent?: string } = {}): void {
      const at = "2026-11-11T00:00:00.000Z", parent = options.parent ?? parentSessionID
      tasks.set(taskId, { done: Promise.withResolvers<TaskRecord>(), record: {
        task_id: taskId, name: taskId, parent_session_id: parent, root_session_id: parent, depth: 1,
        category: "quick", execution_mode: "in-process", model: "fake-model", notify_on_terminal: true, ...(options.owner && { owner: options.owner }),
        status: "running", residency_state: "resident", created_at: at, updated_at: at, notification: { run_epoch: 1, notified_epoch: 0 },
      } })
    },
    settle,
    /** Shares this operation's children with a later call's operation, like one runtime's manager. */
    adopt(other: { readonly tasksFrom: () => Map<string, { record: TaskRecord; readonly done: PromiseWithResolvers<TaskRecord> }> }): void {
      for (const [id, entry] of other.tasksFrom()) tasks.set(id, entry)
    },
    tasksFrom: () => tasks,
    revoke(): void { revoked = true },
  }
}

/** A root session's DAG runtime, wake owner and per-call operations, for workflow tests. Each
 * `begin` is one `workflow` call over a fresh operation sharing the earlier calls' children; the
 * operation is revoked when the call returns, like a returned host call. */
export function createWorkflowHarness(directory: string, lease: DagLeasePort, parentSessionID: string) {
  const posts: string[] = [], fakes: ReturnType<typeof createFakeDagOperation>[] = [], state = { failSynthetic: false }
  const runtime = createNativeDagRuntime({ directory, parentSessionID, executionMode: { agents: {}, config: {} }, lease,
    onDriveEnded: runId => wake.arm(parentSessionID, runId) })
  const wake = createNativeDagWakeOwner({ directory, pollIntervalMs: 0, assertGeneration() {},
    session: {
      async get(input) { return { id: input.sessionID, location: { directory } } },
      async synthetic(input) {
        if (state.failSynthetic) throw Error("transport down")
        posts.push(input.id)
        return { id: input.id, sessionID: input.sessionID, type: "synthetic", payload: { text: input.text } }
      },
    },
    journalPathFor: () => join(directory, "dag-wakes.sqlite"), runtimeFor: () => runtime,
    childState: (_root, taskId) => fakes.flatMap(fake => fake.tasksFrom().get(taskId)?.record ?? []).map(child => ({ status: child.status, runEpoch: child.notification.run_epoch })).at(-1) })
  function begin(params: DagToolInput, options: { readonly revoked?: boolean } = {}) {
    const fake = createFakeDagOperation(parentSessionID)
    for (const earlier of fakes) fake.adopt(earlier)
    fakes.push(fake)
    if (options.revoked) fake.revoke()
    const pending = runNativeWorkflow({ runtime, parentSessionID, executionMode: { agents: {}, config: {} },
      call: { port: nativeDagCallPort(fake.operation), signal: new AbortController().signal } }, params).finally(() => fake.revoke())
    return { fake, pending }
  }
  async function call(params: DagToolInput) {
    const { fake, pending } = begin(params)
    return { fake, result: await pending }
  }
  return { runtime, wake, posts, state, begin, call, record: (runId: string) => runtime.manager.record(runId as DagRunId, parentSessionID) }
}
