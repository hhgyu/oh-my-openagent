import { expect, test } from "bun:test"
import { Effect, Exit, Schema, Scope } from "effect"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { filterSharedParentTools } from "../../../../../senpi-task/src/runners/in-process/shared-tool-filter"
import { BUILTIN_AGENTS, CURATED_READONLY_AGENT_NAMES } from "@oh-my-opencode/senpi-task/agents-builtin"
import { prepareHostTaskGrant, prepareRecoveryHostGrant, checkHostGrantTarget, createHostBuildAuthorizer, type HostGrantPreparationInput, type HostGrantRecoveryInput } from "./host-grant"
import { acquireEffectPermissionApi } from "../../host/effect-permission-api"
import { createToolKernel } from "../../host/tool-kernel"
import { createToolRegistry } from "../../host/tool-registry"
import { createSessionScopes } from "../../host/session-state"
import { createPolicyPipeline } from "../../host/policy-pipeline"
import { createAcceptedOperationRegistry } from "./accepted-operation"

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
function selection(extra: Partial<HostGrantPreparationInput> = {}): HostGrantPreparationInput {
  return { spec: { prompt: "unit", parent_session_id: "ses_grant_unit", depth: 1 }, plan: { model: "unit/model" }, includeTaskTools: true,
    nativeTools: ["read", "edit", "write", "bash", "find", "task", "task_output", "team_status", "workflow"].map(name => ({ name })),
    catalog: ["read", "edit", "write", "shell", "glob", "task", "task_output", "team_status", "workflow", "subagent"].map(name => ({ id: name, name, options: { codemode: false as const } })),
    canonical: { filterSharedParentTools }, ...extra }
}

test("SAME canonical family filter and actual catalog counterparts, not all host availability", () => {
  const input = selection(), result = prepareHostTaskGrant(input)
  expect(result.selected.map(pair => pair.hostID)).toEqual(["read", "edit", "write", "shell", "glob", "task", "task_output"])
  expect(result.selected.some(pair => ["subagent", "team_status", "workflow"].includes(pair.hostID))).toBe(false)
  expect(checkHostGrantTarget(result, "read")).toBe("selected")
  expect(checkHostGrantTarget(result, "subagent")).toBe("denied")
  const withoutTask = prepareHostTaskGrant({ ...input, includeTaskTools: false })
  expect(withoutTask.selected.map(pair => pair.hostID)).not.toContain("task")
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.selected)).toBe(true)
  expect(Object.isFrozen(input.catalog)).toBe(false)
})

test("absent allowlist, explicit EMPTY and deny-only remain distinct", () => {
  expect(prepareHostTaskGrant(selection()).selected.length).toBeGreaterThan(0)
  expect(prepareHostTaskGrant(selection({ plan: { model: "x", toolAllowlist: [] } })).selected).toEqual([])
  const denied = prepareHostTaskGrant(selection({ plan: { model: "x", toolAllowlist: ["read", "bash"], toolDenylist: ["bash"] } }))
  expect(denied.selected).toEqual([{ nativeName: "read", hostID: "read" }]); expect(denied.deniedHostIDs).toEqual(["shell"])
})

test("aliases collapse with deny winning, exact custom namespace and no ls-to-read widening", () => {
  const input = selection({ nativeTools: ["webfetch", "web_fetch", "ls", "custom"].map(name => ({ name })),
    catalog: [{ id: "webfetch", name: "webfetch", options: { codemode: false } }, { id: "ns.lookup", name: "lookup", options: { namespace: "ns", codemode: false } }, { id: "read", name: "read" }],
    customCounterparts: [{ nativeName: "custom", hostID: "ns.lookup" }], plan: { model: "x", toolDenylist: ["web_fetch"] } })
  const result = prepareHostTaskGrant(input)
  expect(result.selected).toEqual([{ nativeName: "custom", hostID: "ns.lookup" }])
  expect(result.unavailableNativeNames).toEqual(["ls"])
  expect(() => prepareHostTaskGrant({ ...input, customCounterparts: [{ nativeName: "webfetch", hostID: "ns.lookup" }] })).toThrow("overriding")
  expect(() => prepareHostTaskGrant({ ...input, catalog: [...input.catalog, defined(input.catalog[0])] })).toThrow("Ambiguous")
})

