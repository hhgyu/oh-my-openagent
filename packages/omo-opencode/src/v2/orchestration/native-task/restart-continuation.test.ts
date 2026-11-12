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

type UnitRuntime = Parameters<Parameters<typeof withOwnedRuntimeUnit>[0]>[0]
type PlannedArgs = Parameters<NonNullable<NativeOwnedTaskRuntimeOptions["authorizePlannedStart"]>>

const catalog = [{ id: "opaque-read", name: "read", options: { codemode: true } }, { id: "opaque-edit", name: "edit" }]
const coverage = { boundRequirements: ["codemode-network-guard" as const] }
const approved = (spec: PlannedArgs[0], plan: PlannedArgs[1]) => ({ buildAgentID: "verified-unit-build", authorityIssued: false as const,
  selection: prepareHostTaskGrant({ spec, plan, nativeTools: [{ name: "read" }], includeTaskTools: true, catalog, canonical: { filterSharedParentTools } }) })
const recoveryApproved = (spec: ManagedStartSpec) => ({ buildAgentID: "verified-unit-build", authorityIssued: false as const,
  selection: prepareRecoveryHostGrant({ spec, nativeTools: [{ name: "read" }], includeTaskTools: true, catalog, canonical: { filterSharedParentTools } }) })
const guarded = (owner: OwnedChildToolGuard): Parameters<typeof withOwnedRuntimeUnit>[1] => ({
  childToolGuard: owner, authorizePlannedStart: async (spec, plan) => approved(spec, plan),
  childGuardBinding: (_spec, prepared) => ({ coverage, assertCurrent() {}, bind(child, assertCurrent) { return { child, agent: prepared.buildAgentID, coverage, assertCurrent } } }),
})

/** One controlled guard generation over the original leaves, closed after `run`. */
async function withGuard(run: (owner: OwnedChildToolGuard) => Promise<void>): Promise<void> {
  const scope = Scope.makeUnsafe(), tools = new Map<string, ReturnType<ToolEditor["list"]>[number]>()
  for (const [id, name] of [["opaque-read", "read"], ["opaque-edit", "edit"]]) tools.set(id, {
    id, name, description: "controlled original leaf", input: { type: "object" }, options: { codemode: true },
    execute: () => Effect.sync(() => ({ content: "original leaf" })),
  })
  const editor: ToolEditor = { list: () => [...tools.values()], get: id => tools.get(id), namespace() {}, remove: id => { tools.delete(id) },
    add(value) { tools.set(value.name, { ...value, id: value.name }) }, update(id, change) { const value = tools.get(id); if (value) change(value) } }
  const tool: Pick<ToolDomain, "transform"> = { transform: change => Effect.sync(() => { change(editor); return { dispose: Effect.void } }) }
  const permission: Pick<PermissionDomain, "hook"> = { hook: () => Effect.succeed({ dispose: Effect.void }) }
  const owner = await Effect.runPromise(Effect.provideService(acquireOwnedChildToolGuard({ tool, permission }), Scope.Scope, scope))
  try { await run(owner) } finally { await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))) }
}

/** The genuine operation-owner restore a `workflow` call (or a lead's team call) uses after a reload. */
async function restoreThroughOperation(runtime: UnitRuntime, id: string): Promise<boolean> {
  const stop = new AbortController()
  const owner = runtime.operationOwner(runtime.rootParent, { source: { sessionID: "parent" as ToolContext["sessionID"], agent: "build" as ToolContext["agent"], messageID: "unit-restore-message" as ToolContext["messageID"], id: "unit-restore-call" as ToolContext["id"] },
    acceptedSignal: stop.signal, reportingSignal: stop.signal, assertAction() {}, assertLifetime() {} })
  try { return await owner.recovery.restoreAfterReload(id) } finally { owner.closeReporting(); await owner.joinReporting() }
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) { if (condition()) return; await Bun.sleep(5) }
  throw Error(`Condition not reached: ${label}`)
}

const inputs = (calls: readonly string[]) => calls.filter(call => call.startsWith("input:"))

describe("#given an owned child whose turn was still running when a reload parked it", () => {
  test("#when the next generation restores it through the operation #then Native's continuation is delivered once as a new observed turn and the task completes from it", async () => {
    await withGuard(async before => { await withGuard(async after => {
      await withOwnedRuntimeUnit(async (runtime, state) => {
        // given: a child mid-turn (its model request held) when the runtime closes and parks it
        const started = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
        if (started.kind !== "started") throw Error(JSON.stringify(started))
        await until(() => state.hostActive(), "child turn running")
        const reloaded = await state.reopen({ childToolGuard: after, authorizeRecovery: async spec => recoveryApproved(spec) })
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
        expect(state.calls.filter(call => call === "create")).toHaveLength(1)
        expect(settled.status).toBe("completed")
        expect(settled.final_response).toBe("after managed inputs")
        expect(settled.notification.run_epoch).toBe(1)
        expect(settled.observation_uncertain).toBeUndefined()
      }, guarded(before))
    }) })
  })
})
