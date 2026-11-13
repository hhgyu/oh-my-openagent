import { describe, expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import type { ToolDomain, ToolEditor } from "@opencode/plugin/effect/tool"
import type { PermissionDomain } from "@opencode/plugin/effect/permission"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { ManagedStartSpec } from "@oh-my-opencode/senpi-task/manager-kernel"
import { filterSharedParentTools } from "@oh-my-opencode/senpi-task/task-operations"
import { acquireOwnedChildToolGuard, type OwnedChildToolGuard } from "../../host/owned-child-tool-guard"
import { prepareHostTaskGrant, prepareRecoveryHostGrant } from "./host-grant"
import type { NativeOwnedTaskRuntimeOptions } from "./runtime"
import { withOwnedRuntimeUnit } from "./runtime.test"
import { enterNativeGeneration, PredecessorParkTimeout } from "./generation-handover"
import { watchLocationShutdown } from "./location-shutdown"
import type { NativeOperationOwner } from "./operation-ports"

type UnitRuntime = Parameters<Parameters<typeof withOwnedRuntimeUnit>[0]>[0]
type PlannedArgs = Parameters<NonNullable<NativeOwnedTaskRuntimeOptions["authorizePlannedStart"]>>

const catalog = [
  { id: "opaque-read", name: "read", options: { codemode: true } },
  { id: "opaque-edit", name: "edit" },
]
const coverage = { boundRequirements: ["codemode-network-guard" as const] }
const approved = (spec: PlannedArgs[0], plan: PlannedArgs[1]) => ({
  buildAgentID: "verified-unit-build",
  authorityIssued: false as const,
  selection: prepareHostTaskGrant({
    spec,
    plan,
    nativeTools: [{ name: "read" }],
    includeTaskTools: true,
    catalog,
    canonical: { filterSharedParentTools },
  }),
})
const recoveryApproved = (spec: ManagedStartSpec) => ({
  buildAgentID: "verified-unit-build",
  authorityIssued: false as const,
  selection: prepareRecoveryHostGrant({
    spec,
    nativeTools: [{ name: "read" }],
    includeTaskTools: true,
    catalog,
    canonical: { filterSharedParentTools },
  }),
})
const guarded = (owner: OwnedChildToolGuard): Parameters<typeof withOwnedRuntimeUnit>[1] => ({
  childToolGuard: owner,
  authorizePlannedStart: async (spec, plan) => approved(spec, plan),
  childGuardBinding: (_spec, prepared) => ({
    coverage,
    assertCurrent() {},
    bind(child, assertCurrent) {
      return { child, agent: prepared.buildAgentID, coverage, assertCurrent }
    },
  }),
})

/** One controlled guard generation over the original leaves, closed after `run`. */
async function withGuard(run: (owner: OwnedChildToolGuard) => Promise<void>): Promise<void> {
  const scope = Scope.makeUnsafe(),
    tools = new Map<string, ReturnType<ToolEditor["list"]>[number]>()
  for (const [id, name] of [
    ["opaque-read", "read"],
    ["opaque-edit", "edit"],
  ])
    tools.set(id, {
      id,
      name,
      description: "controlled original leaf",
      input: { type: "object" },
      options: { codemode: true },
      execute: () => Effect.sync(() => ({ content: "original leaf" })),
    })
  const editor: ToolEditor = {
    list: () => [...tools.values()],
    get: (id) => tools.get(id),
    namespace() {},
    remove: (id) => {
      tools.delete(id)
    },
    add(value) {
      tools.set(value.name, { ...value, id: value.name })
    },
    update(id, change) {
      const value = tools.get(id)
      if (value) change(value)
    },
  }
  const tool: Pick<ToolDomain, "transform"> = {
    transform: (change) =>
      Effect.sync(() => {
        change(editor)
        return { dispose: Effect.void }
      }),
  }
  const permission: Pick<PermissionDomain, "hook"> = { hook: () => Effect.succeed({ dispose: Effect.void }) }
  const owner = await Effect.runPromise(
    Effect.provideService(acquireOwnedChildToolGuard({ tool, permission }), Scope.Scope, scope),
  )
  try {
    await run(owner)
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
  }
}

/** One genuine operation owner of the lead's call, the way every public verb receives it. */
async function withOperation<T>(runtime: UnitRuntime, work: (owner: NativeOperationOwner) => Promise<T>): Promise<T> {
  const stop = new AbortController()
  const owner = runtime.operationOwner(runtime.rootParent, {
    source: {
      sessionID: "parent" as ToolContext["sessionID"],
      agent: "build" as ToolContext["agent"],
      messageID: "unit-restore-message" as ToolContext["messageID"],
      id: "unit-restore-call" as ToolContext["id"],
    },
    acceptedSignal: stop.signal,
    reportingSignal: stop.signal,
    assertAction() {},
    assertLifetime() {},
  })
  try {
    return await work(owner)
  } finally {
    owner.closeReporting()
    await owner.joinReporting()
  }
}

/** The genuine operation-owner restore a `workflow` call (or a lead's team call) uses after a reload. */
function restoreThroughOperation(runtime: UnitRuntime, id: string): Promise<boolean> {
  return withOperation(runtime, (owner) => owner.recovery.restoreAfterReload(id))
}

/** The host's `location.shutdown` stream of one location: a foreign location's shutdown first, then ours. */
function locationShutdown(directory: string) {
  const fired = Promise.withResolvers<undefined>()
  const host = {
    location: { directory },
    event: {
      async *subscribe() {
        await fired.promise
        yield { type: "location.shutdown", location: { directory: `${directory}-other` } }
        yield { type: "location.shutdown", location: { directory } }
      },
    },
  } as unknown as Parameters<typeof watchLocationShutdown>[0]
  return { host, emit: () => fired.resolve(undefined) }
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return
    await Bun.sleep(5)
  }
  throw Error(`Condition not reached: ${label}`)
}

