import { isTerminalStatus } from "./completion/status-edge"
import { normalizeRendererText, optionalRendererText } from "./renderer-text"
import type { TaskRecord } from "./state"
import { recoveryPresentation } from "./state/recovery-presentation"
import { formatStatusTarget } from "./status-line"

// The live task widget model: which records it lists, what it calls them and which state it shows.
// Native's status widget (omo-senpi status-row-format) reads it.

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
