import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ChildObservationUncertain } from "./observation-uncertain"
import { afterEach, expect, test } from "bun:test"
import { AdmissionBarrier } from "../pause/admission-barrier"
import { createStartAdmissions } from "./start-admission"
import { createTaskManagerImplementation } from "./manager-implementation"
import { createTaskRecordStore } from "../store"
import {
  baseSpec,
  categoryPlanner,
  cleanupProjects,
  makeHandle,
  launchSettled,
  settings,
  tempProject,
} from "./__fixtures__/manager-fakes"
import type { ManagedRunner, ManagerStartSpec } from "./types"
import { buildSpawnSpecV1, nextRungManagedSpec } from "./manager-helpers"
import { enterStartAdmission } from "./start-admission"

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected value to be present")
  return value
}

afterEach(cleanupProjects)
function authority() {
  const raw = new AbortController(),
    lifetime = new AbortController()
  return {
    raw,
    lifetime,
    admissionSignal: AbortSignal.any([raw.signal, lifetime.signal]),
    lifetimeSignal: lifetime.signal,
    assertAdmission() {
      raw.signal.throwIfAborted()
      lifetime.signal.throwIfAborted()
    },
    assertLifetime() {
      lifetime.signal.throwIfAborted()
    },
  }
}

test("optional host authority is captured once and raw abort stops admission before any body", async () => {
  const a = authority()
  a.raw.abort(new Error("original caller interrupted"))
  let captures = 0,
    bodies = 0
  const create = createStartAdmissions as unknown as (...args: unknown[]) => ReturnType<typeof createStartAdmissions>
  const barrier = new AdmissionBarrier(),
    admissions = create(barrier, undefined, Date.now, (_spec: ManagerStartSpec) => {
      captures++
      return a
    })
  await expect(
    admissions.run(baseSpec(), undefined, async () => {
      bodies++
      return "wrong"
    }),
  ).rejects.toThrow("original caller interrupted")
  expect(captures).toBe(1)
  expect(bodies).toBe(0)
  expect(barrier.inFlight("parent-1")).toEqual([])
})

test("Native transfer is not host acceptance; only explicit real-ACK notification releases raw caller dependence", async () => {
  const a = authority(),
    create = createStartAdmissions as unknown as (...args: unknown[]) => ReturnType<typeof createStartAdmissions>
  const admissions = create(new AdmissionBarrier(), undefined, Date.now, () => a)
  const scope = await admissions.run(baseSpec(), undefined, async (spec) => {
    present(spec.admission).transfer()
    return present(spec.admission)
  })
  if ("kind" in scope) throw Error("held")
  const host = scope as typeof scope & { hostAuthority?: typeof a; hostAccepted?(): void }
  expect(host.hostAuthority).toBe(a)
  expect(typeof host.hostAccepted).toBe("function")
  expect(scope.hostSignal?.()).toBe(a.admissionSignal)
  a.raw.abort(new Error("still unadmitted"))
  expect(() => scope.assertOpen()).toThrow("still unadmitted")
  present(host.hostAccepted).call(host)
  expect(() => scope.assertOpen()).not.toThrow()
  expect(scope.hostSignal?.()).toBe(a.lifetimeSignal)
  a.lifetime.abort(new Error("parent retired"))
  expect(() => scope.assertOpen()).toThrow("parent retired")
  scope.leave()
})