const inputs = (calls: readonly string[]) => calls.filter((call) => call.startsWith("input:"))

describe("#given an owned child whose turn was still running when a reload parked it", () => {
  test("#when the next generation restores it through the operation #then Native's continuation is delivered once as a new observed turn and the task completes from it", async () => {
    await withGuard(async (before) => {
      await withGuard(async (after) => {
        await withOwnedRuntimeUnit(async (runtime, state) => {
          // given: a child mid-turn (its model request held) when the runtime closes and parks it
          const started = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
          if (started.kind !== "started") throw Error(JSON.stringify(started))
          await until(() => state.hostActive(), "child turn running")
          const reloaded = await state.reopen({
            childToolGuard: after,
            authorizeRecovery: async (spec) => recoveryApproved(spec),
          })
          const parked = reloaded.get(started.task_id)
          expect(parked?.status).toBe("running")
          expect(parked?.residency_state).toBe("persisted_only")
          expect(inputs(state.calls)).toEqual([])

          // when
          const restored = await restoreThroughOperation(reloaded, started.task_id)
          await until(() => inputs(state.calls).length > 0, "continuation delivered")
          state.finishFrame(String(parked?.child_session_id))
          const settled = await reloaded.wait(started.task_id, AbortSignal.timeout(5000))

          // then
          expect(restored).toBe(true)
          expect(inputs(state.calls)).toEqual(["input:queue"])
          expect(state.calls.filter((call) => call === "create")).toHaveLength(1)
          expect(settled.status).toBe("completed")
          expect(settled.final_response).toBe("after managed inputs")
          expect(settled.notification.run_epoch).toBe(1)
          expect(settled.observation_uncertain).toBeUndefined()
        }, guarded(before))
      })
    })
  })
})

