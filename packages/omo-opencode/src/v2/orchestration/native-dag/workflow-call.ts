import { DagManagerError, type DagRunId, type DagRunSnapshot, type DagRunStatus } from "@oh-my-opencode/senpi-task/dag"
import {
  runDagTool,
  type DagToolDeps,
  type DagToolInput,
  type DagToolResult,
} from "@oh-my-opencode/senpi-task/dag-operations"
import { nativeDagControls } from "./controls"
import { NativeDagRefusal, refuseDefinition, refusalResult, type NativeDagExecutionSources } from "./refusals"
import type { NativeDagCall, NativeDagRuntime } from "./runtime"
import { authorizeCallSkills, type NativeDagSkillAuthority } from "./skills"

export interface NativeWorkflowCall {
  readonly runtime: Pick<NativeDagRuntime, "manager" | "managerFor" | "drive" | "admit" | "control">
  /** The calling root session: parent and root of every run it starts. */
  readonly parentSessionID: string
  readonly call: NativeDagCall
  readonly executionMode: NativeDagExecutionSources
  /** This call's skill authority (S6g). Without it a node that names skills is refused. */
  readonly skills?: NativeDagSkillAuthority
}

const TERMINAL: ReadonlySet<string> = new Set<DagRunStatus>(["completed", "failed", "cancelled"])
const ACTIVE_NODE: ReadonlySet<string> = new Set(["scheduled", "running"])

/** The run's current status, or undefined when the original tool should report the lookup error. */
function statusOf(input: NativeWorkflowCall, runId: string): DagRunStatus | undefined {
  try {
    return input.runtime.manager.snapshot(runId as DagRunId, input.parentSessionID).status
  } catch (error) {
    if (error instanceof DagManagerError) return undefined
    throw error
  }
}

function withText(result: DagToolResult, text: (original: string) => string): DagToolResult {
  return {
    ...result,
    content: result.content.map((part, index) => (index === 0 ? { ...part, text: text(part.text) } : part)),
  }
}

/** A blocking start returns after the run settled; say so next to the original start text. */
function withSettledStatus(result: DagToolResult): DagToolResult {
  if (result.details.kind !== "started") return result
  const snapshot = result.details.snapshot
  return withText(
    result,
    (text) =>
      `${text} The run settled with status ${snapshot.status} (${snapshot.counts.completed}/${snapshot.counts.total} nodes complete).`,
  )
}

/** The OpenCode 2 truth of a detached run (parity P-01/P-26), replacing Native's "woken as each node
 * completes": nodes start only inside a workflow call, and one wake brings the model back. */
function detachedNotice(snapshot: DagRunSnapshot): string {
  if (TERMINAL.has(snapshot.status))
    return `The run settled with status ${snapshot.status} (${snapshot.counts.completed}/${snapshot.counts.total} nodes complete).`
  return `The run is ${snapshot.status} (${snapshot.counts.completed}/${snapshot.counts.total} nodes complete). On OpenCode 2 nodes start only inside a workflow call: this call admitted every node that could start now, and nothing more starts until your next workflow call. When an admitted node finishes, this session is woken once; then call workflow with action=wait and run_id=${snapshot.runId} (detach=true admits the next ready nodes and returns, detach=false blocks until the run settles).`
}

/** The node states of a run before a control verb, or undefined when it cannot fold anything. */
function activeNodes(input: NativeWorkflowCall, runId: string | undefined): ReadonlyMap<string, string> | undefined {
  if (runId === undefined || statusOf(input, runId) !== "running") return undefined
  const record = input.runtime.manager.record(runId as DagRunId, input.parentSessionID)
  return new Map(record.nodes.filter((node) => ACTIVE_NODE.has(node.state)).map((node) => [node.id, node.state]))
}

/** A `send` (a control verb with no re-entry) folds the children that settled before it
 * (D-3); the call reports what it recorded, since a fold is news the wake no longer carries. */
function withFoldedNodes(
  input: NativeWorkflowCall,
  result: DagToolResult,
  runId: string,
  before: ReadonlyMap<string, string>,
): DagToolResult {
  const snapshot = input.runtime.manager.snapshot(runId as DagRunId, input.parentSessionID)
  const folded = snapshot.nodes
    .filter((node) => before.has(node.id) && !ACTIVE_NODE.has(node.state))
    .map((node) => `"${node.id}" (${node.state})`)
  if (folded.length === 0) return result
  return withText(
    result,
    (text) =>
      `${text} This call also recorded node(s) ${folded.join(", ")}, which finished before it. ${detachedNotice(snapshot)}`,
  )
}

