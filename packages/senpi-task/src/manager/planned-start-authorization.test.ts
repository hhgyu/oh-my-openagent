import { afterEach, expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { DagTaskOwner, OwnedStartResult } from "../dag/owner"
import { createTaskRecordStore } from "../store"
import { AdmissionBarrier } from "../pause/admission-barrier"
import { createTaskManagerImplementation } from "./manager-implementation"
import { createNativeTaskRecoveryRuntime } from "./recovery-runtime"
import { RunnerError } from "../runners/in-process/runner-error"
import type { ManagedChildHandle } from "./child-handle"
import type { ChildPlanner, ManagedStartSpec, ManagerStartSpec, ResolvedChildPlan, StartResult } from "./types"
import type { HostStartAuthority } from "./start-admission"
import {
  baseSpec,
  categoryPlanner,
  cleanupProjects,
  FakeRunner,
  flush,
  settings,
  tempProject,
} from "./__fixtures__/manager-fakes"

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected value to be present")
  return value
}

afterEach(cleanupProjects)
const owner: DagTaskOwner = {
  kind: "dag",
  runId: "planned-run" as never,
  nodeId: "planned-node" as never,
  fingerprint: "planned-fingerprint",
}
type Authorize = (spec: ManagerStartSpec, plan: ResolvedChildPlan) => Promise<void>

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("controlled planned-start operation did not settle")), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function fixture(
  input: {
    authorize?: Authorize
    prepare?: () => Promise<void>
    planner?: ChildPlanner
    config?: ReturnType<typeof settings>
    runner?: FakeRunner
    capture?: (spec: ManagerStartSpec) => HostStartAuthority
  } = {},
) {
  const cwd = tempProject(),
    store = createTaskRecordStore({ project_dir: cwd })
  const runner = input.runner ?? new FakeRunner(),
    barrier = new AdmissionBarrier(),
    order: string[] = []
  const planned: Array<{ spec: ManagerStartSpec; plan: ResolvedChildPlan }> = [],
    receivers: unknown[] = []
  const selected = input.planner ?? categoryPlanner()
  const nativeStart = runner.start.bind(runner)
  const starts: Array<{ count: number; resolve: () => void }> = []
  runner.start = (spec) => {
    order.push("runner")
    const work = nativeStart(spec)
    for (const item of [...starts]) if (runner.startedSpecs.length >= item.count) item.resolve()
    return work
  }
  let admissions = 0
  const options: Parameters<typeof createTaskManagerImplementation>[0] = {
    cwd,
    store,
    runners: { "in-process": runner, process: runner },
    admissionBarrier: barrier,
    config: input.config ?? settings({ default_concurrency: 1, max_depth: 2 }),
    planner: function (this: unknown, spec) {
      order.push("planner")
      receivers.push(this)
      const result = selected(spec)
      if (result.kind === "resolved") planned.push({ spec, plan: result.plan })
      return result
    },
    admit: async () => {
      admissions += 1
      order.push("admit")
      return { kind: "admitted" }
    },
    ...(input.capture ? { captureStartAuthority: input.capture } : {}),
  }
  const preparation = {
    createRecoveryRuntime: createNativeTaskRecoveryRuntime,
    preparePlanning: async () => {
      order.push("prepare")
      await input.prepare?.()
    },
    ...(input.authorize
      ? {
          authorizePlannedStart: async (spec: ManagerStartSpec, plan: ResolvedChildPlan) => {
            order.push("authorize")
            await present(input.authorize).call(input, spec, plan)
          },
        }
      : {}),
  }
  const manager = createTaskManagerImplementation(options, preparation)
  async function finish() {
    for (let round = 0; round < 3; round += 1) {
      for (const record of store.list().records) {
        const child = runner.handles.get(record.task_id)
        if (!child || ["completed", "error", "cancelled", "lost"].includes(record.status)) continue
        const terminal = manager.waitFor(record.task_id)
        child.settle({ status: "completed", finalResponse: "PLANNED_START_DONE" })
        await bounded(terminal)
      }
      await flush()
    }
  }
  return {
    cwd,
    store,
    runner,
    barrier,
    order,
    planned,
    receivers,
    options,
    preparation,
    manager,
    finish,
    admissions: () => admissions,
    whenStarts: (count: number) =>
      runner.startedSpecs.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => starts.push({ count, resolve })),
  }
}
type Fixture = ReturnType<typeof fixture>
function start(f: Fixture, owned: boolean, spec = baseSpec()): Promise<StartResult | OwnedStartResult> {
  return owned ? f.manager.startOwned(spec, owner) : f.manager.start(spec)
}