test("curated floor uses actual builtin metadata and asks for original broker, never ordinary shell", () => {
  for (const name of CURATED_READONLY_AGENT_NAMES) {
    const realFloor = defined(defined(BUILTIN_AGENTS[name]).tools).filter(rule => rule.allow).map(rule => rule.pattern)
    const result = prepareHostTaskGrant(selection({ plan: { model: "x", agentType: name, toolAllowlist: [...realFloor, "write"] } }))
    expect(result.selected.some(pair => pair.nativeName === "write" || pair.hostID === "shell")).toBe(false)
    expect(result.requirements).toContain("curated-readonly-broker")
    expect(checkHostGrantTarget(result, "read")).toBe("requires-bindings")
    expect(prepareHostTaskGrant(selection({ plan: { model: "x", agentType: name, toolAllowlist: [] } })).requirements).toEqual([])
  }
})

test("live kernel/member/network are explicit unresolved dependencies, never data-granted or permanently denied", () => {
  const base = selection()
  const spec = { ...base.spec, kernelTools: {} as NonNullable<typeof base.spec.kernelTools>, memberScopedTools: [{ name: "member" }] as unknown as NonNullable<typeof base.spec.memberScopedTools> }
  const result = prepareHostTaskGrant({ ...base, spec, catalog: base.catalog.map(tool => ({ ...tool, options: { codemode: true } })) })
  expect(result.requirements).toEqual(["kernel-live-bindings", "member-live-bindings", "codemode-network-guard"])
  expect(checkHostGrantTarget(result, "read")).toBe("requires-bindings")
  expect(JSON.stringify(result)).not.toContain("describe")
  expect(result.modelCoverage).toBe("native-selection-with-unchanged-persona-and-tool-policy")
})

test("prototype-like custom names and namespaced stock lookalikes never misroute", () => {
  const input = selection({ nativeTools: [{ name: "constructor" }], catalog: [{ id: "ns.custom", name: "custom", options: { namespace: "ns", codemode: false } }], customCounterparts: [{ nativeName: "constructor", hostID: "ns.custom" }] })
  expect(prepareHostTaskGrant(input).selected).toEqual([{ nativeName: "constructor", hostID: "ns.custom" }])
  expect(prepareHostTaskGrant(selection({ catalog: [{ id: "shell", name: "shell", options: { namespace: "foreign" } }] })).selected).toEqual([])
})

test("stock resolves UNIQUE effective name and preserves opaque actual ID, never get-by-name", () => {
  const base = selection(), catalog = base.catalog.map(tool => ({ ...tool, id: `opaque:${tool.name}` }))
  const result = prepareHostTaskGrant({ ...base, catalog })
  expect(result.selected.find(pair => pair.nativeName === "read")?.hostID).toBe("opaque:read")
  expect(result.selected.find(pair => pair.nativeName === "bash")?.hostID).toBe("opaque:shell")
  expect(checkHostGrantTarget(result, "read")).toBe("denied")
  expect(checkHostGrantTarget(result, "opaque:read")).toBe("selected")
  expect(() => prepareHostTaskGrant({ ...base, catalog: [...catalog, { id: "different-opaque", name: "read", options: { codemode: false } }] })).toThrow("effective tool name")
})

test("pure later binding coverage resolves required slots without clearing requirements or claiming authority", () => {
  const result = prepareHostTaskGrant(selection({ plan: { model: "x", agentType: "explore" } }))
  const coverage = { boundRequirements: ["curated-readonly-broker" as const], targets: [{ requirement: "curated-readonly-broker" as const, nativeName: "bash", hostID: "actual-bound-broker-ID" }] }
  expect(checkHostGrantTarget(result, "actual-bound-broker-ID")).toBe("requires-bindings")
  expect(checkHostGrantTarget(result, "read", { boundRequirements: ["curated-readonly-broker"] })).toBe("requires-bindings")
  // Only a pure DATA decision: the future wrapper must independently validate
  // actual broker producer/child custody before accepting this coverage.
  expect(checkHostGrantTarget(result, "actual-bound-broker-ID", coverage)).toBe("selected")
  expect(checkHostGrantTarget(result, "unplanned", { ...coverage, targets: [...coverage.targets, { ...defined(coverage.targets[0]), nativeName: "unplanned", hostID: "unplanned" }] })).toBe("denied")
  expect(result.requirements).toEqual(["curated-readonly-broker"])
  expect(result.selected.some(pair => pair.hostID === "shell")).toBe(false)
})

