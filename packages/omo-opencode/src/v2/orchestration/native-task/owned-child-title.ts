import type { TaskRecord } from "@oh-my-opencode/senpi-task/manager-kernel"
import { ELLIPSIS, optionalRendererText } from "@oh-my-opencode/senpi-task/renderer-text"

/** Sidebar budget for an owned child's session title, id suffix included (the observation schema caps titles at 4096). */
export const OWNED_CHILD_TITLE_MAX = 120

type TitleSource = Pick<TaskRecord, "task_summary" | "description" | "name">

/**
 * Session title of an owned child. Uses the same source precedence as the Senpi task status row
 * (`taskStatusDescription`: task_summary, then description, then name) so both hosts label a task alike,
 * followed by the task id. The kernel's default name (the task id itself) is not a label; without any label
 * the historical `Native task <id>` title is kept.
 */
export function ownedChildTitle(taskId: string, record: TitleSource | undefined): string {
  const id = optionalRendererText(taskId) ?? taskId
  const name = optionalRendererText(record?.name)
  const label =
    optionalRendererText(record?.task_summary) ??
    optionalRendererText(record?.description) ??
    (name === id ? undefined : name)
  if (label === undefined) return `Native task ${id}`
  const suffix = ` (${id})`
  return `${clip(label, OWNED_CHILD_TITLE_MAX - suffix.length)}${suffix}`
}

function clip(text: string, budget: number): string {
  if (text.length <= budget) return text
  const room = Math.max(0, budget - ELLIPSIS.length)
  let kept = ""
  for (const point of text) {
    if (kept.length + point.length > room) break
    kept += point
  }
  return `${kept.trimEnd()}${ELLIPSIS}`
}