describe("#given two finished owned children of one lead, one of which the host already removed", () => {
  test("#when the plugin closes and reloads #then close completes, the removed child retires as closed and the live child parks and restores", async () => {
    await withGuard(async (before) => {
      await withGuard(async (after) => {
        await withOwnedRuntimeUnit(async (runtime, state) => {
          // given: both children finished, then the host removes one (OpenCode removes a removed lead's children)
          const removed = await runtime.start({ category: "qa", prompt: "removed child" })
          const live = await runtime.start({ category: "qa", prompt: "live child" })
          if (removed.kind !== "started" || live.kind !== "started") throw Error(JSON.stringify([removed, live]))
          const removedRecord = await runtime.wait(removed.task_id, AbortSignal.timeout(5000))
          await runtime.wait(live.task_id, AbortSignal.timeout(5000))
          state.removeByHost(String(removedRecord.child_session_id))
          const removesBefore = state.calls.filter((call) => call === "remove").length

          // when
          const reloaded = await state.reopen({
            childToolGuard: after,
            authorizeRecovery: async (spec) => recoveryApproved(spec),
          })

          // then
          expect(state.calls.filter((call) => call === "remove")).toHaveLength(removesBefore)
          expect(reloaded.get(removed.task_id)?.residency_state).toBe("persisted_only")
          expect(reloaded.get(live.task_id)?.residency_state).toBe("persisted_only")
          expect(await restoreThroughOperation(reloaded, removed.task_id)).toBe(false)
          expect(await restoreThroughOperation(reloaded, live.task_id)).toBe(true)
          expect(reloaded.get(live.task_id)?.status).toBe("completed")
        }, guarded(before))
      })
    })
  })
})

describe("#given an owned child mid-turn when an in-process reload leaves its generation open", () => {
  test("#when the shutdown park waits on a host that releases the location only from its own close #then the park settles on that release, the next generation's call waits for it, restores the child and Native's continuation is delivered once", async () => {
    const released = new AbortController()
    await withGuard(async (before) => {
      await withGuard(async (after) => {
        await withOwnedRuntimeUnit(
          async (runtime, state) => {
            // given: generation A holds a child mid-turn, and the host builds generation B in the same
            // process without closing A (OpenCode closes a location only once no running step borrows it)
            const directory = `unit-location-${crypto.randomUUID()}`
            const retiring = enterNativeGeneration(directory)
            const started = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
            if (started.kind !== "started") throw Error(JSON.stringify(started))
            await until(() => state.hostActive(), "child turn running")
            // OpenCode's ordering: the interrupted step ends only inside the location teardown that runs the plugin's close
            state.hostShutdownOrdering()
            const shutdown = locationShutdown(directory)
            let parking = 0,
              retired = false
            const stopWatch = watchLocationShutdown(shutdown.host, () => {
              parking++
              return retiring
                .retire(() => runtime.close())
                .finally(() => {
                  retired = true
                })
            })
            const next = enterNativeGeneration(directory)
            const reloaded = await state.openAlongside({
              childToolGuard: after,
              authorizeRecovery: async (spec) => recoveryApproved(spec),
              locationReleased: new AbortController().signal,
            })
            const held = reloaded.get(started.task_id)
            expect(held?.status).toBe("running")
            expect(held?.residency_state).toBe("resident")
            expect(held?.host_pid).toBe(process.pid)
            // the defect: no child of the new generation backs the row, so a restore finds nothing to do
            expect(await restoreThroughOperation(reloaded, started.task_id)).toBe(false)

            // when: the shutdown signal starts A's park, which waits for the interrupted step
            shutdown.emit()
            await until(
              () => parking > 0 && state.calls.includes("host-wait"),
              "shutdown park waits for the interrupted step",
            )
            await Bun.sleep(30)
            const parkWaited = !retired
            // a call of B never waits unboundedly on A
            const bounded = await next.predecessorsSettled(undefined, 20).then(
              () => "settled",
              (error: unknown) => (error instanceof PredecessorParkTimeout ? "timed out" : String(error)),
            )
            // the host closes A's location (its own close of A) and the interrupt's outcome arrives during that teardown
            released.abort(Error("OpenCode closed the plugin location"))
            state.flushDeferredInterrupts()
            await next.predecessorsSettled()
            state.endTeardown()
            const parked = reloaded.get(started.task_id)
            const restored = await restoreThroughOperation(reloaded, started.task_id)
            await until(() => inputs(state.calls).length > 0, "continuation delivered")
            state.finishFrame(String(held?.child_session_id))
            const settled = await reloaded.wait(started.task_id, AbortSignal.timeout(5000))
            stopWatch()

            // then
            expect(parkWaited).toBe(true)
            expect(bounded).toBe("timed out")
            expect(retired).toBe(true)
            expect(parking).toBe(1)
            expect(parked?.residency_state).toBe("persisted_only")
            expect(restored).toBe(true)
            expect(inputs(state.calls)).toEqual(["input:queue"])
            expect(state.calls.filter((call) => call === "create")).toHaveLength(1)
            expect(settled.status).toBe("completed")
            expect(settled.final_response).toBe("after managed inputs")
            expect(settled.notification.run_epoch).toBe(1)
            expect(settled.observation_uncertain).toBeUndefined()
          },
          { ...guarded(before), locationReleased: released.signal },
        )
      })
    })
  })
})

