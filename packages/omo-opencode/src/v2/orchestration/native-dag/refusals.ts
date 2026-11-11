import { resolveDagNodeExecutionMode, type DagExecutionModeSources, type DagRoute, type DagRunStatus } from "@oh-my-opencode/senpi-task/dag"
import type { DagToolDefinitionInput, DagToolErrorCode, DagToolInput, DagToolResult } from "@oh-my-opencode/senpi-task/dag-operations"

/** An OpenCode 2 refusal, returned to the model in the original tool's error envelope. */
export class NativeDagRefusal extends Error {
  constructor(readonly code: DagToolErrorCode, message: string, readonly nodeIds: readonly string[] = []) { super(message) }
}

export function refusalResult(refusal: NativeDagRefusal): DagToolResult {
  return {
    content: [{ type: "text", text: refusal.message }],
    details: { kind: "error", error: { code: refusal.code, message: refusal.message, nodes: [], errors: [], diagnostics: [], node_ids: [...refusal.nodeIds] } },
  }
}

export type NativeDagExecutionSources = Omit<DagExecutionModeSources, "route" | "autoMode">

const CONTROL_ACTIONS: ReadonlySet<string> = new Set(["cancel", "cancel_node", "retry", "send", "amend"])
const TERMINAL: ReadonlySet<string> = new Set<DagRunStatus>(["completed", "failed", "cancelled"])

/** Actions this host cannot run yet, refused before any engine work. */
export function refuseAction(params: DagToolInput): NativeDagRefusal | undefined {
  if (CONTROL_ACTIONS.has(params.action)) {
    return new NativeDagRefusal("invalid_arguments", `workflow action=${params.action} is not available on OpenCode 2 yet; it arrives with the workflow controls (S6e). Use action=snapshot to inspect the run.`)
  }
  if (params.action === "start" && params.detach === true) {
    return new NativeDagRefusal("invalid_arguments", "A detached workflow start is not available on OpenCode 2 yet (S6d). action=start blocks until the run settles; omit detach.")
  }
  return undefined
}

/** A detached wait on a LIVE run would leave nodes nobody may start (no wake owner until S6d). A
 * settled run returns its result either way, as the original wait does. */
export function refuseDetachedWait(params: DagToolInput, status: DagRunStatus): NativeDagRefusal | undefined {
  if (params.action !== "wait" || params.detach === false || TERMINAL.has(status)) return undefined
  return new NativeDagRefusal("invalid_arguments", `Dag run is ${status}. A detached wait is not available on OpenCode 2 yet (S6d): pass detach=false to block until the run settles, or use action=snapshot.`)
}

function nodeRoute(node: DagToolDefinitionInput["nodes"][number]): DagRoute | undefined {
  if (node.category !== undefined) return { kind: "category", category: node.category }
  if (node.subagent_type !== undefined) return { kind: "agent", agent: node.subagent_type }
  return undefined
}

function quoted(ids: readonly string[]): string { return ids.map(id => `"${id}"`).join(", ") }

/** Definition features this host cannot run: named skills (S6g) and process execution mode (P-02). */
export function refuseDefinition(definition: DagToolDefinitionInput | undefined, sources: NativeDagExecutionSources): NativeDagRefusal | undefined {
  if (definition === undefined) return undefined
  const skilled = definition.nodes.filter(node => (node.load_skills?.length ?? 0) > 0).map(node => node.id)
  if (skilled.length > 0) {
    return new NativeDagRefusal("invalid_definition", `Node(s) ${quoted(skilled)} name skills in load_skills. DAG skill loading is not available on OpenCode 2 yet (S6g); remove load_skills.`, skilled)
  }
  const processNodes = definition.nodes.filter(node => {
    const route = nodeRoute(node)
    return route !== undefined && resolveDagNodeExecutionMode({ ...sources, route }) === "process"
  }).map(node => node.id)
  if (processNodes.length > 0) {
    return new NativeDagRefusal("invalid_definition", `Node(s) ${quoted(processNodes)} resolve to process execution mode. OpenCode 2 runs DAG nodes in-process only; pick an agent or category that runs in-process.`, processNodes)
  }
  return undefined
}
