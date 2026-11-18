import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Scope } from "effect"
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
async function withGuard(
  run: (owner: OwnedChildToolGuard, callRead: (sessionID: string) => Promise<string>) => Promise<void>,
): Promise<void> {
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
  const callRead = async (sessionID: string) => {
    const leaf = tools.get("opaque-read")
    if (!leaf) throw Error("controlled read leaf missing")
    const context = { sessionID, agent: "verified-unit-build" } as unknown as Parameters<typeof leaf.execute>[1]
    const exit = await Effect.runPromiseExit(leaf.execute({}, context))
    return Exit.isSuccess(exit) ? "ran" : Cause.pretty(exit.cause)
  }
  try {
    await run(owner, callRead)
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
  test("#when the lead's task_output lists its tasks #then the revived child is listed and readable and the still-parked sibling is listed read-only without being captured", async () => {
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
          expect(read.listed.toSorted()).toEqual([revived.task_id, sibling.task_id].toSorted())
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

describe("#given an owned child whose final run ends while a reload parks it", () => {
  test("#when the next generation restores it #then the task settles once with that run's answer and nothing is replayed", async () => {
    await withGuard(async (before) => {
      await withGuard(async (after) => {
        await withOwnedRuntimeUnit(async (runtime, state) => {
          // given: the child is mid-turn when the runtime closes; the host ends the step only inside the teardown
          const started = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
          if (started.kind !== "started") throw Error(JSON.stringify(started))
          await until(() => state.hostActive(), "child turn running")
          const childID = String(runtime.get(started.task_id)?.child_session_id)
          state.hostShutdownOrdering()
          const reopening = state.reopen({
            childToolGuard: after,
            authorizeRecovery: async (spec) => recoveryApproved(spec),
          })
          await until(() => state.calls.includes("host-wait"), "shutdown park waits for the step")
          // the child's final run finishes on its own after the park detached the outcome
          state.finishFrame(childID)
          state.endTeardown()
          const reloaded = await reopening
          const parked = reloaded.get(started.task_id)

          // when
          const restored = await restoreThroughOperation(reloaded, started.task_id)
          const settled = await reloaded.wait(started.task_id, AbortSignal.timeout(5000))
          const again = await restoreThroughOperation(reloaded, started.task_id)

          // then
          expect(parked?.status).toBe("running")
          expect(parked?.residency_state).toBe("persisted_only")
          expect(restored).toBe(true)
          expect(settled.status).toBe("completed")
          expect(settled.final_response).toBe("after managed inputs")
          expect(settled.observation_uncertain).toBeUndefined()
          expect(inputs(state.calls)).toEqual([])
          expect(again).toBe(false)
          expect(reloaded.get(started.task_id)?.status).toBe("completed")
        }, guarded(before))
      })
    })
  })
})

describe("#given an owned child whose run an in-process reload left going and which then ended on its own", () => {
  test("#when the next generation restores it #then the task settles once with that run's answer and no continuation is sent", async () => {
    await withGuard(async (before) => {
      await withGuard(async (after) => {
        await withOwnedRuntimeUnit(async (runtime, state) => {
          // given: the park sees the run open, the host keeps it going and it ends after the park
          const started = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
          if (started.kind !== "started") throw Error(JSON.stringify(started))
          await until(() => state.hostActive(), "child turn running")
          const childID = String(runtime.get(started.task_id)?.child_session_id)
          state.keepRunsAcrossPark()
          const reloaded = await state.reopen({
            childToolGuard: after,
            authorizeRecovery: async (spec) => recoveryApproved(spec),
          })
          const parked = reloaded.get(started.task_id)
          state.finishFrame(childID)

          // when
          const restored = await restoreThroughOperation(reloaded, started.task_id)
          const settled = await reloaded.wait(started.task_id, AbortSignal.timeout(5000))

          // then
          expect(parked?.status).toBe("running")
          expect(parked?.residency_state).toBe("persisted_only")
          expect(restored).toBe(true)
          expect(inputs(state.calls)).toEqual([])
          expect(settled.status).toBe("completed")
          expect(settled.final_response).toBe("after managed inputs")
          expect(settled.observation_uncertain).toBeUndefined()
        }, guarded(before))
      })
    })
  })

  test("#when the lead sends to it after that run settled the task #then the message starts its next turn", async () => {
    await withGuard(async (before) => {
      await withGuard(async (after) => {
        await withOwnedRuntimeUnit(async (runtime, state) => {
          // given: the restored task settled with the run the host finished on its own
          const started = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
          if (started.kind !== "started") throw Error(JSON.stringify(started))
          await until(() => state.hostActive(), "child turn running")
          const childID = String(runtime.get(started.task_id)?.child_session_id)
          state.keepRunsAcrossPark()
          const reloaded = await state.reopen({
            childToolGuard: after,
            authorizeRecovery: async (spec) => recoveryApproved(spec),
          })
          state.finishFrame(childID)
          await restoreThroughOperation(reloaded, started.task_id)
          const settled = await reloaded.wait(started.task_id, AbortSignal.timeout(5000))

          // when
          const sent = await withOperation(reloaded, (owner) =>
            owner.send.sendToTask({
              idOrName: started.task_id,
              message: "one more thing",
              deliverAs: "followUp",
              callerSessionId: "parent",
            }),
          )
          const delivered = await until(() => inputs(state.calls).length > 0, "follow-up delivered").then(
            () => true,
            () => false,
          )

          // then
          expect(settled.status).toBe("completed")
          expect(JSON.stringify(sent)).not.toContain("not positively settled")
          expect(delivered).toBe(true)
          expect(inputs(state.calls)).toHaveLength(1)
        }, guarded(before))
      })
    })
  })
})

describe("#given an owned child a reload parked and two live runtimes of the project that both start serving it", () => {
  test("#when both revive it at once #then exactly one takes it, the other leaves it without a refusal, and the other runtime does not refuse the child's tools", async () => {
    await withGuard(async (before) => {
      await withGuard(async (first, callFirst) => {
        await withGuard(async (second, callSecond) => {
          await withOwnedRuntimeUnit(async (runtime, state) => {
            // given: the child is parked, then two runtimes with their own live journal owners open
            const started = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
            if (started.kind !== "started") throw Error(JSON.stringify(started))
            await until(() => state.hostActive(), "child turn running")
            const one = await state.reopen({
              childToolGuard: first,
              authorizeRecovery: async (spec) => recoveryApproved(spec),
            })
            const other = await state.openAlongside({
              childToolGuard: second,
              authorizeRecovery: async (spec) => recoveryApproved(spec),
            })
            const childID = String(one.get(started.task_id)?.child_session_id)

            // when
            const outcomes = await Promise.allSettled([
              restoreThroughOperation(one, started.task_id),
              restoreThroughOperation(other, started.task_id),
            ])
            await until(() => inputs(state.calls).length > 0, "winner's continuation delivered")
            const firstWon = outcomes[0]?.status === "fulfilled" && outcomes[0].value
            const loserTool = await (firstWon ? callSecond : callFirst)(childID)
            const loserSend = await withOperation(firstWon ? other : one, (owner) =>
              owner.send.sendToTask({
                idOrName: started.task_id,
                message: "from the other runtime",
                deliverAs: "followUp",
                callerSessionId: "parent",
              }),
            ).then(JSON.stringify, String)
            const loserRestore = await withOperation(firstWon ? other : one, (owner) =>
              owner.recovery.restoreLeftBehind(),
            )

            // then
            expect(loserRestore).toEqual({ restored: [], held: [], elsewhere: [started.task_id] })
            expect(
              outcomes.map((outcome) => (outcome.status === "fulfilled" ? outcome.value : String(outcome.reason))),
            ).toEqual(expect.arrayContaining([true, false]))
            expect(loserTool).toBe("ran")
            expect(loserSend).toContain("is held by another live runtime serving this project")
            expect(inputs(state.calls)).toEqual(["input:queue"])
          }, guarded(before))
        })
      })
    })
  })
})

describe("#given an owned child a reload parked that the next generation has not revived", () => {
  test("#when the lead cancels it #then the cancel takes its custody and ends it, its session closes, and it is never revived later", async () => {
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
          const childID = String(reloaded.get(started.task_id)?.child_session_id)
          const removesBefore = state.calls.filter((call) => call === "remove").length

          // when
          const cancelled = await withOperation(reloaded, (owner) =>
            owner.cancel.cancelTask(started.task_id, "lead cancelled the parked child"),
          ).then(
            (value) => value,
            (error: unknown) => String(error),
          )
          const revived = await restoreThroughOperation(reloaded, started.task_id).then(String, String)

          // then
          expect(cancelled).toEqual(expect.objectContaining({ kind: "cancelled", task_id: started.task_id }))
          expect(reloaded.get(started.task_id)?.status).toBe("cancelled")
          expect(state.calls.filter((call) => call === "remove")).toHaveLength(removesBefore + 1)
          expect(state.session(childID)).toBeUndefined()
          expect(revived).toBe("false")
          expect(inputs(state.calls)).toEqual([])
        }, guarded(before))
      })
    })
  })
})

