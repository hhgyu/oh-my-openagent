import { afterEach, describe, expect, test } from "bun:test"
import { resolveKernelToolGrant, type KernelToolGrant } from "@oh-my-opencode/senpi-task"
import { filterSharedParentTools } from "@oh-my-opencode/senpi-task/task-operations"
import type { ManagedStartSpec } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { PermissionDomain } from "@opencode/plugin/effect/permission"
import type { ToolDomain, ToolEditor } from "@opencode/plugin/effect/tool"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { Effect, Exit, Scope } from "effect"
import { acquireOwnedChildToolGuard } from "../../host/owned-child-tool-guard"
import type { ChildHandle } from "../../host/session-backend"
import { KERNEL_TOOL_PERMISSION, KERNEL_TOOL_TOOL_NAME } from "../../tools/kernel-tool"
import { createNativeChildGuardBinding } from "./child-guard-binding"
import { childCatalog } from "./component"
import { prepareHostTaskGrant } from "./host-grant"
import { acquireKernelToolOwner, applyKernelToolSurface, createKernelCallLedger } from "./kernel-binding"

type Info = ReturnType<ToolEditor["list"]>[number]
type Context = Parameters<Info["execute"]>[1]

const CHILD = "ses_kernel_child", PARENT = "ses_parent", AGENT = "build"
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}
function failure(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) throw Error("Expected a failed tool call")
  const error = exit.cause.reasons.map(reason => reason._tag === "Fail" ? reason.error : undefined).find(value => value instanceof ToolError)
  if (!(error instanceof ToolError)) throw Error(`Expected a typed tool error, got ${String(exit.cause)}`)
  return error.message
}
function envelope(exit: Exit.Exit<{ readonly content?: unknown }, unknown>): unknown {
  if (!Exit.isSuccess(exit)) return JSON.parse(failure(exit))
  const content = exit.value.content
  if (!Array.isArray(content)) throw Error("Expected content parts")
  return JSON.parse(content.map(part => (part as { text?: string }).text ?? "").join(""))
}

/** The parent kernel as the worker proxy exposes it: generation-fenced, so a reset makes old descriptors stale. */
function fakeGrant() {
  const calls: { request: { args: unknown }; options: Record<string, unknown> }[] = []
  let generation = 1
  const capability = {
    capabilities: { invokeScope: true },
    describe: async () => ({ results: [] }),
    invoke: async (request: { kernel_generation: number; args: unknown }, options?: unknown) => {
      calls.push({ request, options: options as Record<string, unknown> })
      if (request.kernel_generation !== generation) throw Object.assign(Error("kernel was reset"), { code: "kernel_tool_stale" })
      return (request.args as { n: number }).n * 2
    },
  }
  const grant: KernelToolGrant = {
    capability, requestedNames: ["double"], scope: { tools: { allow: ["read", "task"] } },
    descriptors: [{ name: "double", description: "Doubles n", input_schema: { type: "object" }, language: "js", kernel_generation: 1, definition_revision: 1 }],
  }
  return { grant, calls, reset: () => { generation++ } }
}

