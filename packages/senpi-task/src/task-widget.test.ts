import { describe, expect, test } from "bun:test"

import { createTaskRecord, type TaskRecord } from "./state"
import {
  formatTaskElapsed,
  projectTaskWidgetEntry,
  selectLiveTaskRecords,
  taskRecordInSession,
  taskStatusDescription,
} from "./task-widget"

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const base = createTaskRecord({
    task_id: "st_0000000a",
    parent_session_id: "ses_parent",
    root_session_id: "ses_root",
    depth: 1,
    category: "quick",
    execution_mode: "in-process",
    model: "mock/model",
    notify_on_terminal: true,
  })
  return { ...base, created_at: "2026-11-15T00:00:00.000Z", ...overrides }
}

describe("task widget model", () => {
  describe("#given a background task whose record is still running", () => {
    test("#then it projects as a live running row however long its child has been idle", () => {
      // given
      const running = record({
        status: "running",
        task_summary: "Wait on build",
        started_at: "2026-11-15T00:00:01.000Z",
      })

      // when
      const entry = projectTaskWidgetEntry(running)

      // then
      expect(entry).toMatchObject({ status: "running", phase: "running", label: "Wait on build", background: true })
      expect(entry.result).toBeUndefined()
      expect(selectLiveTaskRecords([running])).toEqual([running])
    })
  })

  describe("#given a task record that turned terminal", () => {
    test("#then the row carries the terminal state and the head of its result, and leaves the live selection", () => {
      // given
      const completed = record({
        status: "completed",
        terminal_at: "2026-11-15T00:00:41.000Z",
        final_response: "CHILD_FINAL done",
      })
      const cancelled = record({ task_id: "st_0000000b", status: "cancelled", error_message: "cancelled by parent" })

      // when
      const entries = [completed, cancelled].map(projectTaskWidgetEntry)

      // then
      expect(entries[0]).toMatchObject({ phase: "terminal", status: "completed", result: "CHILD_FINAL done" })
      expect(entries[1]).toMatchObject({ phase: "terminal", status: "cancelled", result: "cancelled by parent" })
      expect(selectLiveTaskRecords([completed, cancelled])).toEqual([])
    })
  })

  describe("#given a child that is parked, paused or waiting for input", () => {
    test("#then a parked or paused child is still, and a waiting one says why", () => {
      // given
      const parked = record({ status: "running", residency_state: "persisted_only" })
      const paused = record({ status: "paused" })
      const waiting = record({ status: "running", awaiting_input: { reason: "resumed_turn_aborted", since: "x" } })

      // when
      const [parkedEntry, pausedEntry, waitingEntry] = [parked, paused, waiting].map(projectTaskWidgetEntry)

      // then
      expect(parkedEntry).toMatchObject({ phase: "still", statusLabel: "resuming", detail: "parent session restarted" })
      expect(pausedEntry?.phase).toBe("still")
      expect(waitingEntry).toMatchObject({ phase: "running", detail: "awaiting input: resumed_turn_aborted" })
    })
  })

  test("#given a task with a prompt #then the projection never carries the prompt", () => {
    // given
    const secret = "PROMPT_SECRET_DO_NOT_SHOW"
    const withPrompt = record({
      status: "running",
      description: "Visible label",
      spawn_spec: { version: 1, cwd: "/project", prompt: secret },
    })

    // when
    const entry = projectTaskWidgetEntry(withPrompt)

    // then
    expect(JSON.stringify(entry)).not.toContain(secret)
    expect(entry.label).toBe("Visible label")
  })

  test("#given label sources #then the summary beats the description, which beats the name, then the id", () => {
    // given
    const all = record({ task_summary: "summary", description: "description", name: "name" })

    // when / then
    expect(taskStatusDescription(all)).toBe("summary")
    expect(taskStatusDescription(record({ description: "description", name: "name" }))).toBe("description")
    expect(taskStatusDescription(record({ name: "name" }))).toBe("name")
    expect(taskStatusDescription(record())).toBe("st_0000000a")
  })

  test("#given a session #then the scope is its own spawns plus the tree it roots", () => {
    // given
    const task = record()

    // when / then
    expect(taskRecordInSession(task, "ses_parent")).toBe(true)
    expect(taskRecordInSession(task, "ses_root")).toBe(true)
    expect(taskRecordInSession(task, "ses_other")).toBe(false)
  })

  test("#given timestamps #then elapsed reads seconds, then minutes and seconds", () => {
    // given
    const from = "2026-11-15T00:00:00.000Z"
    const start = Date.parse(from)

    // when / then
    expect(formatTaskElapsed(from, start + 42_000)).toBe("42s")
    expect(formatTaskElapsed(from, start + 184_000)).toBe("3m 4s")
    expect(formatTaskElapsed("not a date", start)).toBe("0s")
  })
})