/** Controlled UNIT SDK domain/roster/caller, but actual kernel issuance,
 * genuine joined API/Effect fibers and original operation registry. No actual host proof. */
async function authorization(work: () => Effect.Effect<void, unknown, Scope.Scope> = () => Effect.void) {
  const scope = Scope.makeUnsafe(), scopes = createSessionScopes(), controller = new AbortController(), requests: unknown[] = []
  let current = true, rosters = 0
  const permission = await Effect.runPromise(Effect.provideService(acquireEffectPermissionApi({ assert: request => {
    requests.push(request); return Effect.scoped(work()) as Effect.Effect<void, ToolError>
  } }), Scope.Scope, scope))
  const context = { sessionID: "ses_grant_unit", agent: "actual-unit-parent", messageID: "unit-message", id: "unit-call", signal: controller.signal, progress: async () => {} } as unknown as ToolContext
  const lease = scopes.open(context.sessionID, { tools: ["entry"], authorize() {} })
  let run: (caller: ToolContext) => Promise<unknown> = async () => ({})
  const registry = createToolRegistry([{ id: "entry", name: "entry", input: Schema.Unknown, description: "unit entry", execute: async (_value, caller) => { await run(caller); return {} } }], { entry: () => [{ action: "unit-entry", resources: ["unit"] }] })
  const kernel = createToolKernel({ scopes, registry, pipeline: createPolicyPipeline(), permission: { assert: async () => {} } })
  const agents = { async list() { rosters++; return { data: [{ id: "build" }] } } } as unknown as Parameters<typeof createHostBuildAuthorizer>[0]["agents"]
  const authorizer = createHostBuildAuthorizer({ callAuthority: kernel.callAuthority, permission, agents, assertCurrent() { if (!current) throw Error("catalog retired") } })
  const bound = kernel.bind(context, lease)
  return { permission, authorizer, requests, controller, context, bound, kernel,
    setRun(value: typeof run) { run = value }, retire() { current = false }, rosters: () => rosters,
    async close() { bound.dispose(); await permission.close(); scopes.dispose(); await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))) },
  }
}

test("genuine issued frame selects actual build resource/source per SAME plan and reports DATA only", async () => {
  const f = await authorization(); let result: Awaited<ReturnType<ReturnType<typeof f.authorizer.forCall>["authorize"]>> | undefined
  const original = selection()
  f.setRun(async caller => { result = await f.authorizer.forCall(caller).authorize(original, caller.signal) })
  await f.bound.invoke("entry", {})
  expect(f.rosters()).toBe(1)
  expect(f.requests).toEqual([{ sessionID: "ses_grant_unit", agent: "actual-unit-parent", action: "subagent", resources: ["build"], source: { type: "tool", messageID: "unit-message", id: "unit-call" } }])
  expect(result?.buildAgentID).toBe("build"); expect(result?.authorityIssued).toBe(false)
  expect(original.plan.model).toBe("unit/model"); await f.close()
})

test("category/batch-like separate plans each authorize actual build, no raw category resources or model pin claim", async () => {
  const f = await authorization()
  f.setRun(async caller => {
    const call = f.authorizer.forCall(caller)
    for (const category of ["first", "second"]) await call.authorize(selection({ spec: { prompt: "x", parent_session_id: caller.sessionID, depth: 1, category }, plan: { model: `provider/${category}` } }), caller.signal)
  })
  await f.bound.invoke("entry", {}); expect(f.requests).toHaveLength(2)
  expect(f.requests.every((request: unknown) => typeof request === "object" && request !== null && "resources" in request && Array.isArray(request.resources) && request.resources[0] === "build")).toBe(true)
  await f.close()
})

test("retained closure, fake joined owner and foreign parent cannot authorize", async () => {
  const f = await authorization(); let call: ReturnType<typeof f.authorizer.forCall> | undefined
  f.setRun(async caller => { call = f.authorizer.forCall(caller); await expect(call.authorize(selection({ spec: { prompt: "x", parent_session_id: "ses_foreign", depth: 1 } }), caller.signal)).rejects.toThrow("foreign") })
  await f.bound.invoke("entry", {})
  await expect(defined(call).authorize(selection(), new AbortController().signal)).rejects.toThrow("authorized")
  expect(f.requests).toEqual([])
  expect(() => createHostBuildAuthorizer({ callAuthority: f.kernel.callAuthority, permission: { ...f.permission }, agents: {} as never, assertCurrent() {} })).toThrow("genuine")
  await f.close()
})