for (const owned of [false, true]) {
  test(`${owned ? "startOwned" : "start"} authorizes the single exact plan before admission or task mutation`, async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    let received: { spec: ManagerStartSpec; plan: ResolvedChildPlan } | undefined
    const f = fixture({
      authorize: async (spec, plan) => {
        received = { spec, plan }
        entered.resolve()
        await release.promise
      },
    })
    const starting = start(f, owned, baseSpec({ name: "planned" }))
    try {
      const first = await bounded(
        Promise.race([
          entered.promise.then(() => "authorize" as const),
          starting.then(
            () => "started-too-early" as const,
            () => "rejected-before-authorization" as const,
          ),
        ]),
      )
      expect(first).toBe("authorize")
      expect(f.planned).toHaveLength(1)
      expect(received?.spec).toBe(present(f.planned[0]).spec)
      expect(received?.plan).toBe(present(f.planned[0]).plan)
      expect(f.admissions()).toBe(0)
      expect(f.store.list().records).toEqual([])
      expect(f.runner.startedSpecs).toEqual([])
      expect(f.barrier.inFlight("parent-1")).toHaveLength(1)
      const locks = join(f.store.stateDir, "owner-locks")
      expect(existsSync(locks)).toBe(owned)
      if (owned) expect(readdirSync(locks)).toEqual([])
      release.resolve()
      expect(await bounded(starting)).toMatchObject({ kind: "started", name: "planned" })
      expect(f.order).toEqual(["prepare", "planner", "authorize", "admit", "runner"])
    } finally {
      release.resolve()
      await starting.catch(() => undefined)
      await f.finish()
    }
  })

  test(`${owned ? "startOwned" : "start"} without authorization retains Native ordering and unbound planner`, async () => {
    const f = fixture()
    try {
      expect(await start(f, owned)).toMatchObject({ kind: "started" })
      expect(f.order).toEqual(["prepare", "planner", "admit", "runner"])
      expect(f.receivers).toEqual([undefined])
      expect(f.planned).toHaveLength(1)
    } finally {
      await f.finish()
    }
  })
}

// Explicit UNIT authority ports; not issued SDK contexts or real input-ACK evidence.
function authority() {
  const call = new AbortController(),
    lifetime = new AbortController()
  const check = (signal: AbortSignal) => {
    if (signal.aborted) throw signal.reason
  }
  const port: HostStartAuthority = {
    admissionSignal: call.signal,
    lifetimeSignal: lifetime.signal,
    assertAdmission() {
      check(lifetime.signal)
      check(call.signal)
    },
    assertLifetime() {
      check(lifetime.signal)
    },
  }
  return { call, lifetime, port }
}

