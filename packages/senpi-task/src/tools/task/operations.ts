// Native-support operations shared with explicit host adapters. Factories and UI stay at their old paths.
export { resolveTaskAgents } from "../../agents/task-agents"
export { buildSkillPrepend } from "./skills"
export { filterSharedParentTools } from "../../runners/in-process/shared-tool-filter"
export { CHILD_HOST_TOOLS, childStructuralToolNames } from "../../runners/in-process/host-tools"
// The SAME process-wide task id floor the manager seeds from its own store.
export { parseTaskId, syncTaskIdFloor } from "../../state/id"
export type { DagTaskOwner } from "../../dag/owner"
// The SAME completion routing/message functions the Native notifier uses.
export { shouldNotifyRecord } from "../../completion/routing"
export { buildCompletionMessage } from "../../completion/notification"
// Original context-free member closures; no adapter or engine barrel initialization.
export { createMemberTaskSendTool, MemberTaskSendParams } from "../../team/member-extension/tools"
export type {
  MemberTaskSendDeps,
  MemberTaskSendTool,
  MemberTaskSendInput,
  MemberTaskSendDetails,
} from "../../team/member-extension/tools"
export { createWorkpoolWorkerTool } from "../workpool"
export type { WorkpoolToolResult, WorkpoolWorkerDeps, WorkpoolWorkerTool } from "../workpool"
// The ORIGINAL curated read-only broker policy, factory and executor; hosts supply their own formatter.
export {
  createCuratedReadonlyBashTool,
  CuratedReadonlyBashParams,
  CuratedReadonlyCommandError,
  executeCuratedReadonlyCommand,
} from "../../runners/in-process/curated-readonly-bash"
export type {
  CuratedReadonlyBashInput,
  CuratedReadonlyBashTool,
  CuratedReadonlyChildObserver,
  CuratedReadonlyCommand,
  CuratedReadonlyExecutor,
  CuratedReadonlyRequest,
} from "../../runners/in-process/curated-readonly-bash"
export { buildTaskExecute } from "./execute"
export { evaluateSpawnPolicy } from "./spawn-policy"
export { TaskToolParams } from "./params"
export type { TaskToolParamsStatic } from "./params"
export { normalizeTaskToolArguments } from "./argument-normalization"
export { createToolArgumentValidator, ToolArgumentValidationError } from "../argument-validation"
export { buildTaskToolDescription, TASK_PROMPT_GUIDELINES, TASK_PROMPT_SNIPPET } from "./description"
export type { ForegroundWaitOptions, ScheduleDeadline } from "./foreground-wait"
export type {
  TaskOperationManager,
  TaskToolContext,
  TaskToolDeps,
  TaskToolDetails,
  TaskToolItemDetail,
  TaskAncestry,
  ResolveAncestry,
  SkillLoader,
  SkillResolution,
  LoadedSkill,
  TaskSkillSummary,
} from "./types"
export { runTaskSend, TASK_SEND_TOOL_DESCRIPTION } from "../control/send"
export { TaskSendParams } from "../control/send-schema"
export type { TaskSendInput } from "../control/send-schema"
export type { TaskSendRunOptions, TaskSendTeamRouting, LateSendOutcome, LateSendDelivery } from "../control/send"
export { runTaskCancel, TaskCancelParams, TASK_CANCEL_TOOL_DESCRIPTION } from "../control/cancel"
export type { TaskCancelInput } from "../control/cancel"
export type {
  SendManager,
  CancelManager,
  SendToolResult,
  CancelToolResult,
  SendResultDetails,
  CancelResultDetails,
} from "../control/types"
export { runTaskOutput, TaskOutputParams, forgetTaskOutputSessionReads } from "../output/output"
export type { TaskOutputInput } from "../output/output"
export type {
  TaskOutputDeps,
  TaskOutputDetails,
  TaskOutputToolResult,
  OutputManager,
  TranscriptReader,
} from "../output/types"

// Shared Native completion/store support. Old adapter paths reexport these SAME definitions.
export { createCompletionObservingStore } from "../../completion/observing-store"
export type { CompletionBridgeDeps } from "../../completion/observing-store"
export { createMutationNotifyingStore } from "../../completion/mutation-store"
export type { StoreMutation } from "../../completion/mutation-store"
export { isTerminalStatus, watchStatusEdge } from "../../completion/status-edge"
export type { StatusEdgeWatch } from "../../completion/status-edge"
export { createConfigGenerationStampingStore } from "../../completion/config-generation-store"
export {
  TASK_TERMINAL_OBSERVERS_KEY,
  createTaskTerminalObservers,
  sharedTaskTerminalObservers,
} from "../../completion/terminal-observers"
export type { TaskTerminalEdge, TaskTerminalObserver, TaskTerminalObservers } from "../../completion/terminal-observers"

// Shared Native injection batching/receipt definitions; adapter paths are identity-preserving shims.
export { IdleInjectionCoordinator, IdleInjectionRetiredError } from "../../injection/coordinator"
export type {
  IdleInjectionSource,
  IdleInjection,
  IdleInjectionMessage,
  IdleInjectionDelivery,
  FlushScheduler,
  IdleInjectionCoordinatorOptions,
} from "../../injection/coordinator"
export { withSuperseded, admissionBatches, failItems, settleItemReceipts } from "../../injection/items"
export type { AdmissionItem, ItemReceipt, QueuedInjection } from "../../injection/items"
export { NO_RECEIPT_ERRORS, runReceipts } from "../../injection/receipts"
export type { ReceiptErrors } from "../../injection/receipts"

// Optional deferred completion source custody; no host transport or authority is supplied here.
export { createCompletionNotifier } from "../../completion/notifier"
export type {
  CompletionDeliverySource,
  CompletionNotifier,
  CompletionNotifierDeps,
  CompletionNotifierStore,
  ParentNotifier,
  ParentNotifierMessage,
  NotifyResult,
  FlushResult,
} from "../../completion/types"