test("original Native 250ms starting report retains the same authority until the actual late runner settles", async () => {
  const cwd = tempProject(),
    store = createTaskRecordStore({ project_dir: cwd }),
    a = Object.assign(authority(), { privateMarker: "HOST_AUTHORITY_MUST_NOT_PERSIST" }),
    b = authority()
  let current = a
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  let observed: unknown, fake: ReturnType<typeof makeHandle> | undefined
  const runner: ManagedRunner = {
    async start(spec) {
      observed = spec.admission?.hostAuthority
      entered.resolve()
      await release.promise
      spec.admission?.assertOpen()
      fake = makeHandle(spec.taskId)
      return fake.handle
    },
  }
  const manager = createTaskManagerImplementation(
    {
      cwd,
      store,
      config: settings(),
      planner: categoryPlanner(),
      runners: { "in-process": runner, process: runner },
      captureStartAuthority: () => current,
    },
    {
      preparePlanning: async () => {},
      createRecoveryRuntime: () => ({
        respawn: async () => {
          throw Error("unused")
        },
        settleTeardowns: async () => {},
      }),
    },
  )
  const starting = manager.start(baseSpec({ run_in_background: true }))
  await entered.promise
  const result = await starting
  if (result.kind !== "started") throw Error("start")
  expect(result.starting).toBe(true)
  expect(observed).toBe(a)
  expect(JSON.stringify(store.load(result.task_id))).not.toContain(a.privateMarker)
  expect(store.load(result.task_id)?.spawn_spec).not.toHaveProperty("admission")
  current = Object.assign(b, { privateMarker: "B" })
  release.resolve()
  await launchSettled(manager, result)
  if (!fake) throw Error("late runner missing")
  fake.settle({ status: "completed", finalResponse: "late A completed" })
  expect((await manager.waitFor(result.task_id)).final_response).toBe("late A completed")
  manager.forget(result.task_id, { path: "end" })
  store.remove(result.task_id)
  store.close()
})

test("fallback spec spread preserves exact transient admission while persisted spawn spec remains pure data", () => {
  const a = authority(),
    barrier = new AdmissionBarrier(),
    entered = enterStartAdmission({ barrier, spec: baseSpec(), taskId: "unit", hostAuthority: a })
  if (entered.kind !== "entered") throw Error("held")
  const spec = {
    taskId: "unit",
    cwd: "/unit",
    stateDir: "/unit/state",
    prompt: "work",
    depth: 1,
    parentSessionId: "parent-1",
    rootSessionId: "parent-1",
    admission: entered.scope,
  }
  const rung = { provider: "qa", model_id: "next", display: "qa/next", source: "category" as const }
  const next = nextRungManagedSpec(spec, rung, { fallbackModels: [] })
  expect(next.admission).toBe(entered.scope)
  expect(next.admission?.hostAuthority).toBe(a)
  expect(buildSpawnSpecV1(next)).toEqual({ version: 1, cwd: "/unit", prompt: "work" })
  entered.scope.leave()
})

test.each(["cancel", "owner", "epoch"] as const)(
  "outer queued host refusal leaves a newer %s untouched and releases only its old lease",
  async (race) => {
    const cwd = tempProject(),
      store = createTaskRecordStore({ project_dir: cwd }),
      a = authority(),
      fill = authority()
    let current = fill,
      queuedID: string | undefined,
      expected: ReturnType<typeof store.load> | undefined,
      handle: ReturnType<typeof makeHandle> | undefined
    const checked = Promise.withResolvers<void>(),
      assert = a.assertAdmission.bind(a)
    a.assertAdmission = () => {
      if (queuedID) {
        store.mutate(queuedID, (f) => ({
          ...f,
          ...(race === "cancel"
            ? { status: "cancelled" as const }
            : race === "owner"
              ? { host_pid: 999 }
              : { notification: { ...f.notification, run_epoch: 1 } }),
        }))
        expected = store.load(queuedID)
        checked.resolve()
        a.raw.abort(new Error("queued caller retired"))
      }
      assert()
    }
    const runner: ManagedRunner = {
      async start(spec) {
        handle = makeHandle(spec.taskId)
        return handle.handle
      },
    }
    const manager = createTaskManagerImplementation(
      {
        cwd,
        store,
        config: settings({ default_concurrency: 1 }),
        planner: categoryPlanner(),
        runners: { "in-process": runner, process: runner },
        captureStartAuthority: () => current,
      },
      {
        preparePlanning: async () => {},
        createRecoveryRuntime: () => ({
          respawn: async () => {
            throw Error("unused")
          },
          settleTeardowns: async () => {},
        }),
      },
    )
    const first = await manager.start(baseSpec())
    current = a
    const queued = await manager.start(baseSpec())
    if (first.kind !== "started" || queued.kind !== "started" || !handle) throw Error("start")
    queuedID = queued.task_id
    handle.settle({ status: "completed", finalResponse: "release" })
    await checked.promise
    await launchSettled(manager, queued.task_id)
    expect(store.load(queued.task_id)).toEqual(present(expected))
    expect(manager.concurrency?.leaseState(queued.task_id, 0)).toBeUndefined()
    for (const id of [first.task_id, queued.task_id]) {
      manager.forget(id, { path: "end" })
      store.remove(id)
    }
    store.close()
  },
)

