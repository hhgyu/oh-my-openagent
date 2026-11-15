import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTaskRecordStore, type TaskRecord } from "@oh-my-opencode/senpi-task/manager-kernel"
import { createTaskRecord } from "@oh-my-opencode/senpi-task"
import { taskStatusRpc, type TaskStatusSnapshot } from "../../rpc/task"
import { nativeTaskStateDir } from "./state-dir"
import { createTaskStatusRpc, type TaskStatusRpcPort } from "./task-status-rpc"

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "omo-task-status-"))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const stores = new Map<string, ReturnType<typeof createTaskRecordStore>>()
  function journal(root: string) {
    const stateDir = nativeTaskStateDir(directory, root)
    let store = stores.get(stateDir)
    if (!store) {
      store = createTaskRecordStore({ project_dir: directory, task: { state_dir: stateDir } })
      stores.set(stateDir, store)
      const opened = store
      cleanup.push(() => opened.close())
    }
    return { stateDir, store }
  }
  function server() {
    const status = createTaskStatusRpc({ directory, debounceMs: 60_000 })
    cleanup.push(() => status.close())
    const emitted: TaskStatusSnapshot[] = []
    let handler: ((sessionID: string) => Promise<TaskStatusSnapshot>) | undefined
    const rpc: TaskStatusRpcPort = {
      async register(definition, handlers) {
        expect(definition).toBe(taskStatusRpc)
        handler = (sessionID) =>
          handlers.status(
            { sessionID },
            {
              signal: new AbortController().signal,
              error: () => {
                throw Error("undeclared error")
              },
            },
          )
        return {
          async dispose() {},
          events: {
            async emit(_name, data) {
              emitted.push(data)
            },
          },
        }
      },
    }
    return {
      status,
      emitted,
      ready: status.register(rpc),
      read: async (sessionID: string) => {
        if (!handler) throw Error("not registered")
        return handler(sessionID)
      },
    }
  }
  return { directory, journal, server }
}

function task(overrides: Partial<TaskRecord> & Pick<TaskRecord, "task_id">): TaskRecord {
  const created = createTaskRecord({
    task_id: overrides.task_id,
    parent_session_id: "ses_root",
    root_session_id: "ses_root",
    depth: 1,
    category: "quick",
    execution_mode: "in-process",
    model: "mock/model",
    notify_on_terminal: true,
  })
  return { ...created, ...overrides }
}

describe("OmO task panel status RPC", () => {
  test("#given a running task whose child idles on background work #then it stays running until its record is terminal", async () => {
    // given
    const { journal, server } = harness()
    const { stateDir, store } = journal("ses_root")
    const host = server()
    await host.ready
    const running = task({ task_id: "st_000000a1", status: "running", task_summary: "Wait on shell" })
    store.save(running)

    // when
    host.status.observe(stateDir, running)
    await host.status.settled()
    const idleRead = await host.read("ses_root")
    const completed = { ...running, status: "completed" as const, final_response: "CHILD_FINAL ok" }
    store.replace(completed)
    host.status.observe(stateDir, completed)
    await host.status.settled()

    // then
    expect(idleRead.tasks).toMatchObject([{ taskId: "st_000000a1", status: "running", label: "Wait on shell" }])
    expect(host.emitted.map((snapshot) => snapshot.tasks[0]?.status)).toEqual(["running", "completed"])
    expect(host.emitted.at(-1)?.tasks[0]?.result).toBe("CHILD_FINAL ok")
  })

  test("#given an unchanged journal #then a repeated mutation emits no duplicate update", async () => {
    // given
    const { journal, server } = harness()
    const { stateDir, store } = journal("ses_root")
    const host = server()
    await host.ready
    const running = task({ task_id: "st_000000a2", status: "running" })
    store.save(running)

    // when
    host.status.observe(stateDir, running)
    await host.status.settled()
    host.status.observe(stateDir, running)
    await host.status.settled()

    // then
    expect(host.emitted).toHaveLength(1)
  })

  test("#given a restarted server #then it lists the still-running task straight from the journal", async () => {
    // given
    const { journal, server } = harness()
    journal("ses_root").store.save(task({ task_id: "st_000000a3", status: "running" }))
    const restarted = server()
    await restarted.ready

    // when
    const listed = await restarted.read("ses_root")

    // then
    expect(listed.tasks.map((entry) => [entry.taskId, entry.status])).toEqual([["st_000000a3", "running"]])
  })

  test("#given a nested task #then the child session sees its own spawn and other sessions see nothing", async () => {
    // given
    const { journal, server } = harness()
    journal("ses_root").store.save(
      task({ task_id: "st_000000a4", status: "running", parent_session_id: "ses_child", depth: 2 }),
    )
    const host = server()
    await host.ready

    // when
    const child = await host.read("ses_child")
    const root = await host.read("ses_root")
    const other = await host.read("ses_other")

    // then
    expect(child.tasks.map((entry) => entry.taskId)).toEqual(["st_000000a4"])
    expect(root.tasks.map((entry) => entry.taskId)).toEqual(["st_000000a4"])
    expect(other.tasks).toEqual([])
  })

  test("#given a record stored under another root's directory #then no session is attributed to it", async () => {
    // given
    const { journal, server } = harness()
    journal("ses_elsewhere").store.save(
      task({
        task_id: "st_000000a5",
        status: "running",
        parent_session_id: "ses_victim",
        root_session_id: "ses_victim",
      }),
    )
    const host = server()
    await host.ready

    // when
    const victim = await host.read("ses_victim")

    // then
    expect(victim.tasks).toEqual([])
  })
})
