import type { ToolDefinition } from "@code-yeongyu/senpi"

import {
  DagToolParams,
  WORKFLOW_TOOL_NAME,
  runDagTool as runSharedDagTool,
  type DagToolDeps,
  type DagToolDetails,
  type DagToolInput,
  type DagToolResult,
} from "@oh-my-opencode/senpi-task/dag-operations"
import { loadSenpiBarrel } from "../../../../senpi-task/src/lazy/senpi-barrel"

// The action logic lives in senpi-task's ./dag-operations; this adapter adds the Senpi tool shape
// and the lazy senpi-barrel warm-up, and re-exports the shared surface so the tool keeps ONE
// public import surface.
export { DagToolParams, WORKFLOW_TOOL_NAME } from "@oh-my-opencode/senpi-task/dag-operations"
export type {
  DagToolDefinitionInput,
  DagToolDeps,
  DagToolDetails,
  DagToolError,
  DagToolErrorCode,
  DagToolInput,
  DagToolNodeError,
  DagToolResult,
  DagToolSendDelivery,
  DagToolSendOutcome,
} from "@oh-my-opencode/senpi-task/dag-operations"

const DESCRIPTION = [
  "Dependency-graph execution for child tasks. COMPOSE THE SPEC PROGRAMMATICALLY INSIDE AN eval CELL - the kernel exposes this tool as `tool.workflow` alongside a JS SDK, so build the graph as code: partition the work into logically distinct steps, name one node per step, and wire the ordering as data. A graph is a program; write it as one instead of hand-authoring a call.",
  "A node starts only after every node it dependsOn has finished, and unrelated nodes run in parallel up to the resident-child cap.",
  "dependsOn is ordering ONLY - no upstream output is substituted into a downstream prompt, so each prompt must stand alone.",
  "Each node targets EITHER category OR subagent_type, never both; model is an explicit override valid only alongside subagent_type.",
  "start is idempotent per definition key: re-starting the same key with the same graph reuses the run instead of duplicating it.",
  "wait detaches by default against a live run: the session is woken as each node completes and when the run settles, and detach=false restores the blocking wait that returns the final result.",
  "snapshot carries each settled node's own output plus outputBytes, and each running node's lastActivityAt, so a midpoint peek can audit a child's claim and tell a working child from a silent one.",
  "When a run settles badly, do NOT start a new one: retry re-runs the failed nodes in place, amend edits the graph and re-runs only what changed, and send steers or revives one node's child.",
].join(" ")

// Dag skill materialization discovers skills synchronously through the senpi barrel, so start warms
// that lazy boundary first.
async function warmSenpiSkills(): Promise<void> {
  await loadSenpiBarrel()
}

export function runDagTool(deps: DagToolDeps, params: DagToolInput): Promise<DagToolResult> {
  return runSharedDagTool({ warmSkills: warmSenpiSkills, ...deps }, params)
}

export function createDagTool(deps: DagToolDeps): ToolDefinition<typeof DagToolParams, DagToolDetails> {
  return {
    name: WORKFLOW_TOOL_NAME,
    label: "Workflow",
    description: DESCRIPTION,
    parameters: DagToolParams,
    execute: (_toolCallId, params) => runDagTool(deps, params),
  }
}