for (const owned of [false, true]) {
  for (const [index, reason] of [new Error("denied"), null, undefined, false, 0, ""].entries()) {
    test(`${owned ? "startOwned" : "start"} retains denial identity ${index} without consuming name or capacity`, async () => {
      let deny = true,
        calls = 0
      const f = fixture({
        authorize: async () => {
          calls += 1
          if (deny) throw reason
        },
      })
      try {
        const result = await start(f, owned, baseSpec({ name: "reusable" })).then(
          (value) => ({ kind: "resolved" as const, value }),
          (error) => ({ kind: "rejected" as const, error }),
        )
        expect(result.kind).toBe("rejected")
        if (result.kind !== "rejected") throw new Error("denial resolved")
        expect(result.error).toBe(reason)
        expect(f.store.list().records).toEqual([])
        expect(f.admissions()).toBe(0)
        expect(f.runner.startedSpecs).toEqual([])
        expect(f.barrier.inFlight("parent-1")).toEqual([])
        deny = false
        expect(await start(f, owned, baseSpec({ name: "reusable" }))).toMatchObject({
          kind: "started",
          name: "reusable",
        })
        expect(calls).toBe(2)
        expect(f.admissions()).toBe(1)
        expect(f.runner.startedSpecs).toHaveLength(1)
      } finally {
        await f.finish()
      }
    })
  }

  test(`${owned ? "startOwned" : "start"} rechecks Stop after original approval settles`, async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const f = fixture({
      authorize: async () => {
        entered.resolve()
        await release.promise
      },
    })
    const pending = start(f, owned)
    try {
      await bounded(entered.promise)
      f.barrier.close("parent-1", 7)
      release.resolve()
      expect(await bounded(pending)).toMatchObject({ kind: "held", pauseSeq: 7 })
      expect(f.store.list().records).toEqual([])
      expect(f.admissions()).toBe(0)
      expect(f.runner.startedSpecs).toEqual([])
      expect(f.barrier.inFlight("parent-1")).toEqual([])
    } finally {
      release.resolve()
      await pending.catch(() => undefined)
      await f.finish()
    }
  })

  for (const retirement of ["call", "lifetime"] as const) {
    test(`${owned ? "startOwned" : "start"} rechecks ${retirement} retirement after approval without a record`, async () => {
      const token = authority(),
        reason = { retired: retirement }
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>()
      const f = fixture({
        capture: () => token.port,
        authorize: async () => {
          entered.resolve()
          await release.promise
        },
      })
      const pending = start(f, owned)
      const observed = pending.then(
        (value) => ({ kind: "resolved" as const, value }),
        (error) => ({ kind: "rejected" as const, error }),
      )
      try {
        await bounded(entered.promise)
        token[retirement].abort(reason)
        release.resolve()
        const result = await bounded(observed)
        expect(result.kind).toBe("rejected")
        if (result.kind !== "rejected") throw new Error("retired admission resolved")
        expect(result.error.cause).toBe(reason)
        expect(f.admissions()).toBe(0)
        expect(f.store.list().records).toEqual([])
        expect(f.runner.startedSpecs).toEqual([])
        expect(f.barrier.inFlight("parent-1")).toEqual([])
      } finally {
        release.resolve()
        await observed
        await f.finish()
      }
    })
  }

  test(`${owned ? "startOwned" : "start"} planning errors and preparation rejection never request authorization`, async () => {
    let calls = 0
    const f = fixture({
      authorize: async () => {
        calls += 1
      },
      planner: () => ({ kind: "error", error: { code: "unknown_target", message: "missing" } }),
    })
    const failure = { unavailable: true }
    const g = fixture({
      authorize: async () => {
        calls += 1
      },
      prepare: async () => {
        throw failure
      },
    })
    try {
      expect(await start(f, owned)).toMatchObject({ kind: "plan_unresolved", error: { code: "unknown_target" } })
      await expect(start(g, owned)).rejects.toBe(failure)
      expect(calls).toBe(0)
      expect(f.runner.startedSpecs).toEqual([])
      expect(g.runner.startedSpecs).toEqual([])
      expect(f.store.list().records).toEqual([])
      expect(g.store.list().records).toEqual([])
    } finally {
      await f.finish()
      await g.finish()
    }
  })

  test(`${owned ? "startOwned" : "start"} captures the original authorization callback once at construction`, async () => {
    let original = 0,
      replacement = 0
    const f = fixture({
      authorize: async () => {
        original += 1
      },
    })
    f.preparation.authorizePlannedStart = async () => {
      replacement += 1
    }
    try {
      expect(await start(f, owned)).toMatchObject({ kind: "started" })
      expect(original).toBe(1)
      expect(replacement).toBe(0)
    } finally {
      await f.finish()
    }
  })
}

