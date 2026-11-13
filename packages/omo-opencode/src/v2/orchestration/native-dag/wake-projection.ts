import { createHash } from "node:crypto"
import { DAG_VERIFICATION_DIRECTIVE } from "@oh-my-opencode/senpi-task"
import type { DagRunRecordV1 } from "@oh-my-opencode/senpi-task/dag"

/** Task statuses after which a node's child does nothing more; the engine folds each of them. */
export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "error",
  "interrupted",
  "lost",
  "cancelled",
])
const ACTIVE_NODE: ReadonlySet<string> = new Set(["scheduled", "running"])
const FAILED_NODE: ReadonlySet<string> = new Set(["failed", "cancelled", "skipped"])

export type DagWakeKind = "frontier" | "finished"
/** The persisted state of one node child the wake reads: its status and its run epoch, which a revive
 * of the same task advances, so a revived child's new settle is a new transition. */
export interface DagWakeChild {
  readonly status: string
  readonly runEpoch: number
}
/** One settle a wake reports: the node, the child that settled, that child's run epoch and status. */
export interface DagWakeSettle {
  readonly nodeId: string
  readonly taskId: string
  readonly runEpoch: number
  readonly status: string
}
export interface DagWakeDecision {
  readonly kind: DagWakeKind
  readonly text: string
  /** Every settle the wake reports, sorted by node id: the content its frontier id is derived from. */
  readonly settled: readonly DagWakeSettle[]
}

/** Deterministic host message id of one run wake; every retry posts the SAME id and the host dedups it.
 * A frontier wake is keyed by the run and the canonical signature of the settles it reports, never by
 * the checkpoint seq: a journal entry that folds nothing (a steer) advances the seq without changing
 * that content, so the same settle keeps its id and its ACK (D-3). A new settle, or the same node's
 * child settling again after a retry (new task) or revive (new run epoch), is new content. The
 * terminal wake is keyed by the run generation, which a `retry` or `amend` of a settled run advances
 * (`dag.run.resumed`), so each terminal transition gets its own id instead of colliding with the
 * earlier finish. */
export function dagWakeInputId(
  runId: string,
  slot: { readonly settled: readonly DagWakeSettle[] } | { readonly terminalGeneration: number },
): string {
  const key =
    "terminalGeneration" in slot
      ? `dag:${runId}:terminal:${slot.terminalGeneration}`
      : `dag:${runId}:frontier:${JSON.stringify(canonicalSettles(slot.settled).map((entry) => [entry.nodeId, entry.taskId, entry.runEpoch, entry.status]))}`
  return "msg_omo_dag_" + createHash("sha256").update(key).digest("hex").slice(0, 40)
}

function canonicalSettles(settled: readonly DagWakeSettle[]): readonly DagWakeSettle[] {
  return settled.toSorted((left, right) => (left.nodeId < right.nodeId ? -1 : left.nodeId > right.nodeId ? 1 : 0))
}

function quoted(ids: readonly string[]): string {
  return ids.length === 0 ? "none" : ids.map((id) => `"${id}"`).join(", ")
}

/** The model's way back in. Detached runs advance only inside a `workflow` call (parity P-01). */
function nextCall(runId: string): string {
  return `On OpenCode 2 a background workflow run advances only on your next workflow call: call workflow with action=wait and run_id=${runId}`
}

/** What a run would do next if a call drove it now, read from its durable record and its children's
 * persisted task status. A wake is due only when an admitted node's child settled after the last call
 * folded the record: that settle is news nobody has acted on. `finished` means nothing is running and
 * nothing can start, so the next call only records the run's end. Returns undefined when no wake is due. */
export function projectDagWake(
  record: DagRunRecordV1,
  childState: (taskId: string) => DagWakeChild | undefined,
): DagWakeDecision | undefined {
  const projected = new Map<string, string>(record.nodes.map((node) => [node.id, node.state]))
  const found: DagWakeSettle[] = [],
    running: string[] = []
  for (const node of record.nodes) {
    if (!ACTIVE_NODE.has(node.state)) continue
    const child = node.taskId === undefined ? undefined : childState(node.taskId)
    if (node.taskId === undefined || child === undefined || !TERMINAL_TASK_STATUSES.has(child.status)) {
      running.push(node.id)
      continue
    }
    projected.set(node.id, child.status === "completed" ? "completed" : "failed")
    found.push({ nodeId: node.id, taskId: node.taskId, runEpoch: child.runEpoch, status: child.status })
  }
  if (found.length === 0) return undefined
  const settled = canonicalSettles(found)
  const ready = record.nodes
    .filter(
      (node) =>
        (node.state === "pending" || node.state === "blocked") &&
        node.dependsOn.every((dependency) => projected.get(dependency) === "completed"),
    )
    .map((node) => node.id)
  const head = `Workflow "${record.name}" (run ${record.runId}): node(s) ${found.map((entry) => `"${entry.nodeId}" (${entry.status})`).join(", ")} finished while no workflow call was in progress.`
  if (running.length > 0 || ready.length > 0) {
    return {
      kind: "frontier",
      settled,
      text: `${head} Ready to start: ${quoted(ready)}. Still running: ${quoted(running)}. ${nextCall(record.runId)} (detach=true admits the ready nodes and returns at once; detach=false blocks until the run settles).\n\n${DAG_VERIFICATION_DIRECTIVE}`,
    }
  }
  const states = [...projected.values()]
  const completed = states.filter((state) => state === "completed").length
  const failed = states.filter((state) => FAILED_NODE.has(state)).length
  const unstarted = states.length - completed - failed
  const outcome = failed + unstarted > 0 ? "failed" : "completed"
  return {
    kind: "finished",
    settled,
    text: `${head} No node is running and none can start: the run is ${outcome} (${completed} completed, ${failed} failed, cancelled or skipped, ${unstarted} never started; ${states.length} total). ${nextCall(record.runId)} to record and read its final result.\n\n${DAG_VERIFICATION_DIRECTIVE}`,
  }
}