describe("#given two finished children a reload parked, one of which the lead revives through task_send", () => {
  test("#when the lead's task_output lists its tasks #then the revived child is listed and readable and the still-parked sibling no longer fails the listing", async () => {
    await withGuard(async (before) => {
      await withGuard(async (after) => {
        await withOwnedRuntimeUnit(async (runtime, state) => {
          // given
          const revived = await runtime.start({ category: "qa", prompt: "revived child" })
          const sibling = await runtime.start({ category: "qa", prompt: "parked sibling" })
          if (revived.kind !== "started" || sibling.kind !== "started") throw Error(JSON.stringify([revived, sibling]))
          await runtime.wait(revived.task_id, AbortSignal.timeout(5000))
          await runtime.wait(sibling.task_id, AbortSignal.timeout(5000))
          const reloaded = await state.reopen({
            childToolGuard: after,
            authorizeRecovery: async (spec) => recoveryApproved(spec),
          })
          const sent = await withOperation(reloaded, (owner) =>
            owner.send.sendToTask({
              idOrName: revived.task_id,
              message: "again after the reload",
              deliverAs: "followUp",
              callerSessionId: "parent",
            }),
          )
          expect(sent.kind).toBe("revived")
          await until(() => inputs(state.calls).length > 0, "revive input delivered")
          state.finishFrame(String(reloaded.get(revived.task_id)?.child_session_id))
          await reloaded.wait(revived.task_id, AbortSignal.timeout(5000))

          // when: task_output resolves its target from the parent's listing, then reads it
          const read = await withOperation(reloaded, async (owner) => {
            const listed = owner.output
              .list({ scope: "parent-session", session_id: "parent" })
              .map((item) => item.record.task_id)
            return { listed, record: owner.output.get(revived.task_id) }
          })

          // then
          expect(read.listed).toEqual([revived.task_id])
          expect(read.record?.status).toBe("completed")
          expect(read.record?.notification.run_epoch).toBe(1)
          expect(reloaded.get(sibling.task_id)?.residency_state).toBe("persisted_only")
          expect(await restoreThroughOperation(reloaded, sibling.task_id)).toBe(true)
        }, guarded(before))
      })
    })
  })
})

describe("#given an owned child a reload parked while its turn was still running", () => {
  test("#when the lead sends to it after the reload #then the send revives it, the cut-off turn continues once, the message follows it and task_output reads it", async () => {
    await withGuard(async (before) => {
      await withGuard(async (after) => {
        await withOwnedRuntimeUnit(async (runtime, state) => {
          // given
          const started = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
          if (started.kind !== "started") throw Error(JSON.stringify(started))
          await until(() => state.hostActive(), "child turn running")
          const reloaded = await state.reopen({
            childToolGuard: after,
            authorizeRecovery: async (spec) => recoveryApproved(spec),
          })
          const parked = reloaded.get(started.task_id)

          // when
          const sent = await withOperation(reloaded, (owner) =>
            owner.send.sendToTask({
              idOrName: started.task_id,
              message: "continue after the reload",
              deliverAs: "followUp",
              callerSessionId: "parent",
            }),
          )
          await until(() => inputs(state.calls).length > 1, "continuation and sent message delivered")
          state.finishFrame(String(parked?.child_session_id))
          const settled = await reloaded.wait(started.task_id, AbortSignal.timeout(5000))
          const listed = await withOperation(reloaded, async (owner) =>
            owner.output.list({ scope: "parent-session", session_id: "parent" }).map((item) => item.record.task_id),
          )

          // then
          expect(parked?.status).toBe("running")
          expect(parked?.residency_state).toBe("persisted_only")
          expect(sent.kind).toBe("steered")
          expect(inputs(state.calls)).toEqual(["input:queue", "input:queue"])
          expect(state.calls.filter((call) => call === "create")).toHaveLength(1)
          expect(settled.status).toBe("completed")
          expect(listed).toEqual([started.task_id])
        }, guarded(before))
      })
    })
  })
})