test("overlapping owned requests authorize outside the owner lock, then retain one original claim", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  let calls = 0
  const f = fixture({
    authorize: async () => {
      if (++calls === 2) entered.resolve()
      await release.promise
    },
  })
  const a = f.manager.startOwned(baseSpec({ name: "owned" }), owner)
  const b = f.manager.startOwned(baseSpec({ name: "owned" }), owner)
  try {
    await bounded(entered.promise)
    expect(f.store.list().records).toEqual([])
    expect(f.admissions()).toBe(0)
    expect(readdirSync(join(f.store.stateDir, "owner-locks"))).toEqual([])
    release.resolve()
    const [first, second] = await bounded(Promise.all([a, b]))
    if (first.kind !== "started" || second.kind !== "started") throw new Error("expected owned starts")
    expect(first.task_id).toBe(second.task_id)
    expect([first.reused, second.reused].sort()).toEqual([false, true])
    expect(f.planned).toHaveLength(2)
    expect(calls).toBe(2)
    expect(f.runner.startedSpecs).toHaveLength(1)
  } finally {
    release.resolve()
    await Promise.allSettled([a, b])
    await f.finish()
  }
})

for (const background of [false, true]) {
  test(`approved ${background ? "background" : "foreground"} capacity queue keeps original admission without reauthorization`, async () => {
    let calls = 0
    const f = fixture({
      authorize: async () => {
        calls += 1
      },
    })
    try {
      const holder = await f.manager.start(baseSpec({ name: "holder" }))
      const queued = await f.manager.start(baseSpec({ name: "queued", run_in_background: background }))
      if (holder.kind !== "started" || queued.kind !== "started") throw new Error("expected starts")
      expect(queued).toMatchObject({ status: "pending", queue_position: 1 })
      expect(calls).toBe(2)
      const originalAdmission = present(f.planned[1]).spec.admission
      const done = f.manager.waitFor(holder.task_id)
      present(f.runner.handles.get(holder.task_id)).settle({ status: "completed", finalResponse: "release" })
      await bounded(done)
      await bounded(f.whenStarts(2))
      await flush()
      expect(present(f.runner.startedSpecs[1]).admission).toBe(originalAdmission)
      expect(calls).toBe(2)
      expect(f.planned).toHaveLength(2)
    } finally {
      await f.finish()
    }
  })
}

test("queue acceptance does not upgrade original call authority before first input ACK", async () => {
  const held = authority(),
    queuedAuthority = authority()
  let calls = 0
  const f = fixture({
    capture: (spec) => (spec.name === "queued" ? queuedAuthority.port : held.port),
    authorize: async () => {
      calls += 1
    },
  })
  try {
    const holder = await f.manager.start(baseSpec({ name: "holder" }))
    const queued = await f.manager.start(baseSpec({ name: "queued", run_in_background: true }))
    if (holder.kind !== "started" || queued.kind !== "started") throw new Error("expected starts")
    expect(queued).toMatchObject({ status: "pending" })
    queuedAuthority.call.abort(new Error("raw caller closed before ACK"))
    const done = f.manager.waitFor(holder.task_id)
    present(f.runner.handles.get(holder.task_id)).settle({ status: "completed", finalResponse: "release" })
    await bounded(done)
    expect((await bounded(f.manager.waitFor(queued.task_id))).status).toBe("error")
    expect(f.runner.startedSpecs).toHaveLength(1)
    expect(calls).toBe(2)
  } finally {
    await f.finish()
  }
})

