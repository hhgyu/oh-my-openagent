import { createDagScheduler, type DagFileStore, type DagLeasePort, type DagManager, type DagNodeId, type DagNodeSpawnPolicy, type DagRunId, type DagRunRecordV1 } from "@oh-my-opencode/senpi-task/dag"
import { NativeDagRefusal, type NativeDagExecutionSources } from "./refusals"
import { createHeldDagTaskPort, type NativeDagCallPort } from "./task-port"
import { TERMINAL_TASK_STATUSES } from "./wake-projection"

const TERMINAL_RUN: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])
const SETTLED_NODE: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "skipped"])

export interface NativeDagDriveInput {
  readonly store: DagFileStore
  readonly manager: Pick<DagManager, "record">
  readonly runId: DagRunId
  readonly parentSessionID: string
  readonly call: NativeDagCallPort
  readonly signal: AbortSignal
  readonly executionMode: NativeDagExecutionSources
  readonly lease: DagLeasePort
  /** The same spawn restrictions (plan gate, prompt contracts) the call's `task` tool applies. */
  readonly spawnPolicy?: DagNodeSpawnPolicy
  /** Detached: return once the call admitted every ready node and folded every settled child,
   * instead of blocking until the run is terminal. */
  readonly detach?: boolean
}

/** Children an earlier call already admitted: re-entry attaches them instead of starting again. A
 * node whose admission was cut off with no task to attach cannot be resolved before recovery. */
function admittedChildren(record: DagRunRecordV1, call: NativeDagCallPort): ReadonlyMap<DagNodeId, string> {
  const attached = new Map<DagNodeId, string>()
  const lost: string[] = []
  for (const node of record.nodes) {
    if (SETTLED_NODE.has(node.state) || node.state === "pending" || node.state === "blocked") continue
    const taskId = node.taskId ?? call.findOwnedTask({ kind: "dag", runId: record.runId, nodeId: node.id })?.task_id
    if (taskId === undefined) lost.push(node.id)
    else attached.set(node.id, taskId)
  }
  if (lost.length > 0) {
    throw new NativeDagRefusal("run_still_active", `Node(s) ${lost.map(id => `"${id}"`).join(", ")} were being admitted when their workflow call ended and have no task yet. Resolving them needs workflow recovery, which is not available on OpenCode 2 yet (S6f).`, lost)
  }
  return attached
}

/** Settles with `work`, or rejects with the call's abort reason first; the listener never outlives it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) { abort(); return }
    signal.addEventListener("abort", abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

/** An admitted node whose child already settled but the scheduler has not folded yet. */
function hasUnfoldedSettle(record: DagRunRecordV1, call: NativeDagCallPort): boolean {
  return record.nodes.some(node => (node.state === "scheduled" || node.state === "running") && node.taskId !== undefined &&
    TERMINAL_TASK_STATUSES.has(call.get(node.taskId)?.status ?? ""))
}

/** Resolves once the scheduler is quiet inside this call: no node start in flight, no settled child
 * left unfolded, and the checkpoint unchanged across a full timer turn. Then everything the call can
 * admit now has been admitted; the rest waits for a later settle (and the wake) and a later call. */
async function admissionSettled(snapshot: () => DagRunRecordV1, starting: () => number, call: NativeDagCallPort, stop: AbortSignal): Promise<DagRunRecordV1> {
  let previous = -1
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 0))
    const record = snapshot()
    if (stop.aborted) return record
    if (starting() === 0 && record.checkpointSeq === previous && !hasUnfoldedSettle(record, call)) return record
    previous = record.checkpointSeq
  }
}

/** Runs ONE call's drive of a run: a scheduler whose every node start goes through this call's
 * operation keeps admitting the frontier until the run is terminal, the call aborts or, detached,
 * the admission is quiet. When the call ends first, admission is held and the scheduler retires
 * without cancelling children, so nothing is started after the call returns. */
export async function driveDagRun(input: NativeDagDriveInput): Promise<DagRunRecordV1> {
  const initialRecord = input.manager.record(input.runId, input.parentSessionID)
  if (TERMINAL_RUN.has(initialRecord.status)) return initialRecord
  input.signal.throwIfAborted()
  const held = createHeldDagTaskPort()
  const release = held.bind(input.call), quiet = new AbortController()
  let retire: (() => Promise<void>) | undefined
  try {
    const preAttachedTasks = admittedChildren(initialRecord, input.call)
    const scheduler = createDagScheduler({
      store: input.store, taskManager: held.port, initialRecord, preAttachedTasks,
      executionMode: input.executionMode, ancestry: { depth: 0 }, lease: input.lease,
      ...(input.spawnPolicy && { nodeSpawnPolicy: input.spawnPolicy }),
    })
    retire = async () => {
      if (TERMINAL_RUN.has(scheduler.snapshot().status)) return
      const suspended = scheduler.suspend()
      // Suspension is already marked, so a held start ends without failing its node.
      held.dropHeld()
      await suspended
    }
    const running = scheduler.run()
    // An aborted call stops waiting here; the retired scheduler's own outcome is the store's.
    void running.catch(() => {})
    const record = await untilAborted(input.detach ? Promise.race([running, admissionSettled(scheduler.snapshot, held.starting, input.call, quiet.signal)]) : running, input.signal)
    await scheduler.whenIdle()
    return record
  } finally {
    quiet.abort()
    release()
    await retire?.()
  }
}
