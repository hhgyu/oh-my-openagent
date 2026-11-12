import type { PersistedTaskEvent } from "../store"
import type { ManagedChildEvent, ManagedChildHandle } from "./child-handle"
import { applyModelEvent, type ModelEventStore } from "./runtime-fallback-event"

import { toPersistedEvent } from "@oh-my-opencode/orchestration-core/transcript/events"
export {
  TRANSCRIPT_ASSISTANT_EVENT,
  TRANSCRIPT_TOOL_EVENT,
  TRANSCRIPT_ERROR_EVENT,
} from "@oh-my-opencode/orchestration-core/transcript/events"

export type TranscriptLogStore = {
  readonly appendEvent: (taskId: string, event: PersistedTaskEvent) => string
  readonly load?: ModelEventStore["load"]
  readonly replace?: ModelEventStore["replace"]
  readonly isOwnEffect?: ModelEventStore["isOwnEffect"]
}

// Persist the transcript-relevant slice of a child event: assistant prose from message_end, a tool
// marker from tool_execution_end, and a child_error breadcrumb when the assistant message carries a
// stopReason "error" diagnostic (otherwise a failed turn leaves NO trace and task_output reads an
// empty transcript). Every other event is ignored so the log stays a clean transcript.
export function logTranscriptEvent(store: TranscriptLogStore, taskId: string, event: ManagedChildEvent): void {
  applyModelEvent(store, taskId, event)
  const persisted = toPersistedEvent(event)
  if (persisted !== undefined) store.appendEvent(taskId, persisted)
}

// Subscribe a running child's events into the store transcript log. Returns the unsubscribe so the
// manager can detach on dispose. READ path only feeds OUR log; it never mutates child state.
export function subscribeTranscriptLog(
  handle: ManagedChildHandle,
  store: TranscriptLogStore,
  taskId: string,
): () => void {
  return handle.subscribe((event) => logTranscriptEvent(store, taskId, event))
}