test("unit first-input acceptance state switches only to retained lifetime authority", async () => {
  const token = authority()
  const f = fixture({ capture: () => token.port, authorize: async () => {} })
  try {
    const result = await f.manager.start(baseSpec())
    if (result.kind !== "started") throw new Error("expected start")
    const admission = present(present(f.runner.startedSpecs[0]).admission)
    expect(present(admission.hostSignal).call(admission)).toBe(token.call.signal)
    // UNIT protocol-state control only: actual SDK matching-ACK proof belongs to owned-runner QA.
    present(admission.hostAccepted).call(admission)
    token.call.abort(new Error("raw caller closed after unit acceptance"))
    expect(present(admission.hostSignal).call(admission)).toBe(token.lifetime.signal)
    expect(() => admission.assertOpen()).not.toThrow()
    token.lifetime.abort(new Error("parent retired"))
    expect(() => admission.assertOpen()).toThrow()
  } finally {
    await f.finish()
  }
})

const primary = { source: "category", provider: "vendor-a", model_id: "primary", display: "vendor-a/primary" } as const
const fallback = {
  source: "category",
  provider: "vendor-b",
  model_id: "fallback",
  display: "vendor-b/fallback",
} as const
function chainPlan(): ResolvedChildPlan {
  return { model: primary.display, requested_model: primary, resolved_model: primary, fallback_models: [fallback] }
}

test("authorization observes the original chain while Native spill selects the effective model", async () => {
  const plan = chainPlan(),
    seen: ResolvedChildPlan[] = []
  const f = fixture({
    planner: () => ({ kind: "resolved", plan }),
    authorize: async (_spec, candidate) => {
      seen.push(candidate)
    },
  })
  try {
    const holder = await f.manager.start(baseSpec({ name: "primary-holder" }))
    const spilled = await f.manager.start(baseSpec({ name: "spill" }))
    if (holder.kind !== "started" || spilled.kind !== "started") throw new Error("expected starts")
    expect(seen).toHaveLength(2)
    expect(seen[1]).toBe(plan)
    expect(present(seen[1]).model).toBe(primary.display)
    expect(present(f.runner.startedSpecs[1]).model).toBe(fallback.display)
    expect(f.store.load(spilled.task_id)?.model).toBe(fallback.display)
  } finally {
    await f.finish()
  }
})

test("start-time chain refusal walks Native fallbacks without another authorization or plan", async () => {
  class RefusingRunner extends FakeRunner {
    override start(spec: ManagedStartSpec): Promise<ManagedChildHandle> {
      if (spec.model === primary.display) {
        this.startedSpecs.push(spec)
        throw new RunnerError({
          kind: "model_unavailable",
          reason: "model_not_in_child_profile",
          message: "controlled missing model",
        })
      }
      return super.start(spec)
    }
  }
  let calls = 0
  const plan = chainPlan(),
    f = fixture({
      runner: new RefusingRunner(),
      planner: () => ({ kind: "resolved", plan }),
      authorize: async () => {
        calls += 1
      },
    })
  try {
    expect(await f.manager.start(baseSpec())).toMatchObject({ kind: "started", resolved_model: fallback })
    expect(f.runner.startedSpecs.map((spec) => spec.model)).toEqual([primary.display, fallback.display])
    expect(calls).toBe(1)
    expect(f.planned).toHaveLength(1)
  } finally {
    await f.finish()
  }
})

test("synchronous workpool planning does not acquire the optional ordinary-start hook", async () => {
  const f = fixture({
    authorize: async () => {
      throw new Error("workpool must not authorize ordinary start")
    },
  })
  try {
    const pool = f.manager.workpools.create(
      { sessionId: "parent-1", rootSessionId: "root", depth: 0, cwd: f.cwd },
      { name: "planned-sync", agent: { category: "quick", prompt: "work" }, mode: "fresh" },
    )
    expect(typeof pool.pool_id).toBe("string")
    expect("then" in pool).toBe(false)
    expect(f.order).toEqual(["planner"])
  } finally {
    await f.finish()
  }
})
