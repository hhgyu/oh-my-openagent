import { expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { OmoTaskSettingsSchema } from "@oh-my-opencode/omo-config-core"
import type { ToolDomain, ToolEditor } from "@opencode/plugin/effect/tool"
import type { PermissionDomain } from "@opencode/plugin/effect/permission"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { acquireOwnedChildToolGuard, type OwnedChildToolGuard } from "../../host/owned-child-tool-guard"
import { prepareHostTaskGrant, prepareRecoveryHostGrant } from "./host-grant"
import type { ManagedStartSpec } from "@oh-my-opencode/senpi-task/manager-kernel"
import { createMemberTaskSendTool, filterSharedParentTools } from "@oh-my-opencode/senpi-task/task-operations"
import { withOwnedRuntimeUnit } from "./runtime.test"
import type { NativeOwnedTaskRuntimeOptions } from "./runtime"
import { PARKED_DENY_RULE, PARKING_MARKER_KEY } from "../../host/child-parking"

/** SAME real Native manager/store/backend fixture; controlled SDK domains and
 * unit caller fields only. No actual host/CodeMode acceptance is claimed. */
async function guardFixture(run: (value: {
  owner: OwnedChildToolGuard
  tools: Map<string, ReturnType<ToolEditor["list"]>[number]>
  leaf(sessionID: string, agent: string, id?: string): Promise<Exit.Exit<unknown, unknown>>
  /** The wrapped call created NOW but evaluated later (a lazy Effect of this generation). */
  lazy(sessionID: string, agent: string, id?: string): Effect.Effect<unknown, unknown>
  targetCalls(): number
}) => Promise<void>) {
  const scope = Scope.makeUnsafe(), tools = new Map<string, ReturnType<ToolEditor["list"]>[number]>()
  let targets = 0
  for (const [id, name] of [["opaque-read", "read"], ["opaque-edit", "edit"]]) tools.set(id, {
    id, name, description: "controlled original leaf", input: { type: "object" }, options: { codemode: true },
    execute: () => Effect.sync(() => { targets++; return { content: "original leaf" } }),
  })
  const editor: ToolEditor = { list: () => [...tools.values()], get: id => tools.get(id), namespace() {}, remove: id => { tools.delete(id) },
    add(value) { tools.set(value.name, { ...value, id: value.name }) }, update(id, change) { const value = tools.get(id); if (value) change(value) } }
  const tool: Pick<ToolDomain, "transform"> = { transform: change => Effect.sync(() => { change(editor); return { dispose: Effect.void } }) }
  const permission: Pick<PermissionDomain, "hook"> = { hook: () => Effect.succeed({ dispose: Effect.void }) }
  const owner = await Effect.runPromise(Effect.provideService(acquireOwnedChildToolGuard({ tool, permission }), Scope.Scope, scope))
  const lazy = (sessionID: string, agent: string, id = "opaque-read") => {
    const context = { sessionID: sessionID as ToolContext["sessionID"], agent: agent as ToolContext["agent"], messageID: "unit-runner-message" as ToolContext["messageID"], id: "unit-runner-call" as ToolContext["id"], progress: () => Effect.void }
    return defined(tools.get(id)).execute({}, context)
  }
  try { await run({ owner, tools, targetCalls: () => targets, lazy, leaf: (sessionID, agent, id = "opaque-read") => Effect.runPromiseExit(lazy(sessionID, agent, id)) }) } finally { await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))) }
}

function approved(spec: Parameters<NonNullable<NativeOwnedTaskRuntimeOptions["authorizePlannedStart"]>>[0], plan: Parameters<NonNullable<NativeOwnedTaskRuntimeOptions["authorizePlannedStart"]>>[1]) {
  return { buildAgentID: "verified-unit-build", authorityIssued: false as const, selection: prepareHostTaskGrant({ spec, plan, nativeTools: [{ name: "read" }],
    includeTaskTools: true, catalog: [{ id: "opaque-read", name: "read", options: { codemode: true } }, { id: "opaque-edit", name: "edit" }], canonical: { filterSharedParentTools } }) }
}
const coverage = { boundRequirements: ["codemode-network-guard" as const] }

