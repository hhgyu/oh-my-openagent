import { join } from "node:path"
import type {
  DagLeasePort,
  DagRunId,
  DagTaskOwner,
  DagTaskOwnerKey,
  OwnedStartResult,
} from "@oh-my-opencode/senpi-task/dag"
import type { DagToolInput } from "@oh-my-opencode/senpi-task/dag-operations"
import type { ManagerStartSpec, TaskRecord } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { NativeOperationOwner } from "../native-task/operation-ports"
import { createNativeDagRuntime } from "./runtime"
import type { NativeDagSkillAuthority } from "./skills"
import { nativeDagCallPort } from "./task-port"
import { createNativeDagWakeOwner } from "./wake"
import { runNativeWorkflow } from "./workflow-call"

type Operation = Pick<NativeOperationOwner, "task" | "dag" | "send" | "recovery">
type FakeChild = {
  record: TaskRecord
  readonly done: PromiseWithResolvers<TaskRecord>
  hosted: boolean
  owned: boolean
}
type SendInput = Parameters<Operation["send"]["sendToTask"]>[0]

/** A fake Native per-call operation for DAG tests: owned starts are recorded, children finish only
 * when the test completes them, and a revoked operation refuses like a returned call does. A child
 * is hosted (has a resident handle) until `park` simulates a closing task service; the call's
 * `restoreAfterReload` re-hosts a parked running child, like Native task's lazy restore (whose
 * reattach continues the turn the restart cut off, so the child settles later; here when the test
 * completes it). A parked child is a stored row the current runtime does not own: every capturing
 * read or action (`get`, `waitFor`, `subscribeChild`, `cancelTask`, `sendToTask`) refuses it exactly
 * like the Native operation's capture (`native-task/runtime.ts` `captureOperationTask`) until it is
 * restored. Only the owned lookup and the residency and ownership queries read it without capturing. */
