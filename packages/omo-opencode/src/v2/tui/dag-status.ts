import { dagStatusSchema, type DagStatus } from "../rpc/dag"

export function createDagStatusView(deps: {
  readonly load: (sessionID: string, signal: AbortSignal) => Promise<unknown>
  readonly subscribe: (handler: (data: unknown) => void) => () => void
  readonly changed: () => void
}) {
  let current: DagStatus | undefined
  let sessionID: string | undefined
  let revision = 0
  let closed = false
  let request: AbortController | undefined
  const accept = (data: unknown): boolean => {
    const result = dagStatusSchema.safeParse(data)
    if (closed || !result.success || result.data.sessionID !== sessionID) return false
    current = result.data
    deps.changed()
    return true
  }
  const unsubscribe = deps.subscribe(data => { if (accept(data)) { revision++; request?.abort() } })
  return {
    select(id: string): void {
      if (closed || sessionID === id) return
      request?.abort()
      sessionID = id
      current = undefined
      deps.changed()
      const token = ++revision
      const controller = new AbortController()
      request = controller
      void deps.load(id, controller.signal).then(data => { if (revision === token) accept(data) }).catch((error: unknown) => {
        if (!controller.signal.aborted && !closed) console.warn("[oh-my-openagent/v2] DAG panel status unavailable", String(error))
      })
    },
    snapshot: () => current,
    close(): void { closed = true; revision++; request?.abort(); unsubscribe() },
  }
}

const compact = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim()
const bounded = (value: string) => { const text = compact(value); return text.length > 90 ? `${text.slice(0,87)}...` : text }

export function dagStatusLines(status: DagStatus | undefined): string[] {
  if (!status?.runs.length) return []
  // RPC preserves the Native manager's newest-updated-first order.
  const visible = status.runs.filter((run, index) =>
    run.status === "pending" || run.status === "running" || run.status === "paused" || (index === 0 && run.status === "failed"))
  if (visible.length === 0) return []
  const lines = ["Workflows"]
  const runs = visible.sort((a, b) => Number(b.status === "running") - Number(a.status === "running"))
  for (const run of runs.slice(0, 3)) {
    lines.push(`${compact(run.name).slice(0, 32)} [${run.runId}] ${run.status}`)
    const counts = Object.entries(run.counts).filter(([state, count]) => state !== "total" && count > 0).map(([state, count]) => `${state}:${count}`)
    lines.push(`${run.counts.total} nodes ${counts.slice(0, 5).join(" ")}`)
    if (counts.length > 5) lines.push(counts.slice(5).join(" "))
    const active = run.nodes.filter(node => node.state === "running")
    if (active.length) lines.push(`Running: ${active.map(node => node.label ?? node.id).join(", ")}`)
    const failures = run.nodes.filter(node => node.state === "failed")
    const node = failures[0]
    if (node !== undefined) {
      lines.push(`${node.label ?? node.id}: ${node.error ? `${node.error.code}: ${node.error.message}` : "failed"}${failures.length > 1 ? ` (+${failures.length - 1} failures)` : ""}`)
    }
  }
  if (runs.length > 3) lines.push(`${runs.length - 3} more workflows (omo.dag.status)`)
  return lines.map(bounded)
}