test("G3 guarded birth binds actual opaque host IDs/build agent before input and survives old caller after first ACK", async () => {
  await guardFixture(async g => {
    const caller = new AbortController(), lifetime = new AbortController(); let admissionChecks = 0, approvals = 0, binds = 0
    await withOwnedRuntimeUnit(async (runtime, state) => {
      const started = await runtime.start({ category: "qa", prompt: "controlled guarded task" })
      if (started.kind !== "started") throw Error(JSON.stringify(started))
      try {
        await runtime.wait(started.task_id)
        const record = defined(runtime.get(started.task_id))
        expect(state.createdAgents).toEqual(["verified-unit-build"]); expect(approvals).toBe(1); expect(binds).toBe(1)
        expect(admissionChecks).toBeGreaterThan(0)
        const exposed = state.contexts[0] as { tools: Record<string, unknown> }
        expect(Object.keys(exposed.tools).sort()).toEqual(["execute", "opaque-read"])
        caller.abort(Error("Original unit call/frame ended after ACK")); const before = admissionChecks
        expect(Exit.isSuccess(await g.leaf(defined(record.child_session_id), "verified-unit-build"))).toBe(true)
        expect(admissionChecks).toBe(before)
        expect(Exit.isFailure(await g.leaf(defined(record.child_session_id), "verified-unit-build", "opaque-edit"))).toBe(true)
        expect(g.targetCalls()).toBe(1)
      } finally { await runtime.end(started.task_id) }
      expect(Exit.isFailure(await g.leaf(defined(defined(runtime.get(started.task_id)).child_session_id), "verified-unit-build"))).toBe(true)
    }, { childToolGuard: g.owner, authorizePlannedStart: async (spec, plan) => { approvals++; return approved(spec, plan) },
      captureStartAuthority: () => ({ admissionSignal: caller.signal, lifetimeSignal: lifetime.signal, assertAdmission() { admissionChecks++; caller.signal.throwIfAborted() }, assertLifetime() { lifetime.signal.throwIfAborted() } }),
      childGuardBinding: (_spec, prepared) => ({ coverage, assertCurrent() {}, bind(child, assertBackendCurrent) {
        binds++; assertBackendCurrent(); return { child, agent: prepared.buildAgentID, coverage, assertCurrent: assertBackendCurrent }
      } }),
    }, ["opaque-read", "opaque-edit", "execute"])
  })
})

test("G3 provisional actual session is denied while create pending; pre-ACK caller cancellation never invokes input", async () => {
  await guardFixture(async g => {
    let childID = "", guardCalls = 0
    const begin = g.owner.beginStage.bind(g.owner)
    g.owner.beginStage = (...args) => { childID = args[1]; guardCalls++; return begin(...args) }
    await withOwnedRuntimeUnit(async (runtime, state) => {
      state.holdCreate()
      const starting = runtime.start({ category: "qa", prompt: "must not prompt" }).catch(error => error)
      await state.createEntered
      try {
        expect(guardCalls).toBe(1); expect(Exit.isFailure(await g.leaf(childID, "verified-unit-build"))).toBe(true)
        expect(state.calls).not.toContain("prompt")
        state.callerAbort.abort(Error("before first ACK"))
      } finally { state.releaseCreate(); await starting }
      expect(state.calls).not.toContain("prompt"); expect(g.targetCalls()).toBe(0)
    }, { childToolGuard: g.owner, authorizePlannedStart: async (spec, plan) => approved(spec, plan),
      childGuardBinding: (_spec, prepared) => ({ coverage, assertCurrent() {}, bind(child, assertCurrent) { return { child, agent: prepared.buildAgentID, coverage, assertCurrent } } }),
    })
  })
})