/** Controlled UNIT SDK-domain ports with the real kernel owner and owned-child guard, in component order. */
async function fixture() {
  const scope = Scope.makeUnsafe(), tools = new Map<string, Info>()
  const editor: ToolEditor = { list: () => [...tools.values()], get: id => tools.get(id), namespace() {}, remove: id => { tools.delete(id) },
    add: value => { tools.set(value.name, { ...value, id: value.name }) },
    update: (id, change) => { const value = tools.get(id); if (value) change(value) } }
  const tool: Pick<ToolDomain, "transform" | "list"> = {
    transform: callback => Effect.sync(() => { callback(editor); return { dispose: Effect.void } }),
    list: () => Effect.sync(() => [...tools.values()]),
  }
  const owner = await Effect.runPromise(Effect.provideService(acquireKernelToolOwner({ tool }), Scope.Scope, scope))
  const permission: Pick<PermissionDomain, "hook"> = { hook: () => Effect.succeed({ dispose: Effect.void }) }
  const guard = await Effect.runPromise(Effect.provideService(acquireOwnedChildToolGuard({ tool, permission }), Scope.Scope, scope))
  const stages: ReturnType<typeof guard.beginStage>[] = []
  cleanups.push(async () => {
    for (const stage of stages) { await Effect.runPromise(guard.join(stage)); guard.release(stage, () => {}) }
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
  })
  const context = (sessionID = CHILD): Context => ({ sessionID: sessionID as Context["sessionID"], agent: AGENT as Context["agent"],
    messageID: "unit-message" as Context["messageID"], id: "unit-call" as Context["id"], progress: () => Effect.void })
  /** Stage and bind one owned child exactly as the runner does, over the component's binder. */
  function stageChild(grant: KernelToolGrant | undefined, withOwner = true) {
    const selection = prepareHostTaskGrant({ spec: { prompt: "unit", parent_session_id: PARENT, depth: 1, ...(grant && { kernelTools: grant }) },
      plan: { model: "unit/model", agentType: "sisyphus-junior" }, includeTaskTools: true, nativeTools: [{ name: "read" }],
      catalog: childCatalog([...tools.values()]), canonical: { filterSharedParentTools } })
    const spec: ManagedStartSpec = { taskId: "st_00000001", cwd: "/project", stateDir: "/state", prompt: "unit", depth: 1, parentSessionId: PARENT,
      rootSessionId: PARENT, agentType: "sisyphus-junior", ...(grant && { kernelTools: grant }) }
    const binder = createNativeChildGuardBinding({ assertGeneration() {}, ...(withOwner && { kernel: owner }) })(spec, { buildAgentID: AGENT, selection })
    const stage = guard.beginStage(guard.approve({}, { selection, buildAgentID: AGENT, assertCurrent() {} }), CHILD, () => {})
    stages.push(stage)
    const binding = binder.bind({ locator: { sessionID: CHILD }, lease: {} } as unknown as ChildHandle, () => {})
    guard.bind(stage, binding)
    return { selection, coverage: binder.coverage, binding }
  }
  const run = (input: unknown, ctx = context()) => Effect.runPromiseExit(defined(tools.get(KERNEL_TOOL_TOOL_NAME)).execute(input, ctx))
  return { tools, owner, run, stageChild, context }
}

describe("#given the dedicated kernel tool registration", () => {
  test("#then it is a direct codemode:false SDK tool with its own permission, never a catalog grant", async () => {
    // given
    const f = await fixture()
    // when
    const info = defined(f.tools.get(KERNEL_TOOL_TOOL_NAME))
    // then
    expect(info.options).toEqual({ codemode: false, permission: KERNEL_TOOL_PERMISSION })
    expect(childCatalog([...f.tools.values()]).map(tool => tool.id)).not.toContain(f.owner.hostID)
  })

  test("#when a parent or unbound session calls it #then it is refused and hidden from its model context", async () => {
    // given
    const f = await fixture()
    const parent = { sessionID: PARENT, tools: { [f.owner.hostID]: {}, read: {} } as Record<string, unknown> }
    // when
    const exit = await f.run({ name: "double", args: { n: 21 } }, f.context(PARENT))
    applyKernelToolSurface(parent, f.owner)
    // then
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Object.keys(parent.tools)).toEqual(["read"])
  })
})

