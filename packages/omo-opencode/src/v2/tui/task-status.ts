import { formatTaskElapsed } from "@oh-my-opencode/senpi-task/task-widget"
import { taskStatusSchema, type TaskStatusEntry, type TaskStatusSnapshot } from "../rpc/task"
import { createSessionStatusView } from "./session-status-view"

const MAX_ROWS = 5
const LINE_MAX = 120
export const TASK_TERMINAL_LINGER_MS = 60_000
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const
const STILL_MARK = "‖"
const PENDING_MARK = "…"
const TERMINAL_MARKS: Readonly<Record<string, string>> = { completed: "✓", cancelled: "⊘" }
const FAILED_MARK = "✗"

export function createTaskStatusView(deps: {
  readonly load: (sessionID: string, signal: AbortSignal) => Promise<unknown>
  readonly subscribe: (handler: (data: unknown) => void) => () => void
  readonly changed: () => void
}) {
  return createSessionStatusView<TaskStatusSnapshot>({ ...deps, schema: taskStatusSchema, name: "Task panel" })
}

const compact = (value: string) =>
  value
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
const bounded = (value: string) => {
  const text = compact(value)
  return text.length > LINE_MAX ? `${text.slice(0, LINE_MAX - 3)}...` : text
}

function lingering(task: TaskStatusEntry, now: number): boolean {
  if (task.phase !== "terminal" || task.terminalAt === undefined) return false
  const endedAt = Date.parse(task.terminalAt)
  return Number.isFinite(endedAt) && now - endedAt < TASK_TERMINAL_LINGER_MS
}

export function visibleTasks(status: TaskStatusSnapshot | undefined, now: number): TaskStatusEntry[] {
  if (!status) return []
  // Like Native's widget: background tasks only; attached ones (workflow nodes, sync calls) block their caller.
  const background = status.tasks.filter((task) => task.background)
  const live = background.filter((task) => task.phase !== "terminal")
  const finished = background.filter((task) => lingering(task, now))
  return [...live, ...finished]
}

function row(task: TaskStatusEntry, now: number): string {
  const frame = SPINNER_FRAMES[Math.floor(now / 1_000) % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0]
  const parts = [task.label, task.target]
  if (task.phase === "terminal") {
    const mark = TERMINAL_MARKS[task.status] ?? FAILED_MARK
    const ended = task.terminalAt === undefined ? now : Date.parse(task.terminalAt)
    parts.push(task.status, formatTaskElapsed(task.startedAt ?? task.createdAt, ended))
    const line = `${mark} ${parts.join(" · ")}`
    return task.result === undefined ? line : `${line}: ${task.result}`
  }
  if (task.phase === "still") {
    parts.push(task.detail === undefined ? task.statusLabel : `${task.statusLabel} (${task.detail})`)
    return `${STILL_MARK} ${parts.join(" · ")}`
  }
  parts.push(task.detail === undefined ? task.status : `${task.status} (${task.detail})`)
  parts.push(formatTaskElapsed(task.createdAt, now))
  return `${task.phase === "pending" ? PENDING_MARK : frame} ${parts.join(" · ")}`
}

export function taskStatusLines(status: TaskStatusSnapshot | undefined, now: number): string[] {
  const tasks = visibleTasks(status, now)
  if (tasks.length === 0) return []
  const counts = new Map<string, number>()
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1)
  const header = ["Tasks", ...[...counts].map(([state, count]) => `${state}:${count}`)].join(" ")
  const lines = [header, ...tasks.slice(0, MAX_ROWS).map((task) => row(task, now))]
  if (tasks.length > MAX_ROWS) lines.push(`+${tasks.length - MAX_ROWS} more (omo.task.status)`)
  return lines.map(bounded)
}