describe("#given an owned child a reload parked whose first revival fails before its guard is bound", () => {
  test("#when the revival is retried #then the retry revives it and Native's continuation is delivered once", async () => {
    await withGuard(async (before) => {
      await withGuard(async (after) => {
        await withOwnedRuntimeUnit(async (runtime, state) => {
          // given
          const started = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
          if (started.kind !== "started") throw Error(JSON.stringify(started))
          await until(() => state.hostActive(), "child turn running")
          let failBinding = true
          const reloaded = await state.reopen({
            childToolGuard: after,
            authorizeRecovery: async (spec) => recoveryApproved(spec),
            childGuardBinding: (_spec, prepared) => ({
              coverage,
              assertCurrent() {},
              bind(child, assertCurrent) {
                if (failBinding) {
                  failBinding = false
                  throw Error("Controlled guard binding failure")
                }
                return { child, agent: prepared.buildAgentID, coverage, assertCurrent }
              },
            }),
          })

          // when
          const first = await restoreThroughOperation(reloaded, started.task_id).then(String, String)
          const retried = await restoreThroughOperation(reloaded, started.task_id).then(String, String)
          if (retried === "true") await until(() => inputs(state.calls).length > 0, "continuation delivered")

          // then
          expect(first).toContain("Controlled guard binding failure")
          expect(retried).toBe("true")
          expect(inputs(state.calls)).toEqual(["input:queue"])
        }, guarded(before))
      })
    })
  })
})