test("G3 actual remove failure keeps deny claim until explicit END cleanup retries", async () => {
  await guardFixture(async g => {
    await withOwnedRuntimeUnit(async (runtime, state) => {
      const started = await runtime.start({ category: "qa", prompt: "guarded cleanup" }); if (started.kind !== "started") throw Error(JSON.stringify(started))
      await runtime.wait(started.task_id); const record = defined(runtime.get(started.task_id))
      state.failRemoveOnce()
      await expect(runtime.end(started.task_id)).rejects.toThrow()
      expect(Exit.isFailure(await g.leaf(defined(record.child_session_id), "verified-unit-build"))).toBe(true)
      await runtime.end(started.task_id)
      expect(Exit.isFailure(await g.leaf(defined(record.child_session_id), "verified-unit-build"))).toBe(true)
      expect(g.targetCalls()).toBe(0)
    }, { childToolGuard: g.owner, authorizePlannedStart: async (spec, plan) => approved(spec, plan),
      childGuardBinding: (_spec, prepared) => ({ coverage, assertCurrent() {}, bind(child, assertCurrent) { return { child, agent: prepared.buildAgentID, coverage, assertCurrent } } }),
    })
  })
})

test("G3 approved zero-tool child starts model-only while every original leaf remains denied", async () => {
  await guardFixture(async g => {
    await withOwnedRuntimeUnit(async (runtime, state) => {
      const started = await runtime.start({ category: "qa", prompt: "model-only child" }); if (started.kind !== "started") throw Error(JSON.stringify(started))
      try {
        await runtime.wait(started.task_id); const child = defined(defined(runtime.get(started.task_id)).child_session_id)
        expect((state.contexts[0] as { tools: object }).tools).toEqual({})
        expect(Exit.isFailure(await g.leaf(child, "verified-unit-build"))).toBe(true)
        expect(Exit.isFailure(await g.leaf(child, "verified-unit-build", "opaque-edit"))).toBe(true)
      } finally { await runtime.end(started.task_id) }
    }, { childToolGuard: g.owner, authorizePlannedStart: async (spec, plan) => {
      const value = approved(spec, plan)
      return { ...value, selection: { ...value.selection, selected: [], requirements: [], bindingSlots: [], allowsCodeModeTransport: false } }
    }, childGuardBinding: (_spec, prepared) => ({ assertCurrent() {}, bind(child, assertCurrent) { return { child, agent: prepared.buildAgentID, assertCurrent } } }) }, ["opaque-read", "opaque-edit", "execute"])
  })
})

test("G3 zero targets cannot conceal an unresolved live producer requirement", async () => {
  await guardFixture(async g => {
    await withOwnedRuntimeUnit(async (runtime, state) => {
      const outcome = await runtime.start({ category: "qa", prompt: "no unresolved producer" })
      expect(outcome.kind).toBe("start_failed"); expect(state.calls).not.toContain("create")
    }, { childToolGuard: g.owner, authorizePlannedStart: async (spec, plan) => {
      const value = approved(spec, plan)
      return { ...value, selection: { ...value.selection, selected: [], requirements: ["kernel-live-bindings"], bindingSlots: [{ requirement: "kernel-live-bindings", nativeName: "actual-kernel" }], allowsCodeModeTransport: false } }
    }, childGuardBinding: (_spec, prepared) => ({ assertCurrent() {}, bind(child, assertCurrent) { return { child, agent: prepared.buildAgentID, assertCurrent } } }) })
  })
})

/** A parent kernel-tool grant as senpi-task resolves it from an eval cell's capability; the runner never invokes it. */
function kernelStart() {
  const capability = { capabilities: { invokeScope: true }, describe: async () => ({ results: [] }), invoke: async () => 42 }
  return { category: "qa", prompt: "kernel child", kernelTools: { capability, requestedNames: ["double"],
    descriptors: [{ name: "double", description: "Doubles n", input_schema: { type: "object" }, language: "js" as const, kernel_generation: 1, definition_revision: 1 }] } }
}
const kernelCoverage = { boundRequirements: ["codemode-network-guard" as const, "kernel-live-bindings" as const],
  targets: [{ requirement: "kernel-live-bindings" as const, nativeName: "double", hostID: "omo_kernel_tool" }] }

