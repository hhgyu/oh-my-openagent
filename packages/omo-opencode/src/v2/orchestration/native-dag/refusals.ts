import { resolveDagNodeExecutionMode, type DagExecutionModeSources, type DagRoute } from "@oh-my-opencode/senpi-task/dag"
import type { DagToolDefinitionInput, DagToolErrorCode, DagToolResult } from "@oh-my-opencode/senpi-task/dag-operations"

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

function nodeRoute(node: DagToolDefinitionInput["nodes"][number]): DagRoute | undefined {
  if (node.category !== undefined) return { kind: "category", category: node.category }
  if (node.subagent_type !== undefined) return { kind: "agent", agent: node.subagent_type }
  return undefined
}

function quoted(ids: readonly string[]): string { return ids.map(id => `"${id}"`).join(", ") }

/** Definition features this host cannot run, refused before any engine work for `start` and
 * `amend`: named skills (S6g) and process execution mode (P-02). */
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
