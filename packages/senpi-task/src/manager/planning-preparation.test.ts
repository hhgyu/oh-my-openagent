import { createNativeTaskRecoveryRuntime } from "./recovery-runtime"
import { afterEach, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { createTaskManager, START_REPORT_WINDOW_MS } from "./manager"
import {
  createTaskManagerImplementation,
  START_REPORT_WINDOW_MS as INTERNAL_REPORT_WINDOW,
} from "./manager-implementation"
import { createTaskRecordStore } from "../store"
import { AdmissionBarrier } from "../pause/admission-barrier"
import type { DagTaskOwner } from "../dag/owner"
import {
  baseSpec,
  categoryPlanner,
  cleanupProjects,
  FakeRunner,
  settings,
  tempProject,
} from "./__fixtures__/manager-fakes"
import type { ChildPlanner } from "./types"
import { resolveKernelToolGrant } from "../kernel-tools/resolve"
import { fakeKernelTools } from "../runners/in-process/__fixtures__/kernel-tools-fakes"

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected value to be present")
  return value
}

afterEach(cleanupProjects)
const owner: DagTaskOwner = {
  kind: "dag",
  runId: "run-preparation" as never,
  nodeId: "node-preparation" as never,
  fingerprint: "prep-fingerprint",
}
function fixture(preparePlanning: () => Promise<void>, planner?: ChildPlanner, inspectAdmission?: () => void) {
  const cwd = tempProject(),
    store = createTaskRecordStore({ project_dir: cwd }),
    runner = new FakeRunner(),
    barrier = new AdmissionBarrier(),
    order: string[] = []
  const start = runner.start.bind(runner)
  runner.start = (spec) => {
    order.push("runner")
    return start(spec)
  }
  const options: Parameters<typeof createTaskManager>[0] = {
    cwd,
    store,
    config: settings({ default_concurrency: 5, max_depth: 2 }),
    runners: { "in-process": runner, process: runner },
    admissionBarrier: barrier,
    planner:
      planner ??
      ((spec) => {
        order.push("planner")
        return categoryPlanner()(spec)
      }),
    admit: async () => {
      order.push("admit")
      inspectAdmission?.()
      return { kind: "admitted" }
    },
  }
  const manager = createTaskManagerImplementation(options, {
    createRecoveryRuntime: createNativeTaskRecoveryRuntime,
    preparePlanning: async () => {
      order.push("prepare")
      await preparePlanning()
    },
  })
  return { cwd, store, runner, barrier, order, options, manager }
}
for (const owned of [false, true]) {
  test(`${owned ? "startOwned" : "start"} captures selected planner before preparation can change options`, async () => {
    const cwd = tempProject(),
      store = createTaskRecordStore({ project_dir: cwd }),
      runner = new FakeRunner(),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      receivers: unknown[] = [],
      calls: string[] = []
    let copiedOptions: object | undefined
    let preparations = 0
    const replacement: ChildPlanner = function (this: unknown, spec) {
      calls.push("replacement")
      receivers.push(this)
      return categoryPlanner()(spec)
    }
    const manager = createTaskManagerImplementation(
      {
        cwd,
        store,
        config: settings(),
        runners: { "in-process": runner, process: runner },
        planner: function (this: unknown, spec) {
          calls.push("selected")
          receivers.push(this)
          return categoryPlanner()(spec)
        },
        admit: async function (this: object) {
          copiedOptions = this
          return { kind: "rejected", message: "controlled residency refusal" }
        },
      },
      {
        createRecoveryRuntime: createNativeTaskRecoveryRuntime,
        preparePlanning: async () => {
          if (++preparations === 2) {
            entered.resolve()
            await release.promise
            Object.defineProperty(present(copiedOptions), "planner", {
              value: replacement,
              writable: true,
              configurable: true,
            })
          }
        },
      },
    )
    const run = () => (owned ? manager.startOwned(baseSpec(), owner) : manager.start(baseSpec()))
    expect(await run()).toMatchObject({ kind: "residency_denied" })
    expect(copiedOptions).toBeDefined()
    const starting = run()
    await entered.promise
    release.resolve()
    expect(await starting).toMatchObject({ kind: "residency_denied" })
    expect(calls).toEqual(["selected", "selected"])
    expect(receivers).toEqual([undefined, undefined])
    expect(runner.startedSpecs).toEqual([])
    expect(store.list().records).toEqual([])
  })
  test(`${owned ? "startOwned" : "start"} preserves the original unbound planner receiver`, async () => {
    const receivers: unknown[] = []
    const f = fixture(
      async () => {},
      function (this: unknown, spec) {
        receivers.push(this)
        return categoryPlanner()(spec)
      },
    )
    const result = owned ? await f.manager.startOwned(baseSpec(), owner) : await f.manager.start(baseSpec())
    try {
      expect(receivers).toEqual([undefined])
    } finally {
      if (result.kind === "started") {
        present(f.runner.handles.get(result.task_id)).settle({ status: "completed", finalResponse: "RECEIVER_DONE" })
        await f.manager.waitFor(result.task_id)
      }
    }
  })
  test(`${owned ? "startOwned" : "start"} prepares before synchronous planning/admission/runner with original owner lock ordering`, async () => {
    let f!: ReturnType<typeof fixture>
    f = fixture(
      async () => {
        const locks = join(f.store.stateDir, "owner-locks")
        expect(existsSync(locks)).toBe(owned)
        if (owned) expect(readdirSync(locks)).toEqual([])
      },
      undefined,
      () => {
        if (owned)
          expect(readdirSync(join(f.store.stateDir, "owner-locks")).some((name) => name.endsWith(".lock"))).toBe(true)
      },
    )
    const result = owned ? await f.manager.startOwned(baseSpec(), owner) : await f.manager.start(baseSpec())
    expect(result.kind).toBe("started")
    expect(f.order).toEqual(["prepare", "planner", "admit", "runner"])
    if (result.kind !== "started") throw Error("expected started")
    present(f.runner.handles.get(result.task_id)).settle({ status: "completed", finalResponse: "PREPARATION_DONE" })
    await f.manager.waitFor(result.task_id)
  })
  test(`${owned ? "startOwned" : "start"} preparation failure claims no record/residency and never calls planner or runner`, async () => {
    const failure = Error("host preparation unavailable"),
      f = fixture(async () => {
        throw failure
      })
    await expect(owned ? f.manager.startOwned(baseSpec(), owner) : f.manager.start(baseSpec())).rejects.toBe(failure)
    expect(f.order).toEqual(["prepare"])
    expect(f.store.list().records).toEqual([])
    expect(f.runner.startedSpecs).toEqual([])
    expect(f.barrier.inFlight("parent-1")).toEqual([])
  })
  test(`${owned ? "startOwned" : "start"} Stop during preparation does not reach planner, admission, record or runner`, async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      f = fixture(async () => {
        entered.resolve()
        await release.promise
      })
    const spec = baseSpec({ root_session_id: "prep-root" }),
      starting = owned ? f.manager.startOwned(spec, owner) : f.manager.start(spec)
    await entered.promise
    f.barrier.close("prep-root", 1)
    release.resolve()
    expect(await starting).toMatchObject({ kind: "held", pauseSeq: 1 })
    expect(f.order).toEqual(["prepare"])
    expect(f.store.list().records).toEqual([])
    expect(f.runner.startedSpecs).toEqual([])
  })
  test(`${owned ? "startOwned" : "start"} retains post-planner Stop fence and member refusal before preparation`, async () => {
    let f!: ReturnType<typeof fixture>
    f = fixture(
      async () => {},
      (spec) => {
        f.order.push("planner")
        f.barrier.close("planner-root", 1)
        return categoryPlanner()(spec)
      },
    )
    const spec = baseSpec({ root_session_id: "planner-root" })
    expect(await (owned ? f.manager.startOwned(spec, owner) : f.manager.start(spec))).toMatchObject({ kind: "held" })
    expect(f.order).toEqual(["prepare", "planner"])
    expect(f.runner.startedSpecs).toEqual([])
    const capability = fakeKernelTools()
    capability.define({ name: "fixture_lookup" })
    const granted = await resolveKernelToolGrant({
      requestedNames: ["fixture_lookup"],
      capability,
      executionMode: "in-process",
    })
    if (granted.kind !== "granted") throw Error("expected validated grant")
    const g = fixture(async () => {
        throw Error("member must not prepare")
      }),
      member = baseSpec({ team_role: "member", kernelTools: granted.grant })
    expect(await (owned ? g.manager.startOwned(member, owner) : g.manager.start(member))).toMatchObject({
      kind: "plan_unresolved",
      error: { code: "invalid_target" },
    })
    expect(g.order).toEqual([])
  })
}
test("implementation preparation is required; public Native factory retains options/report window surface", () => {
  const f = fixture(async () => {})
  expect(() => createTaskManagerImplementation(f.options, undefined as never)).toThrow("preparation")
  expect(START_REPORT_WINDOW_MS).toBe(250)
  expect(INTERNAL_REPORT_WINDOW).toBe(START_REPORT_WINDOW_MS)
  const native: ReturnType<typeof createTaskManager> = f.manager
  expect(typeof native.startOwned).toBe("function")
  expect(typeof native.workpools.create).toBe("function")
})
test("workpool admission remains synchronous and never implicitly prepares ordinary task planning", () => {
  const f = fixture(async () => {
    throw Error("workpool must stay synchronous")
  })
  const pool = f.manager.workpools.create(
    { sessionId: "parent-1", rootSessionId: "root", depth: 0, cwd: f.cwd },
    { name: "prep-sync", agent: { category: "quick", prompt: "work" }, mode: "fresh" },
  )
  expect(typeof pool.pool_id).toBe("string")
  expect("then" in pool).toBe(false)
  expect(f.order).toEqual(["planner"])
  expect(f.runner.startedSpecs).toEqual([])
})
test("cold Native facade still warms the real Senpi barrel before calling the synchronous planner", () => {
  const cwd = tempProject(),
    managerPath = join(import.meta.dir, "manager.ts"),
    fakePath = join(import.meta.dir, "__fixtures__", "manager-fakes.ts"),
    barrelPath = join(import.meta.dir, "..", "lazy", "senpi-barrel.ts"),
    storePath = join(import.meta.dir, "..", "store", "index.ts")
  const code = `import {createTaskManager,START_REPORT_WINDOW_MS} from ${JSON.stringify(managerPath)};import {FakeRunner,baseSpec,categoryPlanner,settings} from ${JSON.stringify(fakePath)};import {senpiBarrel} from ${JSON.stringify(barrelPath)};import {createTaskRecordStore} from ${JSON.stringify(storePath)};let cold=false,warm=false;try{senpiBarrel()}catch{cold=true}const runner=new FakeRunner();const manager=createTaskManager({cwd:${JSON.stringify(cwd)},store:createTaskRecordStore({project_dir:${JSON.stringify(cwd)}}),config:settings(),runners:{"in-process":runner,process:runner},planner:spec=>{warm=!!senpiBarrel();return categoryPlanner()(spec)}});const result=await manager.start(baseSpec());if(result.kind==="started"){runner.handles.get(result.task_id).settle({status:"completed",finalResponse:"NATIVE_DONE"});await manager.waitFor(result.task_id)}console.log(JSON.stringify({cold,warm,started:result.kind==="started",reportWindow:START_REPORT_WINDOW_MS}))`
  const result = spawnSync(process.execPath, ["-e", code], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
  })
  expect(result.status).toBe(0)
  expect(JSON.parse(present(result.stdout.trim().split(/\r?\n/).at(-1)))).toEqual({
    cold: true,
    warm: true,
    started: true,
    reportWindow: 250,
  })
}, 20000)