test("G3 a kernel tool grant is refused before create when the binding lacks a live kernel binding", async () => {
  await guardFixture(async g => {
    await withOwnedRuntimeUnit(async (runtime, state) => {
      // when
      const outcome = await runtime.start(kernelStart())
      // then
      expect(outcome.kind).toBe("start_failed"); expect(state.calls).not.toContain("create")
    }, guardedOptions(g))
  })
})

test("G3 a kernel tool grant starts when the binding covers its live kernel binding and exposes the dispatcher to the child", async () => {
  await guardFixture(async g => {
    await withOwnedRuntimeUnit(async (runtime, state) => {
      // when
      const started = await runtime.start(kernelStart())
      // then
      if (started.kind !== "started") throw Error(JSON.stringify(started))
      try {
        await runtime.wait(started.task_id)
        expect(state.calls).toContain("create")
        expect(Object.keys((state.contexts[0] as { tools: Record<string, unknown> }).tools).sort()).toEqual(["execute", "omo_kernel_tool", "opaque-read"])
      } finally { await runtime.end(started.task_id) }
    }, { childToolGuard: g.owner, authorizePlannedStart: async (spec, plan) => approved(spec, plan),
      childGuardBinding: (_spec, prepared) => ({ coverage: kernelCoverage, assertCurrent() {}, bind(child, assertCurrent) { return { child, agent: prepared.buildAgentID, coverage: kernelCoverage, assertCurrent } } }) },
    ["opaque-read", "opaque-edit", "execute", "omo_kernel_tool"])
  })
})

const MEMBER_TEAM = { runId: "11111111-1111-4111-8111-111111111111", memberName: "alpha" }
/** The member's ORIGINAL definition as data only; the guarded runner never invokes it. */
function memberStart() {
  const config = { enabled: true, tmux_visualization: false, max_parallel_members: 4, max_members: 8, max_messages_per_run: 10000, max_wall_clock_minutes: 120,
    max_member_turns: 500, message_payload_max_bytes: 32768, recipient_unread_max_bytes: 262144, mailbox_poll_interval_ms: 3000 }
  return { category: "qa", prompt: "in-process member", execution_mode: "in-process" as const, team_run_id: MEMBER_TEAM.runId, team_name: "unit-team",
    team_member_name: MEMBER_TEAM.memberName, team_role: "member" as const,
    memberScopedTools: [createMemberTaskSendTool({ teamRunId: MEMBER_TEAM.runId, memberName: MEMBER_TEAM.memberName, taskId: "team-member", config, members: ["alpha"] })] }
}

test("G3 member-scoped tools are refused before create when the binding lacks member live bindings", async () => {
  await guardFixture(async g => {
    await withOwnedRuntimeUnit(async (runtime, state) => {
      // when
      const outcome = await runtime.start(memberStart())
      // then
      expect(outcome.kind).toBe("start_failed"); expect(state.calls).not.toContain("create")
    }, { childToolGuard: g.owner, authorizePlannedStart: async (spec, plan) => approved(spec, plan),
      childGuardBinding: (_spec, prepared) => ({ coverage, assertCurrent() {}, bind(child, assertCurrent) { return { child, agent: prepared.buildAgentID, coverage, assertCurrent } } }) })
  })
})

test("G3 member-scoped tools start when the binding covers member live bindings and receives the approved team identity", async () => {
  await guardFixture(async g => {
    const origins: unknown[] = []
    const memberCoverage = { boundRequirements: ["codemode-network-guard" as const, "member-live-bindings" as const],
      targets: [{ requirement: "member-live-bindings" as const, nativeName: "task_send", hostID: "omo_team_send" }] }
    await withOwnedRuntimeUnit(async (runtime, state) => {
      // when
      const started = await runtime.start(memberStart())
      // then
      if (started.kind !== "started") throw Error(JSON.stringify(started))
      try {
        await runtime.wait(started.task_id)
        expect(state.calls).toContain("create")
        expect(origins).toEqual([{ team: MEMBER_TEAM }])
        expect(Object.keys((state.contexts[0] as { tools: Record<string, unknown> }).tools).sort()).toEqual(["execute", "omo_team_send", "opaque-read"])
      } finally { await runtime.end(started.task_id) }
    }, { childToolGuard: g.owner, authorizePlannedStart: async (spec, plan) => approved(spec, plan),
      childGuardBinding: (_spec, prepared, origin) => { origins.push(origin); return { coverage: memberCoverage, assertCurrent() {}, bind(child, assertCurrent) { return { child, agent: prepared.buildAgentID, coverage: memberCoverage, assertCurrent } } } } },
    ["opaque-read", "opaque-edit", "execute", "omo_team_send"])
  })
})

