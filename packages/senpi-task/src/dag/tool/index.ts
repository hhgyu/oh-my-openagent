// DAG operations shared with explicit host adapters: the workflow tool's action logic, params and
// wire contract, plus the runtime controls, run-pause source, paused-node cancel and retention sweep
// a host runtime composes, without the engine barrel.
export { WORKFLOW_TOOL_NAME, runDagTool } from "./dag-tool"
export { DagToolParams } from "./dag-tool-params"
export type { DagToolDefinitionInput, DagToolInput } from "./dag-tool-params"
export type {
  DagToolDeps,
  DagToolDetails,
  DagToolError,
  DagToolErrorCode,
  DagToolNodeError,
  DagToolResult,
  DagToolSendDelivery,
  DagToolSendOutcome,
} from "./dag-tool-contract"
export { createDagRuntimeControls } from "./dag-runtime-controls"
export { createDagRunPauseSource } from "./dag-run-pause-source"
export type { DagGuidanceDelivery } from "./dag-run-pause-source"
export { createPausedNodeCancel, endedChildClosure, endPausedRunChildren } from "./dag-paused-cancel"
export type { PausedNodeHoldPort } from "./dag-paused-cancel"
export { scheduleDagRetentionSweep } from "./dag-retention-sweep"
export type { DagRetentionSweepOptions } from "./dag-retention-sweep"