for (const [index, failure] of [undefined, null, false, 0, new ToolError({ message: "actual unit deny" })].entries()) test(`target-phase original method keeps distinct joined error ${index}`, async () => {
  const entered = deferred<void>(), cleaning = deferred<void>(), finish = deferred<void>()
  const f = await authorization(() => Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.promise(async () => { cleaning.resolve(); await finish.promise }).pipe(Effect.andThen(Effect.die(failure))))
    entered.resolve(); yield* Effect.never
  }))
  const owned = createAcceptedOperationRegistry(); let original: Promise<unknown> | undefined, settled = false
  f.setRun(async caller => {
    original = f.authorizer.forCall(caller).authorize(selection(), caller.signal)
    void original.then(() => { settled = true }, () => { settled = true })
    return owned.track(original)
  })
  const outer = f.bound.invoke("entry", {}).catch(error => error)
  try {
    await entered.promise; f.controller.abort(Error("outer caller aborted")); await cleaning.promise
    await outer // Existing target race is honestly separate from original method custody.
    expect(settled).toBe(false)
    let ownerJoined = false; const joining = owned.join().then(() => { ownerJoined = true })
    await new Promise<void>(resolve => setImmediate(resolve)); expect(ownerJoined).toBe(false)
    finish.resolve(); await expect(defined(original)).rejects.toBe(failure); await joining
    expect(settled).toBe(true)
  } finally { finish.resolve(); await outer; await original?.catch(() => {}); await owned.join(); await f.close() }
})

test("catalog retirement after real approval rejects and same policy can cover model spill without pinning it", async () => {
  let release!: () => void, entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const f = await authorization(() => Effect.promise(async () => { entered(); await gate }))
  f.setRun(caller => f.authorizer.forCall(caller).authorize(selection(), caller.signal))
  const pending = f.bound.invoke("entry", {})
  await ready; f.retire(); release(); await expect(pending).rejects.toThrow("catalog retired"); await f.close()
})

test("persona/policy mutation during approval rejects even when selected leaves happen to match", async () => {
  const entered = deferred<void>(), finish = deferred<void>(), plan = { model: "unit/model", agentType: "first", instructions: "first persona" }
  const f = await authorization(() => Effect.promise(async () => { entered.resolve(); await finish.promise }))
  f.setRun(caller => f.authorizer.forCall(caller).authorize(selection({ plan }), caller.signal))
  const original = f.bound.invoke("entry", {})
  try { await entered.promise; plan.instructions = "different persona"; finish.resolve(); await expect(original).rejects.toThrow("changed during approval") }
  finally { finish.resolve(); await original.catch(() => {}); await f.close() }
})

test("model change alone is not falsely treated as pinned model authority", async () => {
  const entered = deferred<void>(), finish = deferred<void>(), plan = { model: "unit/first", agentType: "worker" }
  const f = await authorization(() => Effect.promise(async () => { entered.resolve(); await finish.promise }))
  let prepared: Awaited<ReturnType<ReturnType<typeof f.authorizer.forCall>["authorize"]>> | undefined
  f.setRun(async caller => { prepared = await f.authorizer.forCall(caller).authorize(selection({ plan }), caller.signal) })
  const original = f.bound.invoke("entry", {})
  try {
    await entered.promise; plan.model = "unit/spill"; finish.resolve(); await original
    expect(defined(prepared).selection.modelCoverage).toBe("native-selection-with-unchanged-persona-and-tool-policy")
    expect(defined(prepared).authorityIssued).toBe(false)
  } finally { finish.resolve(); await original.catch(() => {}); await f.close() }
})

test("original operation signal cancels joined approval without poisoning raw caller", async () => {
  const entered = deferred<void>(), cleaning = deferred<void>(), finish = deferred<void>(), operation = new AbortController()
  const f = await authorization(() => Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.promise(async () => { cleaning.resolve(); await finish.promise }))
    entered.resolve(); yield* Effect.never
  }))
  let settled = false
  f.setRun(caller => f.authorizer.forCall(caller).authorize(selection(), operation.signal))
  const outer = f.bound.invoke("entry", {}).then(() => { settled = true }, error => { settled = true; throw error })
  try {
    await entered.promise; operation.abort(false); await cleaning.promise
    expect(settled).toBe(false); expect(f.controller.signal.aborted).toBe(false)
    finish.resolve(); await expect(outer).rejects.toBe(false)
  } finally { finish.resolve(); await outer.catch(() => {}); await f.close() }
})

