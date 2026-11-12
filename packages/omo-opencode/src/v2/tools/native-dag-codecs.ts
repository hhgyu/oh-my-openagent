import { Compile } from "typebox/compile"
import { DagToolParams, WORKFLOW_TOOL_NAME, type DagToolInput } from "@oh-my-opencode/senpi-task/dag-operations"
import type { ListedTool } from "../host/tool-registry"
import { issueToolValueCodec, type ToolCodecAssociation } from "../host/tool-value-codec"

/** The Native DAG tool name. No stock OpenCode 2.2.6 tool uses it; publication still refuses an
 * ambiguous catalog and replaces a single same-named entry, as the team tools do. */
export const NATIVE_DAG_TOOL_NAME = WORKFLOW_TOOL_NAME
/** The canonical Native `workflow` INPUT schema; the tool declares no output schema. */
export const nativeDagInputSchema = DagToolParams

const compiled = Compile(DagToolParams)

export function isNativeDagToolName(name: string): name is typeof NATIVE_DAG_TOOL_NAME {
  return name === NATIVE_DAG_TOOL_NAME
}

export function checkedNativeDagInput(input: unknown): DagToolInput {
  if (!compiled.Check(input)) throw Error("Invalid Native workflow tool input")
  return input
}

/** Trusted assembly only, before registry cloning. The strict decoder checks and returns the
 * ORIGINAL input value; the workflow input needs no argument normalizer. */
export function issueNativeDagCodec(tool: ListedTool): ToolCodecAssociation {
  if ((tool.input as unknown) !== nativeDagInputSchema) throw Error("Native workflow input schema does not match tool definition")
  const input = issueToolValueCodec(tool, "input", { schema: nativeDagInputSchema, decodeUnknown: value => checkedNativeDagInput(value) })
  return Object.freeze({ tool, input })
}

/** The OpenCode 2 tool guide: the Native guidance, restated where this host behaves differently. */
export const NATIVE_DAG_DESCRIPTION = [
  "Dependency-graph execution for child tasks: partition the work into logically distinct steps, name one node per step, and wire the ordering as data.",
  "A node starts only after every node it dependsOn has finished, and unrelated nodes run in parallel up to the resident-child cap.",
  "dependsOn is ordering ONLY - no upstream output is substituted into a downstream prompt, so each prompt must stand alone.",
  "Each node targets EITHER category OR subagent_type, never both; model is an explicit override valid only alongside subagent_type.",
  "start is idempotent per definition key: re-starting the same key with the same graph reuses the run instead of duplicating it.",
  "On OpenCode 2, nodes start only while a workflow call is in progress. start blocks until the run settles and returns its final snapshot; wait with detach=false blocks the same way.",
  "start with detach=true and wait (detach defaults to true) admit every node that can start now inside the call and return at once. A background run then advances ONLY on your next workflow call: when an admitted node finishes, the session is woken once, and you must call workflow with action=wait and that run_id to admit the next ready nodes or record the result. If a call is interrupted, the same wake applies.",
  "cancel, retry, send and amend act inside the call that names them. retry and amend re-enter the run: like wait, they admit the nodes that can start now and return (detach defaults to true), or block until the run settles with detach=false. cancel_node applies only to a run the user stopped, which OpenCode 2 does not have yet; use cancel for the whole run.",
  "On OpenCode 2 a node's load_skills are checked against this session's skill permissions when start, amend or a retry with prompt runs: a denied skill fails that call and changes nothing. Nodes that resolve to process execution mode are refused.",
  "snapshot carries each settled node's own output plus outputBytes, and each running node's lastActivityAt.",
].join(" ")
