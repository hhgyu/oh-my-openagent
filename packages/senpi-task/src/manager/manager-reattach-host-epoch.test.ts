import { afterEach, expect, test } from "bun:test"
import { seedRecord } from "../lifecycle/__fixtures__/lifecycle-fakes"
import { createTaskRecordStore } from "../store"
import type { TaskRecord } from "../state"
import { cleanupProjects, makeHandle, tempProject } from "./__fixtures__/manager-fakes"
import { reattachManagedTask } from "./manager-reattach"

afterEach(cleanupProjects)

function fixture(status: "running" | "paused" | "completed" = "running") {
  const store = createTaskRecordStore({ project_dir: tempProject() })
  const before = seedRecord(store, { task_id: "st_0a3e0001", status, residency_state: "resident", host_pid: 11001, run_epoch: 4 })
  const handle = makeHandle(before.task_id).handle
  const order: string[] = []
  const replace = store.replace.bind(store)
  Object.defineProperty(store, "replace", { value: (record: TaskRecord) => { replace(record); order.push("replace") } })
  function run() {
    return reattachManagedTask({ record: before, handle, store, hostPid: 11001, now: () => 1234,
      isAttached: () => false, attachLive: () => { order.push("attach"); return () => {} },
      detachLive: () => { order.push("detach") }, destroyAttached: async () => { order.push("destroy") },
      armOutcome: record => { expect(store.load(before.task_id)?.notification.run_epoch).toBe(record.notification.run_epoch); order.push("arm") },
    })
  }
  return { store, before, handle, order, run }
}

test("canonical reattach publishes the actual epoch before the host handoff and awaits it before arming", async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  Object.assign(f.handle, { async bindReattachedRun(this: typeof f.handle, before: TaskRecord, actual: TaskRecord) {
    expect(this).toBe(f.handle)
    expect(before.notification.run_epoch).toBe(4)
    expect(actual.notification.run_epoch).toBe(5)
    expect(f.store.load(actual.task_id)).toEqual(actual)
    f.order.push("bind"); entered.resolve(); await release.promise; f.order.push("bound")
  } })
  const pending = f.run()
  await Promise.race([entered.promise, pending.then(() => { throw Error("reattach returned without its host handoff") })])
  expect(f.order).toEqual(["attach", "replace", "bind"])
  release.resolve()
  expect(await pending).toEqual({ ok: true })
  expect(f.order).toEqual(["attach", "replace", "bind", "bound", "arm"])
})

test("host handoff failure uses canonical attached cleanup and never arms or returns success", async () => {
  const f = fixture()
  Object.assign(f.handle, { bindReattachedRun() { f.order.push("bind"); throw Error("host checkpoint failed") } })
  expect(await f.run()).toMatchObject({ ok: false, reason: "manager reattach failed" })
  expect(f.store.load(f.before.task_id)?.notification.run_epoch).toBe(5)
  expect(f.order).toEqual(["attach", "replace", "bind", "destroy", "detach"])
})

test("absent host handoff preserves the synchronous default publication and arm order", async () => {
  const f = fixture()
  const pending = f.run()
  expect(f.order).toEqual(["attach", "replace", "arm"])
  expect(await pending).toEqual({ ok: true })
})

test.each(["paused", "completed"] as const)("%s reattach does not call a new-run host handoff", async status => {
  const f = fixture(status)
  Object.assign(f.handle, { bindReattachedRun() { throw Error("must not bind an unchanged epoch") } })
  expect(await f.run()).toEqual({ ok: true })
  expect(f.store.load(f.before.task_id)?.notification.run_epoch).toBe(4)
  expect(f.order).not.toContain("arm")
})