export function createFakeDagOperation(parentSessionID: string) {
  const starts: { readonly nodeId: string; readonly spec: ManagerStartSpec }[] = []
  const tasks = new Map<string, FakeChild>()
  const startedSignals = new Map<string, PromiseWithResolvers<void>>()
  const sent: { readonly taskId: string; readonly message: string }[] = [],
    cancelled: string[] = [],
    restored: string[] = []
  let revoked = false
  function live() {
    if (revoked) throw Error("Native operation callback is closed")
  }
  /** The Native operation's capture: a row this runtime does not own is refused, never read. */
  function captured(id: string): FakeChild | undefined {
    const entry = tasks.get(id)
    if (entry !== undefined && !entry.owned) throw Error("Operation task has no original owned membership")
    return entry
  }
  function byNode(nodeId: string) {
    return [...tasks.values()].findLast((entry) => entry.record.owner?.nodeId === nodeId)
  }
  async function startOwned(spec: ManagerStartSpec, owner: DagTaskOwner): Promise<OwnedStartResult> {
    live()
    const nodeId = String(owner.nodeId),
      taskId = `task-${tasks.size + 1}`
    const at = "2026-11-11T00:00:00.000Z"
    tasks.set(taskId, {
      hosted: true,
      owned: true,
      done: Promise.withResolvers<TaskRecord>(),
      record: {
        task_id: taskId,
        name: nodeId,
        parent_session_id: parentSessionID,
        root_session_id: parentSessionID,
        depth: 1,
        category: "quick",
        execution_mode: "in-process",
        model: "fake-model",
        notify_on_terminal: true,
        owner,
        status: "running",
        residency_state: "resident",
        created_at: at,
        updated_at: at,
        notification: { run_epoch: 1, notified_epoch: 0 },
      },
    })
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
        return [...tasks.values()].findLast(
          ({ record }) =>
            record.parent_session_id === parentSessionID &&
            record.owner?.kind === key.kind &&
            record.owner.runId === key.runId &&
            record.owner.nodeId === key.nodeId,
        )?.record
      },
      residencyChanged: () => {
        live()
        return new Promise<void>(() => {})
      },
    },
    task: {
      get: (id: string) => {
        live()
        return captured(id)?.record
      },
      subscribeChild: (id: string) => {
        live()
        captured(id)
        return () => {}
      },
      waitFor: (id: string) => {
        live()
        const entry = captured(id)
        if (!entry) throw Error(`unknown fake task ${id}`)
        return entry.done.promise
      },
      cancelTask: async (id: string) => {
        live()
        const entry = captured(id)
        if (!entry) return { kind: "not_found", reason: `unknown fake task ${id}` }
        cancelled.push(id)
        finish(entry, "cancelled")
        return { kind: "cancelled", task_id: id, previous_status: "running" }
      },
    },
    recovery: {
      restoreAfterReload: async (id: string) => {
        live()
        const entry = tasks.get(id)
        if (!entry || entry.hosted || entry.record.status !== "running") return false
        entry.hosted = true
        entry.owned = true
        restored.push(id)
        return true
      },
      residentHandle: (id: string) => {
        live()
        return tasks.get(id)?.hosted ? { taskId: id } : undefined
      },
      // Like the Native operation's non-capturing ownership query: only this root, never a receipt.
      owned: (id: string) => {
        live()
        const entry = tasks.get(id)
        return entry?.record.parent_session_id === parentSessionID && entry.owned
      },
    },
    send: {
      // Refuses exactly like the Native operation send (`native-task/runtime.ts`): never all-scope or
      // cross-parent authority, and a task outside this parent's scope is not found.
      sendToTask: async (input: SendInput) => {
        live()
        if (input.allScope || (input.callerSessionId !== undefined && input.callerSessionId !== parentSessionID))
          throw Error("Cross-parent operation send is not issued")
        const target = tasks.get(input.idOrName)?.record
        if (target?.parent_session_id !== parentSessionID)
          return { kind: "not_found", reason: `No task found for "${input.idOrName}".` }
        captured(input.idOrName)
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
  function finish(entry: FakeChild, status: "completed" | "error" | "cancelled") {
    entry.record = {
      ...entry.record,
      status,
      updated_at: "2026-11-11T00:00:01.000Z",
      ...(status === "completed"
        ? { final_response: `done ${entry.record.name}` }
        : { error_message: `${status} ${entry.record.name}` }),
    }
    entry.done.resolve(entry.record)
  }
  return {
    // The fake implements only the slice the DAG call port reads.
    operation: fake as unknown as Operation,
    starts,
    sent,
    cancelled,
    restored,
    whenStarted(nodeId: string): Promise<void> {
      if (starts.some((start) => start.nodeId === nodeId)) return Promise.resolve()
      const signal = startedSignals.get(nodeId) ?? Promise.withResolvers<void>()
      startedSignals.set(nodeId, signal)
      return signal.promise
    },
    complete: (nodeId: string): void => settle(nodeId, "completed"),
    /** A running child this fake did not start for a DAG node: `owner` names another run's node, or
     * none for a plain task. `parent` defaults to this root. */
    seed(taskId: string, options: { readonly owner?: DagTaskOwner; readonly parent?: string } = {}): void {
      const at = "2026-11-11T00:00:00.000Z",
        parent = options.parent ?? parentSessionID
      tasks.set(taskId, {
        hosted: true,
        owned: true,
        done: Promise.withResolvers<TaskRecord>(),
        record: {
          task_id: taskId,
          name: taskId,
          parent_session_id: parent,
          root_session_id: parent,
          depth: 1,
          category: "quick",
          execution_mode: "in-process",
          model: "fake-model",
          notify_on_terminal: true,
          ...(options.owner && { owner: options.owner }),
          status: "running",
          residency_state: "resident",
          created_at: at,
          updated_at: at,
          notification: { run_epoch: 1, notified_epoch: 0 },
        },
      })
    },
    settle,
    /** Shares this operation's children with a later call's operation, like one runtime's manager. */
    adopt(other: { readonly tasksFrom: () => Map<string, FakeChild> }): void {
      for (const [id, entry] of other.tasksFrom()) tasks.set(id, entry)
    },
    tasksFrom: () => tasks,
    revoke(): void {
      revoked = true
    },
    /** A closing task service parks every child: none has a resident handle, and the next runtime
     * owns none of them, until restored (a settled child is never restored, like Native's). */
    park(): void {
      for (const entry of tasks.values()) {
        entry.hosted = false
        entry.owned = false
      }
    },
  }
}

/** A root session's DAG runtime, wake owner and per-call operations, for workflow tests. Each
 * `begin` is one `workflow` call over a fresh operation sharing the earlier calls' children; the
 * operation is revoked when the call returns, like a returned host call. A harness built with an
 * earlier harness's `fakes` is the next plugin generation over the same project and children.
 * `skills` is each call's skill authority (the component binds S2 `authorizeSkills` per call). */
export function createWorkflowHarness(
  directory: string,
  lease: DagLeasePort,
  parentSessionID: string,
  inherited: readonly ReturnType<typeof createFakeDagOperation>[] = [],
  skills?: (runtime: ReturnType<typeof createNativeDagRuntime>) => NativeDagSkillAuthority,
) {
  const posts: string[] = [],
    fakes: ReturnType<typeof createFakeDagOperation>[] = [...inherited],
    state = { failSynthetic: false }
  const runtime = createNativeDagRuntime({
    directory,
    parentSessionID,
    executionMode: { agents: {}, config: {} },
    lease,
    onDriveEnded: (runId) => wake.arm(parentSessionID, runId),
  })
  const wake = createNativeDagWakeOwner({
    directory,
    pollIntervalMs: 0,
    assertGeneration() {},
    session: {
      async get(input) {
        return { id: input.sessionID, location: { directory } }
      },
      async synthetic(input) {
        if (state.failSynthetic) throw Error("transport down")
        posts.push(input.id)
        return { id: input.id, sessionID: input.sessionID, type: "synthetic", payload: { text: input.text } }
      },
    },
    journalPathFor: () => join(directory, "dag-wakes.sqlite"),
    runtimeFor: () => runtime,
    childState: (_root, taskId) =>
      fakes
        .flatMap((fake) => fake.tasksFrom().get(taskId)?.record ?? [])
        .map((child) => ({ status: child.status, runEpoch: child.notification.run_epoch }))
        .at(-1),
  })
  function begin(params: DagToolInput, options: { readonly revoked?: boolean; readonly signal?: AbortSignal } = {}) {
    const fake = createFakeDagOperation(parentSessionID)
    for (const earlier of fakes) fake.adopt(earlier)
    fakes.push(fake)
    if (options.revoked) fake.revoke()
    const pending = runNativeWorkflow(
      {
        runtime,
        parentSessionID,
        executionMode: { agents: {}, config: {} },
        ...(skills && { skills: skills(runtime) }),
        call: { port: nativeDagCallPort(fake.operation), signal: options.signal ?? new AbortController().signal },
      },
      params,
    ).finally(() => fake.revoke())
    return { fake, pending }
  }
  async function call(params: DagToolInput) {
    const { fake, pending } = begin(params)
    return { fake, result: await pending }
  }
  return {
    runtime,
    wake,
    posts,
    state,
    fakes,
    begin,
    call,
    record: (runId: string) => runtime.manager.record(runId as DagRunId, parentSessionID),
  }
}