// Phase R: a recovery grant reuses the SAME pure selection over the rebuilt persisted spec.
function recovery(extra: Partial<HostGrantRecoveryInput["spec"]> = {}): HostGrantRecoveryInput {
  const { spec: _spec, plan: _plan, ...rest } = selection()
  return { ...rest, spec: { taskId: "st_unit", cwd: "/unit", stateDir: "/unit/state", prompt: "persisted", depth: 1, parentSessionId: "ses_grant_unit", rootSessionId: "ses_grant_unit", ...extra } }
}

test("recovery selection equals the planned selection for the same persisted persona and tool policy", () => {
  const policy = { agentType: "explore", toolAllowlist: ["read", "bash"], toolDenylist: ["edit"] }
  expect(prepareRecoveryHostGrant(recovery(policy))).toEqual(prepareHostTaskGrant(selection({ plan: { model: "x", ...policy } })))
  // persisted member tool NAMES stay unresolved live requirements, never a data grant
  const members = prepareRecoveryHostGrant(recovery({ memberScopedToolNames: ["member"] }))
  expect(members.requirements).toContain("member-live-bindings"); expect(checkHostGrantTarget(members, "read")).toBe("requires-bindings")
})

test("fresh recovery approval issues THIS call's real subagent request and refuses a foreign parent", async () => {
  const f = await authorization(); let result: Awaited<ReturnType<ReturnType<typeof f.authorizer.forCall>["authorizeRecovery"]>> | undefined
  f.setRun(async caller => {
    const call = f.authorizer.forCall(caller)
    await expect(call.authorizeRecovery(recovery({ parentSessionId: "ses_foreign" }), caller.signal)).rejects.toThrow("foreign")
    result = await call.authorizeRecovery(recovery(), caller.signal)
  })
  await f.bound.invoke("entry", {})
  expect(f.requests).toEqual([{ sessionID: "ses_grant_unit", agent: "actual-unit-parent", action: "subagent", resources: ["build"], source: { type: "tool", messageID: "unit-message", id: "unit-call" } }])
  expect(result?.buildAgentID).toBe("build"); expect(result?.selection).toEqual(prepareRecoveryHostGrant(recovery())); await f.close()
})
function defined<T>(value: T | null | undefined): T { if (value === undefined || value === null) throw new Error("expected a defined value"); return value }

test("the CodeMode ls counterpart is accepted as a custom grant and a stock name still cannot claim it", () => {
  // given the Native `ls` custom name and the dedicated codemode:true registration in the actual catalog
  const base = selection()
  const listing = { id: "omo_native_ls", name: "omo_native_ls", options: { codemode: true, permission: "omo_native_ls" } }
  const input = selection({ nativeTools: [...base.nativeTools, { name: "ls" }], catalog: [...base.catalog, listing],
    customCounterparts: [{ nativeName: "ls", hostID: "omo_native_ls" }], plan: { model: "x", agentType: "explore" } })
  // when
  const result = prepareHostTaskGrant(input)
  // then the explore floor selects it, CodeMode transport is required and only the network guard covers it
  expect(result.selected).toContainEqual({ nativeName: "ls", hostID: "omo_native_ls" })
  expect(result.allowsCodeModeTransport).toBe(true)
  expect(result.requirements).toEqual(["curated-readonly-broker", "codemode-network-guard"])
  expect(checkHostGrantTarget(result, "omo_native_ls", { boundRequirements: ["curated-readonly-broker"], targets: [{ requirement: "curated-readonly-broker", nativeName: "bash", hostID: "broker" }] })).toBe("requires-bindings")
  expect(checkHostGrantTarget(result, "omo_native_ls", { boundRequirements: ["curated-readonly-broker", "codemode-network-guard"], targets: [{ requirement: "curated-readonly-broker", nativeName: "bash", hostID: "broker" }] })).toBe("selected")
  expect(() => prepareHostTaskGrant({ ...input, customCounterparts: [{ nativeName: "read", hostID: "omo_native_ls" }] })).toThrow("overriding")
  expect(() => prepareHostTaskGrant({ ...input, customCounterparts: [{ nativeName: "find", hostID: "omo_native_ls" }] })).toThrow("overriding")
})