describe("#given a restored owned child whose recovered turn waits for the host to finish the run it kept going", () => {
  test("#when the plugin location reloads again while that run is still going #then the park completes, nothing is reported or replayed, and the next generation continues the turn once", async () => {
    await withGuard(async (before) => {
      await withGuard(async (middle) => {
        await withGuard(async (after) => {
          await withOwnedRuntimeUnit(async (runtime, state) => {
            // given: the first park sees the run open and the host keeps it going; the next generation's
            // restore waits for the host to report the session idle before adopting or continuing the turn
            const started = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
            if (started.kind !== "started") throw Error(JSON.stringify(started))
            await until(() => state.hostActive(), "child turn running")
            state.keepRunsAcrossPark()
            const restoring = await state.reopen({
              childToolGuard: middle,
              authorizeRecovery: async (spec) => recoveryApproved(spec),
            })
            state.waitUntilIdle()
            const waitsBefore = state.calls.filter((call) => call === "host-wait").length
            const restored = await restoreThroughOperation(restoring, started.task_id)
            await until(
              () => state.calls.filter((call) => call === "host-wait").length > waitsBefore,
              "restored turn waits for the host",
            )
            // a real interrupt ends the run; the reload's park interrupts it
            state.keepRunsAcrossPark(false)

            // when
            const reload = state.reopen({
              childToolGuard: after,
              authorizeRecovery: async (spec) => recoveryApproved(spec),
            })
            const parkedInTime = await Promise.race([reload.then(() => true), Bun.sleep(3000).then(() => false)])
            if (!parkedInTime) state.finishFrame(String(restoring.get(started.task_id)?.child_session_id))
            const reloaded = await reload
            const parked = reloaded.get(started.task_id)
            const handed = parkedInTime && (await restoreThroughOperation(reloaded, started.task_id))
            if (handed) await until(() => inputs(state.calls).length > 0, "continuation delivered")

            // then
            expect(restored).toBe(true)
            expect(parkedInTime).toBe(true)
            expect(parked?.status).toBe("running")
            expect(parked?.residency_state).toBe("persisted_only")
            expect(handed).toBe(true)
            expect(inputs(state.calls)).toEqual(["input:queue"])
          }, guarded(before))
        })
      })
    })
  })
})

