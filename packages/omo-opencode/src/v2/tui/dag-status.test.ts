import { describe, expect, test } from "bun:test"
import { createDagStatusView, dagStatusLines } from "./dag-status"
import type { DagStatus } from "../rpc/dag"

const running: DagStatus = {
  sessionID: "a",
  runs: [
    {
      runId: "dag_1",
      runKey: "build",
      name: "Build",
      status: "running",
      counts: {
        total: 2,
        pending: 0,
        blocked: 0,
        scheduled: 0,
        running: 1,
        completed: 0,
        failed: 1,
        cancelled: 0,
        skipped: 0,
      },
      nodes: [
        { id: "compile", state: "running" },
        { id: "test", state: "failed", error: { code: "tool_error", message: "Bad\ninput" } },
      ],
    },
  ],
}

describe("DAG panel data", () => {
  test("#given terminal history and live runs #when projected #then only live runs and the session's latest failure remain visible", () => {
    const run = running.runs[0]
    if (run === undefined) throw Error("fixture run missing")
    const completed = {
      ...run,
      runId: "dag_completed",
      name: "Old success",
      status: "completed" as const,
      counts: { ...run.counts, running: 0, completed: 2, failed: 0 },
      nodes: run.nodes.map((node) => ({ ...node, state: "completed" as const })),
    }
    const cancelled = {
      ...completed,
      runId: "dag_cancelled",
      name: "Old cancellation",
      status: "cancelled" as const,
      counts: { ...run.counts, running: 0, cancelled: 2, failed: 0 },
      nodes: run.nodes.map((node) => ({ ...node, state: "cancelled" as const })),
    }
    const failed = {
      ...run,
      runId: "dag_failed",
      name: "Latest failure",
      status: "failed" as const,
      counts: { ...run.counts, running: 0, completed: 1 },
      nodes: run.nodes.map((node) => (node.state === "running" ? { ...node, state: "completed" as const } : node)),
    }
    // when: the RPC orders runs newest first, and still includes terminal history.
    const terminalOnly = dagStatusLines({ sessionID: "a", runs: [completed, cancelled] })
    const active = dagStatusLines({ sessionID: "a", runs: [run, completed] }).join("\n")
    const latestFailure = dagStatusLines({ sessionID: "a", runs: [failed, completed] }).join("\n")
    const supersededFailure = dagStatusLines({ sessionID: "a", runs: [completed, failed] })
    const held = dagStatusLines({
      sessionID: "a",
      runs: [completed, { ...run, status: "paused" }, { ...run, runId: "dag_pending", status: "pending" }],
    }).join("\n")
    // then
    expect(terminalOnly).toEqual([])
    expect(active).toContain("Build [dag_1]")
    expect(active).not.toContain("Old success")
    expect(latestFailure).toContain("Latest failure [dag_failed]")
    expect(supersededFailure).toEqual([])
    expect(held).toContain("paused")
    expect(held).toContain("[dag_pending]")
    expect(held).not.toContain("Old success")
  })

  test("#given an in-flight hydration #when a newer event and session switch arrive #then stale responses cannot replace the visible session", async () => {
    const requests = new Map<string, PromiseWithResolvers<unknown>>()
    let listener: ((data: unknown) => void) | undefined
    let unsubscribed = false
    const view = createDagStatusView({
      load: (sessionID) => {
        const request = Promise.withResolvers<unknown>()
        requests.set(sessionID, request)
        return request.promise
      },
      subscribe: (handle) => {
        listener = handle
        return () => {
          unsubscribed = true
        }
      },
      changed() {},
    })
    view.select("a")
    listener?.(running)
    requests.get("a")?.resolve({ sessionID: "a", runs: [] })
    await Promise.resolve()
    expect(view.snapshot()).toEqual(running)
    view.select("b")
    listener?.(running)
    requests.get("b")?.resolve({ sessionID: "b", runs: [] })
    await Promise.resolve()
    expect(view.snapshot()).toEqual({ sessionID: "b", runs: [] })
    view.close()
    listener?.({ sessionID: "b", runs: running.runs })
    expect(unsubscribed).toBe(true)
    expect(view.snapshot()?.runs).toEqual([])
  })

  test("#given empty, active and large runs #when rendered #then the panel hides empty state and bounds summaries with running and failure details", () => {
    expect(dagStatusLines({ sessionID: "a", runs: [] })).toEqual([])
    const lines = dagStatusLines(running)
    expect(lines.join("\n")).toContain("Build [dag_1]")
    expect(lines.join("\n")).toContain("running:1")
    expect(lines.join("\n")).toContain("compile")
    expect(lines.join("\n")).toContain("test: tool_error: Bad input")
    const run = running.runs[0]
    if (run === undefined) throw Error("fixture run missing")
    const many = {
      ...running,
      runs: Array.from({ length: 20 }, (_, index) => ({ ...run, runId: `dag_${index}`, name: "x".repeat(300) })),
    }
    const bounded = dagStatusLines(many)
    expect(bounded.length).toBeLessThanOrEqual(18)
    expect(bounded.every((line) => line.length <= 90)).toBe(true)
    expect(bounded[1]).toContain("[dag_0]")
    expect(bounded.at(-1)).toContain("17 more")
    const states = {
      ...running,
      runs: [
        {
          ...run,
          counts: {
            total: 9,
            pending: 1,
            blocked: 1,
            scheduled: 1,
            running: 1,
            paused: 1,
            completed: 1,
            failed: 1,
            cancelled: 1,
            skipped: 1,
          },
        },
      ],
    }
    expect(dagStatusLines(states).join("\n")).toContain("skipped:1")
  })
})
