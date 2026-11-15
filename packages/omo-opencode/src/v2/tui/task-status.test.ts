import { describe, expect, test } from "bun:test"
import type { TaskStatusEntry, TaskStatusSnapshot } from "../rpc/task"
import { TASK_TERMINAL_LINGER_MS, createTaskStatusView, taskStatusLines } from "./task-status"

const START = Date.parse("2026-11-15T00:00:00.000Z")

function entry(overrides: Partial<TaskStatusEntry> & Pick<TaskStatusEntry, "taskId">): TaskStatusEntry {
  return {
    label: "Wait on shell",
    status: "running",
    phase: "running",
    statusLabel: "running",
    target: "category:quick",
    background: true,
    parentSessionId: "ses_root",
    depth: 1,
    createdAt: new Date(START).toISOString(),
    ...overrides,
  }
}

function snapshot(tasks: TaskStatusEntry[]): TaskStatusSnapshot {
  return { sessionID: "ses_root", tasks }
}

describe("OmO task panel lines", () => {
  test("#given a running record #then the row stays running with a growing clock", () => {
    // given
    const status = snapshot([entry({ taskId: "st_1" })])

    // when
    const early = taskStatusLines(status, START + 5_000)
    const late = taskStatusLines(status, START + 40_000)

    // then
    expect(early[0]).toBe("Tasks running:1")
    expect(early[1]).toContain("Wait on shell · category:quick · running · 5s")
    expect(late[1]).toContain("running · 40s")
  })

  test("#given a terminal record #then it shows its terminal state and result, then leaves after the linger", () => {
    // given
    const terminalAt = START + 41_000
    const status = snapshot([
      entry({
        taskId: "st_1",
        status: "completed",
        phase: "terminal",
        startedAt: new Date(START + 1_000).toISOString(),
        terminalAt: new Date(terminalAt).toISOString(),
        result: "CHILD_FINAL ok",
      }),
      entry({ taskId: "st_2", status: "cancelled", phase: "terminal", terminalAt: new Date(terminalAt).toISOString() }),
    ])

    // when
    const shown = taskStatusLines(status, terminalAt + 1_000)
    const gone = taskStatusLines(status, terminalAt + TASK_TERMINAL_LINGER_MS)

    // then
    expect(shown[0]).toBe("Tasks completed:1 cancelled:1")
    expect(shown[1]).toBe("✓ Wait on shell · category:quick · completed · 40s: CHILD_FINAL ok")
    expect(shown[2]).toContain("⊘ Wait on shell · category:quick · cancelled")
    expect(gone).toEqual([])
  })

  test("#given an attached task #then only background tasks are listed, as in Native's widget", () => {
    // given
    const status = snapshot([entry({ taskId: "st_1", background: false }), entry({ taskId: "st_2", label: "Bg" })])

    // when
    const lines = taskStatusLines(status, START)

    // then
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain("Bg ·")
  })

  test("#given a parked child #then its row is still and has no clock", () => {
    // given
    const status = snapshot([
      entry({ taskId: "st_1", phase: "still", statusLabel: "resuming", detail: "parent session restarted" }),
    ])

    // when
    const lines = taskStatusLines(status, START + 90_000)

    // then
    expect(lines[1]).toBe("‖ Wait on shell · category:quick · resuming (parent session restarted)")
  })

  test("#given more live tasks than rows #then the panel caps the rows and counts the rest", () => {
    // given
    const status = snapshot(Array.from({ length: 7 }, (_, index) => entry({ taskId: `st_${index}` })))

    // when
    const lines = taskStatusLines(status, START)

    // then
    expect(lines).toHaveLength(7)
    expect(lines.at(-1)).toBe("+2 more (omo.task.status)")
  })

  test("#given an update for another session #then the view keeps the selected session's snapshot", async () => {
    // given
    let push: ((data: unknown) => void) | undefined
    const loaded = Promise.withResolvers<undefined>()
    const view = createTaskStatusView({
      load: async () => snapshot([entry({ taskId: "st_1" })]),
      subscribe: (handler) => {
        push = handler
        return () => undefined
      },
      changed: () => {
        if (view.snapshot() !== undefined) loaded.resolve(undefined)
      },
    })
    view.select("ses_root")
    const breaker = setTimeout(() => loaded.reject(Error("waited 5s for the load, never accepted")), 5_000)
    await loaded.promise.finally(() => clearTimeout(breaker))

    // when
    push?.({ sessionID: "ses_other", tasks: [] })

    // then
    expect(view.snapshot()?.tasks.map((task) => task.taskId)).toEqual(["st_1"])
    view.close()
  })
})