type ParkedInfo = { permissions?: unknown[]; metadata?: Record<string, unknown> }
const userRule = { action: "read", resource: "*", effect: "allow" as const }
const guardedOptions = (g: { owner: OwnedChildToolGuard }, producers?: () => { revoke(): void; join(): Promise<void> }): Parameters<typeof withOwnedRuntimeUnit>[1] => ({
  childToolGuard: g.owner, authorizePlannedStart: async (spec, plan) => approved(spec, plan),
  childGuardBinding: (_spec, prepared) => ({ coverage, assertCurrent() {}, bind(child, assertCurrent) { return { child, agent: prepared.buildAgentID, coverage, assertCurrent, ...(producers ? { producers: producers() } : {}) } } }),
})
async function completedGuarded(runtime: Parameters<Parameters<typeof withOwnedRuntimeUnit>[0]>[0], prompt: string) {
  const started = await runtime.start({ category: "qa", prompt }); if (started.kind !== "started") throw Error(JSON.stringify(started))
  await runtime.wait(started.task_id); return { id: started.task_id, child: defined(defined(runtime.get(started.task_id)).child_session_id) }
}

test("G3 close with a retained completed guarded child parks it host-denied and completes without removal", async () => {
  await guardFixture(async g => {
    await withOwnedRuntimeUnit(async (runtime, state) => {
      // given a completed guarded child whose own session carries a user rule and metadata
      const { child } = await completedGuarded(runtime, "parked guarded child")
      state.changeSession(child, { permissions: [userRule], metadata: { "user.note": "keep" } })
      // when the runtime closes (plugin unload/reload)
      await runtime.close()
      // then the child is suspended, not ended: one own-session write appends the wildcard deny last
      expect(state.calls).not.toContain("remove"); expect(state.calls.filter(call => call === "park-update")).toHaveLength(1)
      const info = state.session(child) as ParkedInfo
      expect(info.permissions).toEqual([userRule, PARKED_DENY_RULE])
      expect(info.metadata?.["user.note"]).toBe("keep"); expect(info.metadata?.[PARKING_MARKER_KEY]).toMatchObject({ format: 1 })
      // and the guard keeps the owned ID denied while its own close (host unload) now completes
      expect(Exit.isFailure(await g.leaf(child, "verified-unit-build"))).toBe(true); expect(g.targetCalls()).toBe(0)
      await Effect.runPromise(g.owner.close())
    }, guardedOptions(g))
  })
})

test("G3 observed conflicting child rules retain custody with an explicit error; explicit END still cleans up", async () => {
  await guardFixture(async g => {
    await withOwnedRuntimeUnit(async (runtime, state) => {
      const { id, child } = await completedGuarded(runtime, "conflicting guarded child")
      state.changeSession(child, { permissions: [userRule], metadata: { [PARKING_MARKER_KEY]: { foreign: true } } })
      await expect(runtime.close()).rejects.toThrow("Native owned task cleanup incomplete")
      expect(state.calls).not.toContain("park-update"); expect((state.session(child) as ParkedInfo).permissions).toEqual([userRule])
      expect(Exit.isFailure(await Effect.runPromiseExit(g.owner.close()))).toBe(true)
      expect(Exit.isFailure(await g.leaf(child, "verified-unit-build"))).toBe(true)
      await runtime.end(id); await runtime.close()
      expect(state.calls.filter(call => call === "remove")).toHaveLength(1)
      await Effect.runPromise(g.owner.close())
    }, guardedOptions(g))
  })
})