/** `resume` of a run a reload paused (not a user stop): OpenCode 2 has no parent-session Resume
 * control, so this call recovers the run (`runtime.admit` routes a paused run through Native
 * recovery) and admits what can start now, like a detached wait. Anything else keeps the original
 * `resume` answer. */
async function resumeAfterReload(input: NativeWorkflowCall, runId: string): Promise<DagToolResult | undefined> {
  const before =
    statusOf(input, runId) === "paused"
      ? input.runtime.manager.snapshot(runId as DagRunId, input.parentSessionID)
      : undefined
  if (before === undefined || before.pause?.reason === "user_stop") return undefined
  await input.runtime.admit(runId as DagRunId, input.call)
  const snapshot = input.runtime.manager.snapshot(runId as DagRunId, input.parentSessionID)
  return {
    content: [
      { type: "text", text: `Resumed dag run ${runId}, which a plugin reload paused. ${detachedNotice(snapshot)}` },
    ],
    details: { kind: "detached", run_id: runId, snapshot },
  }
}

/** ONE `workflow` call on OpenCode 2: the ORIGINAL Native tool logic over this root session's DAG
 * runtime. A blocking start or `wait detach=false` drives the run inside this call until it settles;
 * a detached start or wait admits every ready node inside this call and returns, leaving the run to
 * the wake owner. The control verbs act through this call (`nativeDagControls`). Unsupported
 * definitions are refused before any engine work. */
export async function runNativeWorkflow(input: NativeWorkflowCall, params: DagToolInput): Promise<DagToolResult> {
  const refused =
    params.action === "start" || params.action === "amend"
      ? refuseDefinition(params.definition, input.executionMode)
      : undefined
  if (refused) return refusalResult(refused)
  const { runtime, parentSessionID } = input
  const detachedStart = params.action === "start" && params.detach === true
  try {
    // Skills are authorized for this caller before any engine work; a denial creates nothing.
    const authorizing = authorizeCallSkills(input.call, input.skills, params, (id) =>
      runtime.manager.record(id as DagRunId, parentSessionID),
    )
    const call = authorizing ? await authorizing : input.call
    const manager = runtime.managerFor(call)
    const runId = params.run_id?.trim()
    const resumed = params.action === "resume" && runId ? await resumeAfterReload(input, runId) : undefined
    if (resumed) return resumed
    const status = params.action === "wait" && params.detach !== false && runId ? statusOf(input, runId) : undefined
    // The original detached wait returns at once; on this host it first admits inside this call.
    if (runId && status !== undefined && !TERMINAL.has(status)) await runtime.admit(runId as DagRunId, call)
    const before = params.action === "send" ? activeNodes(input, runId) : undefined
    const deps: DagToolDeps = {
      manager: {
        ...manager,
        async start(startParams) {
          const started = await manager.start(startParams)
          const id = started.snapshot.runId
          if (detachedStart) await runtime.admit(id, call)
          else await runtime.drive(id, call)
          return { ...started, snapshot: runtime.manager.snapshot(id, parentSessionID) }
        },
      },
      parentSessionId: () => parentSessionID,
      rootSessionId: () => parentSessionID,
      wait: (id) => runtime.drive(id, call),
      ...nativeDagControls({
        runtime: { manager, control: runtime.control },
        parentSessionID,
        call,
        detach: params.detach !== false,
      }),
    }
    const result = await runDagTool(deps, params)
    if (result.details.kind === "detached") {
      const snapshot = result.details.snapshot
      return withText(result, () => `Detached from dag run ${snapshot.runId}. ${detachedNotice(snapshot)}`)
    }
    if (
      (detachedStart && result.details.kind === "started") ||
      result.details.kind === "retried" ||
      result.details.kind === "amended"
    ) {
      const snapshot = result.details.snapshot
      return withText(result, (text) => `${text} ${detachedNotice(snapshot)}`)
    }
    if (runId && before && result.details.kind === "sent") return withFoldedNodes(input, result, runId, before)
    return params.action === "start" ? withSettledStatus(result) : result
  } catch (error) {
    if (error instanceof NativeDagRefusal) return refusalResult(error)
    throw error
  }
}
