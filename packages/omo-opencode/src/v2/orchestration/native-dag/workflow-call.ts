import { DagManagerError, type DagRunId, type DagRunSnapshot, type DagRunStatus } from "@oh-my-opencode/senpi-task/dag"
import { runDagTool, type DagToolDeps, type DagToolInput, type DagToolResult } from "@oh-my-opencode/senpi-task/dag-operations"
import { NativeDagRefusal, refuseAction, refuseDefinition, refusalResult, type NativeDagExecutionSources } from "./refusals"
import type { NativeDagCall, NativeDagRuntime } from "./runtime"

export interface NativeWorkflowCall {
  readonly runtime: Pick<NativeDagRuntime, "manager" | "drive" | "admit">
  /** The calling root session: parent and root of every run it starts. */
  readonly parentSessionID: string
  readonly call: NativeDagCall
  readonly executionMode: NativeDagExecutionSources
}

const TERMINAL: ReadonlySet<string> = new Set<DagRunStatus>(["completed", "failed", "cancelled"])

/** The run's current status, or undefined when the original tool should report the lookup error. */
function statusOf(input: NativeWorkflowCall, runId: string): DagRunStatus | undefined {
  try { return input.runtime.manager.snapshot(runId as DagRunId, input.parentSessionID).status }
  catch (error) {
    if (error instanceof DagManagerError) return undefined
    throw error
  }
}

function withText(result: DagToolResult, text: (original: string) => string): DagToolResult {
  return { ...result, content: result.content.map((part, index) => index === 0 ? { ...part, text: text(part.text) } : part) }
}

/** A blocking start returns after the run settled; say so next to the original start text. */
function withSettledStatus(result: DagToolResult): DagToolResult {
  if (result.details.kind !== "started") return result
  const snapshot = result.details.snapshot
  return withText(result, text => `${text} The run settled with status ${snapshot.status} (${snapshot.counts.completed}/${snapshot.counts.total} nodes complete).`)
}

/** The OpenCode 2 truth of a detached run (parity P-01/P-26), replacing Native's "woken as each node
 * completes": nodes start only inside a workflow call, and one wake brings the model back. */
function detachedNotice(snapshot: DagRunSnapshot): string {
  if (TERMINAL.has(snapshot.status)) return `The run settled with status ${snapshot.status} (${snapshot.counts.completed}/${snapshot.counts.total} nodes complete).`
  return `The run is ${snapshot.status} (${snapshot.counts.completed}/${snapshot.counts.total} nodes complete). On OpenCode 2 nodes start only inside a workflow call: this call admitted every node that could start now, and nothing more starts until your next workflow call. When an admitted node finishes, this session is woken once; then call workflow with action=wait and run_id=${snapshot.runId} (detach=true admits the next ready nodes and returns, detach=false blocks until the run settles).`
}

/** ONE `workflow` call on OpenCode 2: the ORIGINAL Native tool logic over this root session's DAG
 * runtime. A blocking start or `wait detach=false` drives the run inside this call until it settles;
 * a detached start or wait admits every ready node inside this call and returns, leaving the run to
 * the wake owner. Unsupported actions and definitions are refused before any engine work. */
export async function runNativeWorkflow(input: NativeWorkflowCall, params: DagToolInput): Promise<DagToolResult> {
  const refused = refuseAction(params) ?? (params.action === "start" ? refuseDefinition(params.definition, input.executionMode) : undefined)
  if (refused) return refusalResult(refused)
  const { runtime, parentSessionID, call } = input
  const detachedStart = params.action === "start" && params.detach === true
  try {
    const runId = params.run_id?.trim()
    const status = params.action === "wait" && params.detach !== false && runId ? statusOf(input, runId) : undefined
    // The original detached wait returns at once; on this host it first admits inside this call.
    if (runId && status !== undefined && !TERMINAL.has(status)) await runtime.admit(runId as DagRunId, call)
    const deps: DagToolDeps = {
      manager: {
        ...runtime.manager,
        async start(startParams) {
          const started = await runtime.manager.start(startParams)
          const id = started.snapshot.runId
          if (detachedStart) await runtime.admit(id, call)
          else await runtime.drive(id, call)
          return { ...started, snapshot: runtime.manager.snapshot(id, parentSessionID) }
        },
      },
      parentSessionId: () => parentSessionID,
      rootSessionId: () => parentSessionID,
      wait: id => runtime.drive(id, call),
    }
    const result = await runDagTool(deps, params)
    if (result.details.kind === "detached") {
      const snapshot = result.details.snapshot
      return withText(result, () => `Detached from dag run ${snapshot.runId}. ${detachedNotice(snapshot)}`)
    }
    if (detachedStart && result.details.kind === "started") {
      const snapshot = result.details.snapshot
      return withText(result, text => `${text} ${detachedNotice(snapshot)}`)
    }
    return params.action === "start" ? withSettledStatus(result) : result
  } catch (error) {
    if (error instanceof NativeDagRefusal) return refusalResult(error)
    throw error
  }
}