test("absent host capture keeps original Native admission shape, transfer and barrier semantics", async () => {
  const barrier = new AdmissionBarrier(),
    admissions = createStartAdmissions(barrier)
  const entered = await admissions.run(baseSpec(), undefined, async (spec) => {
    present(spec.admission).transfer()
    return present(spec.admission)
  })
  if ("kind" in entered) throw Error("held")
  expect(entered).not.toHaveProperty("hostAuthority")
  expect(entered).not.toHaveProperty("hostAccepted")
  expect(entered).not.toHaveProperty("hostSignal")
  barrier.close("parent-1", 1)
  expect(entered.commit().kind).toBe("start_paused")
  expect(() => entered.assertOpen()).toThrow("run admission is held")
  entered.leave()
  expect(barrier.inFlight("parent-1")).toEqual([])
})

test("queued A keeps its own captured authority when B wakes the lane; refused A never reaches a runner or strands its epoch", async () => {
  const cwd = tempProject(),
    store = createTaskRecordStore({ project_dir: cwd }),
    a = authority(),
    b = authority(),
    fill = authority()
  let current = fill
  const started: string[] = [],
    handles = new Map<string, ReturnType<typeof makeHandle>>()
  const runner: ManagedRunner = {
    async start(spec) {
      started.push(spec.prompt)
      const fake = makeHandle(spec.taskId)
      handles.set(spec.taskId, fake)
      return fake.handle
    },
  }
  const options = Object.assign(
    {
      cwd,
      store,
      config: settings({ default_concurrency: 1 }),
      planner: categoryPlanner(),
      runners: { "in-process": runner, process: runner },
    },
    { captureStartAuthority: () => current },
  )
  const manager = createTaskManagerImplementation(options, {
    preparePlanning: async () => {},
    createRecoveryRuntime: () => ({
      respawn: async () => {
        throw Error("unused")
      },
      settleTeardowns: async () => {},
    }),
  })
  const first = await manager.start(baseSpec({ prompt: "filler" }))
  current = a
  const queued = await manager.start(baseSpec({ prompt: "A" }))
  current = b
  if (first.kind !== "started" || queued.kind !== "started") throw Error("start")
  expect(queued.status).toBe("pending")
  a.raw.abort(new Error("A interrupted while queued"))
  const waiting = manager.waitFor(queued.task_id).then((record) => record.status)
  present(handles.get(first.task_id)).settle({ status: "completed", finalResponse: "wake from B context" })
  await manager.waitFor(first.task_id)
  const observed = await Promise.race([waiting, Bun.sleep(80).then(() => "still-pending")])
  const lease = manager.concurrency?.leaseState(queued.task_id, 0),
    before = [...started]
  console.log("MI3_QUEUED_AUTHORITY_WITNESS", JSON.stringify({ observed, lease: lease ?? null, runnerPrompts: before }))
  // Always drain the controlled RED, even when the old implementation leaked A's lease.
  handles.get(queued.task_id)?.settle({ status: "completed", finalResponse: "RED cleanup" })
  manager.concurrency?.releaseTask(queued.task_id)
  await Promise.resolve()
  for (const id of [first.task_id, queued.task_id]) {
    manager.forget(id, { path: "end" })
    store.remove(id)
  }
  store.close()
  expect(before).toEqual(["filler"])
  expect(observed).toBe("error")
  expect(lease).toBeUndefined()
})