test("G3 failed original producer join keeps custody without host mutation; close retry parks once", async () => {
  let fail = true
  await guardFixture(async g => {
    await withOwnedRuntimeUnit(async (runtime, state) => {
      const { child } = await completedGuarded(runtime, "held producer child")
      await expect(runtime.close()).rejects.toThrow("Native owned task cleanup incomplete")
      expect(state.calls).not.toContain("park-update"); expect((state.session(child) as ParkedInfo).permissions).toBeUndefined()
      expect(Exit.isFailure(await g.leaf(child, "verified-unit-build"))).toBe(true)
      fail = false
      await runtime.close()
      expect((state.session(child) as ParkedInfo).permissions).toEqual([PARKED_DENY_RULE]); expect(state.calls).not.toContain("remove")
      await Effect.runPromise(g.owner.close())
    }, guardedOptions(g, () => ({ revoke() {}, async join() { if (fail) throw Error("original producer finalizer failed") } })))
  })
})

test("G3 failed permission write keeps custody and an idempotent close retry writes exactly once", async () => {
  await guardFixture(async g => {
    await withOwnedRuntimeUnit(async (runtime, state) => {
      const { child } = await completedGuarded(runtime, "failed park write child"); let fail = true
      state.onUpdate(input => { if (input.permissions && fail) { fail = false; throw Error("controlled permission write failure") } })
      await expect(runtime.close()).rejects.toThrow("Native owned task cleanup incomplete")
      expect((state.session(child) as ParkedInfo).permissions).toBeUndefined()
      await runtime.close()
      expect(state.calls.filter(call => call === "park-update")).toHaveLength(1); expect(state.calls).not.toContain("remove")
      expect((state.session(child) as ParkedInfo).permissions).toEqual([PARKED_DENY_RULE])
      await Effect.runPromise(g.owner.close())
    }, guardedOptions(g))
  })
})

test("G3 pure model binding failure creates no guard claim or SDK child before healthy retry", async () => {
  await guardFixture(async g => {
    let attempts = 0, reservations = 0
    const begin = g.owner.beginStage.bind(g.owner)
    g.owner.beginStage = (...args) => { reservations++; return begin(...args) }
    await withOwnedRuntimeUnit(async (runtime, state) => {
      const failed = await runtime.start({ category: "qa", prompt: "invalid pure model binding" })
      expect(failed.kind).toBe("start_failed"); expect(reservations).toBe(0); expect(state.calls).not.toContain("create")
      const next = await runtime.start({ category: "qa", prompt: "healthy model binding" }); if (next.kind !== "started") throw Error(JSON.stringify(next))
      try { await runtime.wait(next.task_id); expect(reservations).toBe(1); expect(state.calls.filter(call => call === "create")).toHaveLength(1) }
      finally { await runtime.end(next.task_id) }
    }, { childToolGuard: g.owner, authorizePlannedStart: async (spec, plan) => approved(spec, plan),
      childGuardBinding: (spec, prepared) => {
        if (++attempts === 1) {
          // Controlled failure at the REAL planner.binding boundary. No fake
          // SDK model/api: the fixture's actual catalog lacks this requested ID.
          const request = spec as { model?: string; resolvedModel?: typeof spec.resolvedModel }
          request.model = "unit/absent-model"; request.resolvedModel = undefined
        }
        return { coverage, assertCurrent() {}, bind(child, assertCurrent) { return { child, agent: prepared.buildAgentID, coverage, assertCurrent } } }
      },
    })
  })
})

