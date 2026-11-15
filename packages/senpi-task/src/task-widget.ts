import { isTerminalStatus } from "./completion/status-edge"
import { excerptModelText } from "./model-text"
import { normalizeRendererText, optionalRendererText } from "./renderer-text"
import type { TaskRecord, TaskStatus } from "./state"
import { recoveryPresentation } from "./state/recovery-presentation"
import { formatStatusTarget } from "./status-line"

// The harness-neutral model of the live task widget: which records it lists, what it calls them and
// which state it shows. Native's status widget (omo-senpi status-row-format) and the OpenCode 2 task
// panel both read it, so the two hosts cannot disagree about when a task is running.

const PROGRESS_HEAD_MAX = 60
const MAX_ENTRY_TEXT = 200

/**
 * Whether a live child is parked rather than running here. A host that gave up records
 * `suspension_reason`, while an ordinary suspension (the parent session ended or restarted) shows up
 * only as a residency other than `resident`. Only a child that has not finished can be parked.
 */
export function isSuspendedTask(record: TaskRecord): boolean {
  return !isTerminalStatus(record.status) && recoveryPresentation(record) !== undefined
}

export function taskStatusDescription(record: TaskRecord): string {
  return (
    optionalRendererText(record.task_summary) ??
    optionalRendererText(record.description) ??
    optionalRendererText(record.name) ??
    normalizeRendererText(record.task_id)
  )
}

export function taskStatusLabel(record: TaskRecord): string {
  return recoveryPresentation(record)?.state ?? normalizeRendererText(record.status)
}

export function taskRecordStatusTarget(record: TaskRecord): string {
  return (
    formatStatusTarget({
      category: record.category,
      agentType: record.agent_type,
      resolvedModel: record.resolved_model,
      effectiveModel: record.effective_model,
      model: record.model,
      fallbackCount: record.fallback_attempts?.length,
    }) ?? "task"
  )
}

export function formatTaskElapsed(fromIso: string, now: number): string {
  const startedAt = Date.parse(fromIso)
  const elapsedSeconds = Number.isFinite(startedAt) ? Math.max(0, Math.floor((now - startedAt) / 1_000)) : 0
  const minutes = Math.floor(elapsedSeconds / 60)
  const seconds = elapsedSeconds % 60
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`
}

/**
 * The live widget shows work that is still running or parked. A finished child leaves it; a child
 * revived by task_send is non-terminal again, so its row returns.
 */
export function selectLiveTaskRecords(records: readonly TaskRecord[]): TaskRecord[] {
  return records.filter((record) => !isTerminalStatus(record.status))
}

/** The widget's session scope: tasks this session spawned, plus every task of the tree it roots. */
export function taskRecordInSession(record: TaskRecord, sessionId: string): boolean {
  return record.parent_session_id === sessionId || record.root_session_id === sessionId
}

export type TaskWidgetPhase = "pending" | "running" | "still" | "terminal"

/** A read-only widget row: labels and timestamps only, never the prompt or the child's transcript. */
export type TaskWidgetEntry = {
  readonly taskId: string
  readonly label: string
  readonly status: TaskStatus
  readonly phase: TaskWidgetPhase
  readonly statusLabel: string
  readonly target: string
  readonly background: boolean
  readonly parentSessionId: string
  readonly depth: number
  readonly createdAt: string
  readonly startedAt?: string
  readonly terminalAt?: string
  readonly detail?: string
  readonly result?: string
}

function phaseOf(record: TaskRecord): TaskWidgetPhase {
  if (isTerminalStatus(record.status)) return "terminal"
  if (isSuspendedTask(record) || record.status === "paused") return "still"
  return record.status === "pending" ? "pending" : "running"
}

function bounded(value: string | undefined, width: number): string | undefined {
  const text = optionalRendererText(value)
  return text === undefined ? undefined : excerptModelText(text, width)
}

export function projectTaskWidgetEntry(record: TaskRecord): TaskWidgetEntry {
  const detail = bounded(
    recoveryPresentation(record)?.cause ??
      (record.awaiting_input === undefined || isTerminalStatus(record.status)
        ? undefined
        : `awaiting input: ${record.awaiting_input.reason}`),
    MAX_ENTRY_TEXT,
  )
  const result =
    record.status === "completed"
      ? bounded(record.final_response, PROGRESS_HEAD_MAX)
      : isTerminalStatus(record.status)
        ? bounded(record.error_message, PROGRESS_HEAD_MAX)
        : undefined
  return {
    taskId: record.task_id,
    label: excerptModelText(taskStatusDescription(record), MAX_ENTRY_TEXT),
    status: record.status,
    phase: phaseOf(record),
    statusLabel: taskStatusLabel(record),
    target: excerptModelText(taskRecordStatusTarget(record), MAX_ENTRY_TEXT),
    background: record.notify_on_terminal,
    parentSessionId: record.parent_session_id,
    depth: record.depth,
    createdAt: record.created_at,
    ...(record.started_at === undefined ? {} : { startedAt: record.started_at }),
    ...(record.terminal_at === undefined ? {} : { terminalAt: record.terminal_at }),
    ...(detail === undefined ? {} : { detail }),
    ...(result === undefined ? {} : { result }),
  }
}