test.each([
  "start-audit",
  "failure-transition-audit",
  "terminal-audit",
  "persistent-audit",
  "start-write",
  "terminal-write",
  "settlement-read",
] as const)(
  "queued host refusal settles without input under %s failure",
  async (fault) => {
    const cwd = tempProject(),
      store = createTaskRecordStore({ project_dir: cwd }),
      a = authority(),
      fill = authority()
    let current = fill
    const handles = new Map<string, ReturnType<typeof makeHandle>>(),
      prompts: string[] = [],
      faultEntered = Promise.withResolvers<void>()
    const runner: ManagedRunner = {
      async start(spec) {
        prompts.push(spec.prompt)
        const handle = makeHandle(spec.taskId)
        handles.set(spec.taskId, handle)
        return handle.handle
      },
    }
    const manager = createTaskManagerImplementation(
      {
        cwd,
        store,
        config: settings({ default_concurrency: 1 }),
        planner: categoryPlanner(),
        runners: { "in-process": runner, process: runner },
        captureStartAuthority: () => current,
      },
      {
        preparePlanning: async () => {},
        createRecoveryRuntime: () => ({
          respawn: async () => {
            throw Error("unused")
          },
          settleTeardowns: async () => {},
        }),
      },
    )
    const first = await manager.start(baseSpec({ prompt: "filler" }))
    current = a
    const queued = await manager.start(baseSpec({ prompt: "must not run" }))
    if (first.kind !== "started" || queued.kind !== "started") throw Error("start")
    const append = store.appendEvent.bind(store),
      mutate = store.mutate.bind(store),
      load = store.load.bind(store)
    let auditAttempts = 0,
      injections = 0,
      failSettlementRead = false,
      readFaults = 0
    const fail = () => {
      injections++
      faultEntered.resolve()
      throw Error(`CONTROLLED_${fault}_BOOKKEEPING_UNAVAILABLE`)
    }
    Object.defineProperty(store, "appendEvent", {
      configurable: true,
      value: (id: Parameters<typeof append>[0], event: Parameters<typeof append>[1]) => {
        if (id === queued.task_id) {
          auditAttempts++
          if (fault === "settlement-read" && event.type === "task_start_failed") {
            failSettlementRead = true
            fail()
          }
          if (
            (fault === "start-audit" && auditAttempts === 1) ||
            (fault === "failure-transition-audit" && auditAttempts === 2) ||
            (fault === "terminal-audit" && event.type === "task_start_failed") ||
            fault === "persistent-audit"
          )
            fail()
        }
        return append(id, event)
      },
    })
    Object.defineProperty(store, "mutate", {
      configurable: true,
      value: (id: Parameters<typeof mutate>[0], change: Parameters<typeof mutate>[1]) => {
        if (id === queued.task_id && fault === "start-write") fail()
        return mutate(id, (fresh) => {
          const next = change(fresh)
          if (id === queued.task_id && fault === "terminal-write" && next.status === "error") fail()
          return next
        })
      },
    })
    Object.defineProperty(store, "load", {
      configurable: true,
      value: (id: Parameters<typeof load>[0]) => {
        if (id === queued.task_id && failSettlementRead) {
          failSettlementRead = false
          readFaults++
          throw Error("CONTROLLED_TERMINAL_SETTLEMENT_READ_ONCE")
        }
        return load(id)
      },
    })
    const waiting = manager.waitFor(queued.task_id).then(
      (record) => ({ status: record.status, error: undefined as unknown }),
      (error) => ({ status: "rejected", error }),
    )
    const logPath = join(store.stateDir, "logs", `${queued.task_id}.jsonl`),
      readAudit = () => (existsSync(logPath) ? readFileSync(logPath, "utf8") : "")
    const originalLog = readAudit()
    let observed: { status: string; error: unknown } | undefined,
      snapshot: ReturnType<typeof store.load>,
      future: { status: string; error: unknown } | undefined,
      keys = -1,
      lease: unknown
    try {
      a.raw.abort(new Error("queued raw caller retired"))
      present(handles.get(first.task_id)).settle({ status: "completed", finalResponse: "release" })
      await faultEntered.promise
      await launchSettled(manager, queued.task_id)
      observed = await Promise.race([
        waiting,
        Bun.sleep(80).then(() => ({ status: "STILL_PENDING", error: undefined })),
      ])
      snapshot = store.load(queued.task_id)
      keys = manager.waiterKeyCount()
      lease = manager.concurrency?.leaseState(queued.task_id, 0)
      const persistedFailure = fault !== "start-write" && fault !== "terminal-write"
      if (observed.status !== "STILL_PENDING")
        future = await manager.waitFor(queued.task_id).then(
          (record) => ({ status: record.status, error: undefined }),
          (error) => ({ status: "rejected", error }),
        )
      console.log(
        "HOST_REFUSAL_BOOKKEEPING_WITNESS",
        JSON.stringify({
          fault,
          injections,
          readFaults,
          status: snapshot?.status,
          observed: observed.status,
          future: future?.status,
          keys,
          lease: lease ?? null,
          prompts,
        }),
      )
      if (fault === "persistent-audit") expect(readAudit()).toBe(originalLog)
      if (fault === "settlement-read") expect(readFaults).toBe(1)
      expect(injections).toBeGreaterThan(0)
      expect(prompts).toEqual(["filler"])
      expect(lease).toBeUndefined()
      expect(keys).toBe(0)
      if (persistedFailure) {
        expect(snapshot?.status).toBe("error")
        expect(observed.status).toBe("error")
        expect(future?.status).toBe("error")
      } else {
        expect(snapshot?.status).toBe(fault === "start-write" ? "pending" : "running")
        expect(observed.status).toBe("rejected")
        expect(observed.error).toBeInstanceOf(ChildObservationUncertain)
        expect(String(observed.error)).toContain("host-start-refusal-settlement-unavailable")
        expect(future?.error).toBeInstanceOf(ChildObservationUncertain)
        Object.defineProperty(store, "mutate", { configurable: true, value: mutate })
        // A later Native-owned generation must not inherit this manager's old local refusal.
        store.mutate(queued.task_id, (value) => ({
          ...value,
          notification: { ...value.notification, run_epoch: 1 },
          run_start_epoch: 1,
        }))
        let settled = false
        const later = manager.waitFor(queued.task_id).then(
          (record) => {
            settled = true
            return record.status
          },
          () => {
            settled = true
            return "rejected"
          },
        )
        await Promise.resolve()
        expect(settled).toBe(false)
        await manager.cancelTask(queued.task_id, "healthy newer-generation cleanup")
        expect(await later).toBe("cancelled")
      }
    } finally {
      Object.defineProperty(store, "appendEvent", { configurable: true, value: append })
      Object.defineProperty(store, "mutate", { configurable: true, value: mutate })
      Object.defineProperty(store, "load", { configurable: true, value: load })
      handles.get(queued.task_id)?.settle({ status: "completed", finalResponse: "test cleanup" })
      // RED-only fixture cleanup: a terminal record can have the old bugged waiter still registered.
      // Re-arm only this disposable record after capturing the decisive state, then use genuine cancel.
      const repair =
        manager.waiterKeyCount() > 0 &&
        ["error", "completed", "cancelled"].includes(present(store.load(queued.task_id)).status)
      if (repair) store.mutate(queued.task_id, (value) => ({ ...value, status: "running" }))
      await manager.cancelTask(queued.task_id, "healthy explicit cleanup after bookkeeping fault")
      await waiting
      expect((await manager.waitFor(queued.task_id)).status).toBe(
        repair || fault === "start-write" || fault === "terminal-write" ? "cancelled" : "error",
      )
      for (const id of [first.task_id, queued.task_id]) {
        manager.forget(id, { path: "end" })
        store.remove(id)
      }
      manager.workpools.dispose()
      store.close()
    }
  },
  5000,
)