describe("#given an owned child granted the parent kernel tool double", () => {
  test("#when the child calls it #then the parent kernel answers 42 under the child's invoker identity and a scope without task", async () => {
    // given
    const f = await fixture(), kernel = fakeGrant()
    const { selection, coverage } = f.stageChild(kernel.grant)
    const child = { sessionID: CHILD, tools: { [f.owner.hostID]: {} } as Record<string, unknown> }
    // when
    const exit = await f.run({ name: "double", args: { n: 21 } })
    applyKernelToolSurface(child, f.owner)
    // then
    expect(selection.requirements).toContain("kernel-live-bindings")
    expect(coverage.targets).toEqual([{ requirement: "kernel-live-bindings", nativeName: "double", hostID: f.owner.hostID }])
    expect(envelope(exit)).toEqual({ kernel_tool: "double", value: 42 })
    expect(kernel.calls[0]?.options.invoker).toEqual({ sessionId: CHILD })
    expect(kernel.calls[0]?.options.scope).toEqual({ tools: { allow: ["read"], deny: ["task"] } })
    expect(kernel.calls[0]?.options.signal).toBeInstanceOf(AbortSignal)
    expect(Object.keys(child.tools)).toEqual([f.owner.hostID])
    expect((child.tools[f.owner.hostID] as { input?: unknown }).input).toBeDefined()
  })

  test("#when the parent kernel was reset #then the call fails with kernel_tool_stale", async () => {
    // given
    const f = await fixture(), kernel = fakeGrant()
    f.stageChild(kernel.grant)
    kernel.reset()
    // when
    const exit = await f.run({ name: "double", args: { n: 21 } })
    // then
    expect(envelope(exit)).toMatchObject({ kernel_tool: "double", error: { code: "kernel_tool_stale" } })
  })

  test("#when it asks for a tool it was not granted #then the call fails with kernel_tool_missing and never reaches the kernel", async () => {
    // given
    const f = await fixture(), kernel = fakeGrant()
    f.stageChild(kernel.grant)
    // when
    const exit = await f.run({ name: "triple", args: { n: 1 } })
    // then
    expect(envelope(exit)).toMatchObject({ kernel_tool: "triple", error: { code: "kernel_tool_missing" } })
    expect(kernel.calls).toEqual([])
  })

  test("#when its producer is revoked #then later calls are refused and hidden", async () => {
    // given
    const f = await fixture(), kernel = fakeGrant()
    const { binding } = f.stageChild(kernel.grant)
    const child = { sessionID: CHILD, tools: { [f.owner.hostID]: {} } as Record<string, unknown> }
    // when
    await defined(binding.producers).join()
    const exit = await f.run({ name: "double", args: { n: 21 } })
    applyKernelToolSurface(child, f.owner)
    // then
    expect(Exit.isFailure(exit)).toBe(true)
    expect(kernel.calls).toEqual([])
    expect(f.owner.isBound(CHILD)).toBe(false)
    expect(Object.keys(child.tools)).toEqual([])
  })

  test("#when the component has no kernel owner #then the requirement stays unbound", async () => {
    // given
    const f = await fixture(), kernel = fakeGrant()
    // when
    const { coverage } = f.stageChild(kernel.grant, false)
    // then
    expect(coverage.boundRequirements).not.toContain("kernel-live-bindings")
    expect(f.owner.isBound(CHILD)).toBe(false)
  })
})

describe("#given the kernel call ledger", () => {
  test("#then a capability is visible only to the lent eval call and only while a loan is out", () => {
    // given
    const ledger = createKernelCallLedger(), capability = {}, other = {}
    const call = { sessionID: PARENT, id: "eval-call" }
    // when
    const first = ledger.lend(call, capability)
    const second = ledger.lend(call, other)
    const during = [ledger.read(call), ledger.read({ sessionID: PARENT, id: "direct-task-call" }), ledger.read({ sessionID: CHILD, id: "eval-call" })]
    second()
    const afterSecond = ledger.read(call)
    first(); first()
    // then
    expect(during).toEqual([other, undefined, undefined])
    expect(afterSecond).toBe(capability)
    expect(ledger.read(call)).toBeUndefined()
    expect(ledger.size()).toBe(0)
  })

  test("#when the Native grant is resolved against the task context #then a task outside an eval cell is refused and an eval cell's task is granted", async () => {
    // given
    const ledger = createKernelCallLedger(), kernel = fakeGrant()
    const live = { ...kernel.grant.capability, describe: async (names: readonly string[]) => ({ results: names.map(name => ({ name, ok: true, descriptor: kernel.grant.descriptors[0] })) }) }
    const evalCall = { sessionID: PARENT, id: "eval-call" }
    const giveBack = ledger.lend(evalCall, live)
    const resolve = (caller: typeof evalCall) => resolveKernelToolGrant({ requestedNames: ["double"], executionMode: "in-process",
      capability: ledger.read(caller) as KernelToolGrant["capability"] | undefined })
    // when
    const outside = await resolve({ sessionID: PARENT, id: "direct-task-call" })
    const inside = await resolve(evalCall)
    giveBack()
    // then
    expect(outside).toMatchObject({ kind: "denied", code: "tools_unavailable" })
    expect(inside.kind).toBe("granted")
    expect(inside.kind === "granted" && inside.grant.capability).toBe(live)
  })
})
