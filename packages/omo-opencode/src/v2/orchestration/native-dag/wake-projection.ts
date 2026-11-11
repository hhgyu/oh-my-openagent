import { createHash } from "node:crypto"
import type { DagRunRecordV1 } from "@oh-my-opencode/senpi-task/dag"

/** Task statuses after which a node's child does nothing more; the engine folds each of them. */
export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(["completed", "error", "interrupted", "lost", "cancelled"])
const ACTIVE_NODE: ReadonlySet<string> = new Set(["scheduled", "running"])
const FAILED_NODE: ReadonlySet<string> = new Set(["failed", "cancelled", "skipped"])

export type DagWakeKind = "frontier" | "finished"
export interface DagWakeDecision {
  readonly kind: DagWakeKind
  readonly text: string
}

/** Deterministic host message id of one run wake; every retry posts the SAME id and the host dedups it. */
export function dagWakeInputId(runId: string, slot: number | "terminal"): string {
  return "msg_omo_dag_" + createHash("sha256").update(`dag:${runId}:${slot}`).digest("hex").slice(0, 40)
}

function quoted(ids: readonly string[]): string {
  return ids.length === 0 ? "none" : ids.map(id => `"${id}"`).join(", ")
}

/** The model's way back in. Detached runs advance only inside a `workflow` call (parity P-01). */
function nextCall(runId: string): string {
  return `On OpenCode 2 a background workflow run advances only on your next workflow call: call workflow with action=wait and run_id=${runId}`
}

/** What a run would do next if a call drove it now, read from its durable record and its children's
 * persisted task status. A wake is due only when an admitted node's child settled after the last call
 * folded the record: that settle is news nobody has acted on. `finished` means nothing is running and
 * nothing can start, so the next call only records the run's end. Returns undefined when no wake is due. */
export function projectDagWake(record: DagRunRecordV1, childStatus: (taskId: string) => string | undefined): DagWakeDecision | undefined {
  const projected = new Map<string, string>(record.nodes.map(node => [node.id, node.state]))
  const settled: string[] = [], running: string[] = []
  for (const node of record.nodes) {
    if (!ACTIVE_NODE.has(node.state)) continue
    const status = node.taskId === undefined ? undefined : childStatus(node.taskId)
    if (status === undefined || !TERMINAL_TASK_STATUSES.has(status)) { running.push(node.id); continue }
    projected.set(node.id, status === "completed" ? "completed" : "failed")
    settled.push(`"${node.id}" (${status})`)
  }
  if (settled.length === 0) return undefined
  const ready = record.nodes.filter(node => (node.state === "pending" || node.state === "blocked") &&
    node.dependsOn.every(dependency => projected.get(dependency) === "completed")).map(node => node.id)
  const head = `Workflow "${record.name}" (run ${record.runId}): node(s) ${settled.join(", ")} finished while no workflow call was in progress.`
  if (running.length > 0 || ready.length > 0) {
    return { kind: "frontier", text: `${head} Ready to start: ${quoted(ready)}. Still running: ${quoted(running)}. ${nextCall(record.runId)} (detach=true admits the ready nodes and returns at once; detach=false blocks until the run settles).` }
  }
  const states = [...projected.values()]
  const completed = states.filter(state => state === "completed").length
  const failed = states.filter(state => FAILED_NODE.has(state)).length
  const unstarted = states.length - completed - failed
  const outcome = failed + unstarted > 0 ? "failed" : "completed"
  return { kind: "finished", text: `${head} No node is running and none can start: the run is ${outcome} (${completed} completed, ${failed} failed, cancelled or skipped, ${unstarted} never started; ${states.length} total). ${nextCall(record.runId)} to record and read its final result.` }
}