test("G3 queued drain uses original approved admission without capturing a new caller", async () => {
  await guardFixture(async g => {
    let captureCount = 0, approvalCount = 0, bindCount = 0, initiatingFrameOpen = true
    const stop = new AbortController()
    await withOwnedRuntimeUnit(async (runtime, state) => {
      const first = await runtime.start({ category: "qa", prompt: "block-until-interrupt" }); if (first.kind !== "started") throw Error(JSON.stringify(first))
      const queued = await runtime.start({ category: "qa", prompt: "queued guarded work" }); if (queued.kind !== "started") throw Error(JSON.stringify(queued))
      try {
        expect(queued.status).toBe("pending"); expect(captureCount).toBe(2); expect(approvalCount).toBe(2); expect(bindCount).toBe(1)
        initiatingFrameOpen = false
        await runtime.end(first.task_id)
        await runtime.wait(queued.task_id, AbortSignal.timeout(3000))
        expect(captureCount).toBe(2); expect(approvalCount).toBe(2); expect(bindCount).toBe(2)
        expect(state.createdAgents).toEqual(["verified-unit-build", "verified-unit-build"])
      } finally { await runtime.end(first.task_id); await runtime.end(queued.task_id) }
    }, { childToolGuard: g.owner, config: () => ({ categories: { qa: { model: "qa/model" } }, task: OmoTaskSettingsSchema.parse({ default_concurrency: 1, max_depth: 2 }) }),
      captureStartAuthority: () => { if (!initiatingFrameOpen) throw Error("Queued drain tried to capture another caller"); captureCount++; return { admissionSignal: stop.signal, lifetimeSignal: stop.signal, assertAdmission() { stop.signal.throwIfAborted() }, assertLifetime() { stop.signal.throwIfAborted() } } },
      authorizePlannedStart: async (spec, plan) => { approvalCount++; return approved(spec, plan) },
      childGuardBinding: (_spec, prepared) => ({ coverage, assertCurrent() {}, bind(child, assertCurrent) { bindCount++; return { child, agent: prepared.buildAgentID, coverage, assertCurrent } } }),
    })
  })
})

// Phase R: fresh-action recovery/restore of a PARKED guarded child after a reload.
const recoveryCatalog = [{ id: "opaque-read", name: "read", options: { codemode: true } }, { id: "opaque-edit", name: "edit" }]
const recoveryApproved = (spec: ManagedStartSpec) => ({ buildAgentID: "verified-unit-build", authorityIssued: false as const,
  selection: prepareRecoveryHostGrant({ spec, nativeTools: [{ name: "read" }], includeTaskTools: true, catalog: recoveryCatalog, canonical: { filterSharedParentTools } }) })
type UnitRuntime = Parameters<Parameters<typeof withOwnedRuntimeUnit>[0]>[0]
/** The genuine operation-owner send path a public task_send uses for a stored record. */
async function ownerSend(runtime: UnitRuntime, id: string, message: string) {
  const stop = new AbortController()
  const owner = runtime.operationOwner(runtime.rootParent, { source: { sessionID: "parent" as ToolContext["sessionID"], agent: "build" as ToolContext["agent"], messageID: "unit-send-message" as ToolContext["messageID"], id: "unit-send-call" as ToolContext["id"] },
    acceptedSignal: stop.signal, reportingSignal: stop.signal, assertAction() {}, assertLifetime() {} })
  try { return await owner.send.sendToTask({ idOrName: id, message, deliverAs: "followUp", callerSessionId: "parent" }) }
  finally { owner.closeReporting(); await owner.joinReporting() }
}
const prompts = (calls: string[]) => calls.filter(call => call === "prompt").length

