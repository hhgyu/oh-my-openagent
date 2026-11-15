import { describe, expect, test } from "bun:test"

import { createTaskRecord, type TaskRecord } from "./state"
import {
  formatTaskElapsed,
  isSuspendedTask,
  selectLiveTaskRecords,
  taskStatusDescription,
  taskStatusLabel,
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
    test("#then it stays in the live selection however long its child has been idle", () => {
      // given
      const running = record({
        status: "running",
        task_summary: "Wait on build",
        started_at: "2026-11-15T00:00:01.000Z",
      })

      // when
      const live = selectLiveTaskRecords([running])

      // then
      expect(live).toEqual([running])
      expect(taskStatusLabel(running)).toBe("running")
    })
  })

  describe("#given task records that turned terminal", () => {
    test("#then they leave the live selection", () => {
      // given
      const completed = record({ status: "completed", final_response: "CHILD_FINAL done" })
      const cancelled = record({ task_id: "st_0000000b", status: "cancelled", error_message: "cancelled by parent" })

      // when
      const live = selectLiveTaskRecords([completed, cancelled])

      // then
      expect(live).toEqual([])
    })
  })

  describe("#given a child parked by a restarted parent", () => {
    test("#then it is suspended and labelled with its recovery state until it finishes", () => {
      // given
      const parked = record({ status: "running", residency_state: "persisted_only" })
      const finished = record({ status: "completed", residency_state: "persisted_only" })

      // when / then
      expect(isSuspendedTask(parked)).toBe(true)
      expect(taskStatusLabel(parked)).toBe("resuming")
      expect(isSuspendedTask(finished)).toBe(false)
    })
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
