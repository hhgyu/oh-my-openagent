import { dagStatusSchema, type DagStatus } from "../rpc/dag"
import { createSessionStatusView } from "./session-status-view"

export function createDagStatusView(deps: {
  readonly load: (sessionID: string, signal: AbortSignal) => Promise<unknown>
  readonly subscribe: (handler: (data: unknown) => void) => () => void
  readonly changed: () => void
}) {
  return createSessionStatusView<DagStatus>({ ...deps, schema: dagStatusSchema, name: "DAG panel" })
}

const compact = (value: string) =>
  value
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
const bounded = (value: string) => {
  const text = compact(value)
  return text.length > 90 ? `${text.slice(0, 87)}...` : text
}

export function dagStatusLines(status: DagStatus | undefined): string[] {
  if (!status?.runs.length) return []
  // RPC preserves the Native manager's newest-updated-first order.
  const visible = status.runs.filter(
    (run, index) =>
      run.status === "pending" ||
      run.status === "running" ||
      run.status === "paused" ||
      (index === 0 && run.status === "failed"),
  )
  if (visible.length === 0) return []
  const lines = ["Workflows"]
  const runs = visible.sort((a, b) => Number(b.status === "running") - Number(a.status === "running"))
  for (const run of runs.slice(0, 3)) {
    lines.push(`${compact(run.name).slice(0, 32)} [${run.runId}] ${run.status}`)
    const counts = Object.entries(run.counts)
      .filter(([state, count]) => state !== "total" && count > 0)
      .map(([state, count]) => `${state}:${count}`)
    lines.push(`${run.counts.total} nodes ${counts.slice(0, 5).join(" ")}`)
    if (counts.length > 5) lines.push(counts.slice(5).join(" "))
    const active = run.nodes.filter((node) => node.state === "running")
    if (active.length) lines.push(`Running: ${active.map((node) => node.label ?? node.id).join(", ")}`)
    const failures = run.nodes.filter((node) => node.state === "failed")
    const node = failures[0]
    if (node !== undefined) {
      lines.push(
        `${node.label ?? node.id}: ${node.error ? `${node.error.code}: ${node.error.message}` : "failed"}${failures.length > 1 ? ` (+${failures.length - 1} failures)` : ""}`,
      )
    }
  }
  if (runs.length > 3) lines.push(`${runs.length - 3} more workflows (omo.dag.status)`)
  return lines.map(bounded)
}