test("G3R reloaded send revives a parked child via fresh approval, restores its exact rules and keeps the SDK child", async () => {
  await guardFixture(async before => { await guardFixture(async after => {
    let approvals = 0
    await withOwnedRuntimeUnit(async (runtime, state) => {
      // given a completed guarded child parked by a reload, with a user rule and unrelated metadata
      const { id, child } = await completedGuarded(runtime, "revivable guarded child")
      state.changeSession(child, { permissions: [userRule], metadata: { "user.note": "keep" } })
      const reloaded = await state.reopen({ childToolGuard: after.owner, authorizeRecovery: async spec => { approvals++; return recoveryApproved(spec) } })
      // until restore only the durable host deny fences it (a fresh guard has no record of this ID)
      expect((state.session(child) as ParkedInfo).permissions).toEqual([userRule, PARKED_DENY_RULE])
      const sentPrompts = prompts(state.calls)
      // when the parent sends to it through the current call
      const sent = await ownerSend(reloaded, id, "continue after reload")
      // then Native revives the SAME child under one fresh approval with the exact original rules restored
      expect(sent.kind).toBe("revived"); expect(approvals).toBe(1)
      const info = state.session(child) as ParkedInfo
      expect(info.permissions).toEqual([userRule]); expect(info.metadata?.["user.note"]).toBe("keep")
      expect(info.metadata && Object.hasOwn(info.metadata, PARKING_MARKER_KEY)).toBe(false)
      expect(state.calls.filter(call => call === "create")).toHaveLength(1); expect(prompts(state.calls)).toBe(sentPrompts + 1)
      // and the new guard generation executes while the next close parks again
      expect(Exit.isSuccess(await after.leaf(child, "verified-unit-build"))).toBe(true)
      await reloaded.close()
      expect((state.session(child) as ParkedInfo).permissions).toEqual([userRule, PARKED_DENY_RULE])
    }, guardedOptions(before))
  }) })
})

test("G3R user rules changed while parked refuse revival explicitly without overwrite; explicit END cleans up", async () => {
  await guardFixture(async before => { await guardFixture(async after => {
    await withOwnedRuntimeUnit(async (runtime, state) => {
      const { id, child } = await completedGuarded(runtime, "conflicting parked child")
      const reloaded = await state.reopen({ childToolGuard: after.owner, authorizeRecovery: async spec => recoveryApproved(spec) })
      state.changeSession(child, { permissions: [userRule] })
      const sentPrompts = prompts(state.calls)
      await expect(ownerSend(reloaded, id, "must not run")).rejects.toThrow()
      expect((state.session(child) as ParkedInfo).permissions).toEqual([userRule]); expect(prompts(state.calls)).toBe(sentPrompts)
      await expect(ownerSend(reloaded, id, "still refused")).rejects.toThrow("permission conflict")
      expect(Exit.isFailure(await after.leaf(child, "verified-unit-build"))).toBe(true); expect(after.targetCalls()).toBe(0)
      await reloaded.end(id); await reloaded.close()
      expect(state.calls.filter(call => call === "remove")).toHaveLength(1)
    }, guardedOptions(before))
  }) })
})

test("G3R same-guard renewal denies a lazy call of the parked generation while the fresh generation executes", async () => {
  await guardFixture(async g => {
    await withOwnedRuntimeUnit(async (runtime, state) => {
      const { id, child } = await completedGuarded(runtime, "renewed guarded child")
      const stale = g.lazy(child, "verified-unit-build")
      const reloaded = await state.reopen({ authorizeRecovery: async spec => recoveryApproved(spec) })
      expect((await ownerSend(reloaded, id, "renewed generation")).kind).toBe("revived")
      expect(Exit.isFailure(await Effect.runPromiseExit(stale))).toBe(true)
      expect(Exit.isSuccess(await g.leaf(child, "verified-unit-build"))).toBe(true); expect(g.targetCalls()).toBe(1)
    }, guardedOptions(g))
  })
})

test("G3R without a fresh current-call authorization the parked child stays denied and admits no input", async () => {
  await guardFixture(async before => { await guardFixture(async after => {
    await withOwnedRuntimeUnit(async (runtime, state) => {
      const { id, child } = await completedGuarded(runtime, "unauthorized parked child")
      const reloaded = await state.reopen({ childToolGuard: after.owner })
      const sentPrompts = prompts(state.calls)
      await expect(ownerSend(reloaded, id, "no approval")).rejects.toThrow("fresh current-call authorization")
      expect((state.session(child) as ParkedInfo).permissions).toEqual([PARKED_DENY_RULE]); expect(prompts(state.calls)).toBe(sentPrompts)
    }, guardedOptions(before))
  }) })
})
function defined<T>(value: T | null | undefined): T { if (value === undefined || value === null) throw new Error("expected a defined value"); return value }
