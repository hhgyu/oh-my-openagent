/// <reference path="../../../bun-test.d.ts" />

import { describe, expect, test } from "bun:test"

import { renderUlwExecuteContinuation, type ContinuableWork } from "./index"

const continuable: ContinuableWork = {
  work: {
    work_id: "w1",
    active_plan: ".omo/plans/p.md",
    plan_name: "p",
    started_at: "2026-11-14T00:00:00.000Z",
    session_ids: ["opencode:ses_1"],
  },
  planPath: "/project/.omo/plans/p.md",
  checklist: { total: 2, completed: 1, remaining: 1, nextTaskLabel: "2. second" },
}

describe("renderUlwExecuteContinuation", () => {
  test("#given a host task tool name #when rendering the directive #then the dispatch step names that tool", () => {
    // given
    const taskTool = "the host-only `delegate_x` tool"

    // when
    const rendered = renderUlwExecuteContinuation("/project", continuable, "opencode:ses_1", { taskTool })

    // then
    const dispatchStep = rendered.split("\n").find((line) => line.startsWith("3. "))
    expect(dispatchStep).toContain(taskTool)
  })

  test("#given no host task tool name #when rendering the directive #then it matches rendering with the default name", () => {
    // when
    const fallback = renderUlwExecuteContinuation("/project", continuable, "senpi:ses_1")
    const explicit = renderUlwExecuteContinuation("/project", continuable, "senpi:ses_1", {
      taskTool: "Senpi's `task` tool",
    })

    // then
    expect(fallback).toBe(explicit)
  })
})
