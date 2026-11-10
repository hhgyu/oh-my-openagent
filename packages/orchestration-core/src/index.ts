export {
  TASK_START_FAILURE_KINDS,
  MODEL_START_FAILURE_REASONS,
  HOST_START_FAILURE_REASONS,
  SESSION_START_FAILURE_REASONS,
  TASK_START_FAILURE_REASONS,
  isTaskStartFailureKind,
  isTaskStartFailureReason,
} from "./contracts/task-start-failure"
export type {
  TaskStartFailureKind,
  TaskStartFailureReason,
  TaskStartFailureRecordFields,
  TaskStartFailureTransition,
} from "./contracts/task-start-failure"
export type { TaskInterruptCause, ChildCompletionPolicy, RunnerFailureReason, RunnerFailure, RunnerOutcome } from "./contracts/child-outcome"
export { RunnerError } from "./contracts/runner-error"
export type { ManagedChildEvent, ManagedChildListener } from "./contracts/child-event"
export type { TranscriptEntry, TranscriptSource, TranscriptReadResult, TranscriptReader, ProjectedTranscriptEvent } from "./contracts/transcript"
export { TRANSCRIPT_ASSISTANT_EVENT, TRANSCRIPT_TOOL_EVENT, TRANSCRIPT_ERROR_EVENT, toPersistedEvent } from "./transcript/events"
export { MAX_TRANSCRIPT_SOURCE_BYTES, readBoundedFileText } from "./transcript/read-bounded"
export type { BoundedFileText } from "./transcript/read-bounded"
export { readEventLogTranscript, readEventLogTranscriptResult } from "./transcript/event-log"
export { TRANSCRIPT_MAX_CHARS, renderTranscript } from "./transcript/render"
export type { RenderOptions, RenderedTranscript } from "./transcript/render"
