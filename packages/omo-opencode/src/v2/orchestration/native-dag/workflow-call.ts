import { DagManagerError, type DagRunId, type DagRunStatus } from "@oh-my-opencode/senpi-task/dag"
import { runDagTool, type DagToolDeps, type DagToolInput, type DagToolResult } from "@oh-my-opencode/senpi-task/dag-operations"
import { NativeDagRefusal, refuseAction, refuseDefinition, refuseDetachedWait, refusalResult, type NativeDagExecutionSources } from "./refusals"
import type { NativeDagCall, NativeDagRuntime } from "./runtime"

export interface NativeWorkflowCall {
  readonly runtime: Pick<NativeDagRuntime, "manager" | "drive">
  /** The calling root session: parent and root of every run it starts. */
  readonly parentSessionID: string
  readonly call: NativeDagCall
  readonly executionMode: NativeDagExecutionSources
}

/** The run's current status, or undefined when the original tool should report the lookup error. */
function statusOf(input: NativeWorkflowCall, runId: string): DagRunStatus | undefined {
  try { return input.runtime.manager.snapshot(runId as DagRunId, input.parentSessionID).status }
  catch (error) {
    if (error instanceof DagManagerError) return undefined
    throw error
  }
}

/** A blocking start returns after the run settled; say so next to the original start text. */
function withSettledStatus(result: DagToolResult): DagToolResult {
  if (result.details.kind !== "started") return result
  const snapshot = result.details.snapshot
  const settled = ` The run settled with status ${snapshot.status} (${snapshot.counts.completed}/${snapshot.counts.total} nodes complete).`
  return { ...result, content: result.content.map((part, index) => index === 0 ? { ...part, text: part.text + settled } : part) }
}

/** ONE `workflow` call on OpenCode 2: the ORIGINAL Native tool logic over this root session's DAG
 * runtime, with a blocking start and a blocking wait driven inside this call. Unsupported actions
 * and definitions are refused with model-visible messages before any engine work. */
export async function runNativeWorkflow(input: NativeWorkflowCall, params: DagToolInput): Promise<DagToolResult> {
  const refused = refuseAction(params) ?? (params.action === "start" ? refuseDefinition(params.definition, input.executionMode) : undefined)
  if (refused) return refusalResult(refused)
  const { runtime, parentSessionID, call } = input
  try {
    const runId = params.run_id?.trim()
    const status = params.action === "wait" && runId ? statusOf(input, runId) : undefined
    const detached = status === undefined ? undefined : refuseDetachedWait(params, status)
    if (detached) return refusalResult(detached)
    const deps: DagToolDeps = {
      manager: {
        ...runtime.manager,
        async start(startParams) {
          const started = await runtime.manager.start(startParams)
          const id = started.snapshot.runId
          await runtime.drive(id, call)
          return { ...started, snapshot: runtime.manager.snapshot(id, parentSessionID) }
        },
      },
      parentSessionId: () => parentSessionID,
      rootSessionId: () => parentSessionID,
      wait: id => runtime.drive(id, call),
    }
    const result = await runDagTool(deps, params)
    return params.action === "start" ? withSettledStatus(result) : result
  } catch (error) {
    if (error instanceof NativeDagRefusal) return refusalResult(error)
    throw error
  }
}