describe("#given an owned child whose final run a reload parked and which ran again before it was restored", () => {
  test("#when the next generation restores it #then the task settles with the latest run's answer", async () => {
    await withGuard(async (before) => {
      await withGuard(async (after) => {
        await withOwnedRuntimeUnit(async (runtime, state) => {
          // given: the final run ends inside the park's teardown, then a run starts and ends with no observer
          const started = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
          if (started.kind !== "started") throw Error(JSON.stringify(started))
          await until(() => state.hostActive(), "child turn running")
          const childID = String(runtime.get(started.task_id)?.child_session_id)
          state.hostShutdownOrdering()
          const reopening = state.reopen({
            childToolGuard: after,
            authorizeRecovery: async (spec) => recoveryApproved(spec),
          })
          await until(() => state.calls.includes("host-wait"), "shutdown park waits for the step")
          state.finishFrame(childID)
          state.endTeardown()
          const reloaded = await reopening
          state.hostRun(childID, "latest answer between observers")

          // when
          const restored = await restoreThroughOperation(reloaded, started.task_id)
          const settled = await reloaded.wait(started.task_id, AbortSignal.timeout(5000))

          // then
          expect(restored).toBe(true)
          expect(inputs(state.calls)).toEqual([])
          expect(settled.status).toBe("completed")
          expect(settled.final_response).toBe("latest answer between observers")
        }, guarded(before))
      })
    })
  })
})

describe("#given owned children started with different label sources", () => {
  test("#when each child is staged and a running one is restored after a reload #then every title write carries the Native task label with its id", async () => {
    await withGuard(async (before) => {
      await withGuard(async (after) => {
        await withOwnedRuntimeUnit(async (runtime, state) => {
          // given
          const titles = new Map<string, string[]>()
          state.onUpdate((input) => {
            if (input.title === undefined) return
            titles.set(input.sessionID, [...(titles.get(input.sessionID) ?? []), input.title])
          })
          const summary = await runtime.start({
            category: "qa",
            prompt: "block-until-interrupt",
            task_summary: "Title probe A",
            description: "ignored description",
          })
          const described = await runtime.start({
            category: "qa",
            prompt: "described child",
            description: "Title probe B",
          })
          const bare = await runtime.start({ category: "qa", prompt: "bare child" })
          if (summary.kind !== "started" || described.kind !== "started" || bare.kind !== "started")
            throw Error(JSON.stringify([summary, described, bare]))
          await runtime.wait(described.task_id, AbortSignal.timeout(5000))
          await runtime.wait(bare.task_id, AbortSignal.timeout(5000))
          await until(() => state.hostActive(), "summary child turn running")
          const children = new Map(
            [summary, described, bare].map((task) => [
              task.task_id,
              String(runtime.get(task.task_id)?.child_session_id),
            ]),
          )
          const childOf = (id: string) => String(children.get(id))

          // when
          const reloaded = await state.reopen({
            childToolGuard: after,
            authorizeRecovery: async (spec) => recoveryApproved(spec),
          })
          const restored = await restoreThroughOperation(reloaded, summary.task_id)
          await until(() => (titles.get(childOf(summary.task_id))?.length ?? 0) > 1, "recovered title write")
          state.finishFrame(childOf(summary.task_id))
          const settled = await reloaded.wait(summary.task_id, AbortSignal.timeout(5000))

          // then
          expect(restored).toBe(true)
          expect(settled.status).toBe("completed")
          const summaryTitles = titles.get(childOf(summary.task_id)) ?? []
          expect(summaryTitles.length).toBeGreaterThan(1)
          expect(new Set(summaryTitles)).toEqual(new Set([`Title probe A (${summary.task_id})`]))
          expect(titles.get(childOf(described.task_id))).toEqual([`Title probe B (${described.task_id})`])
          expect(titles.get(childOf(bare.task_id))).toEqual([`Native task ${bare.task_id}`])
        }, guarded(before))
      })
    })
  })
})
