import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { filterSharedParentTools } from "@oh-my-opencode/senpi-task/task-operations"
import type { ManagedStartSpec } from "@oh-my-opencode/senpi-task/manager-kernel"
import { AssertInput } from "@opencode/plugin/permission"
import type { PermissionDomain, PermissionEvaluation } from "@opencode/plugin/effect/permission"
import type { ToolDomain, ToolEditor } from "@opencode/plugin/effect/tool"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { Effect, Exit, Schema, Scope } from "effect"
import { acquireEffectPermissionApi } from "../../host/effect-permission-api"
import { acquireOwnedChildToolGuard } from "../../host/owned-child-tool-guard"
import type { ChildHandle } from "../../host/session-backend"
import { CODEMODE_READONLY_PERMISSION, CODEMODE_READONLY_TOOL_NAME } from "../../tools/codemode-readonly"
import { createNativeChildGuardBinding } from "./child-guard-binding"
import { childCatalog, hideUnboundCodemodeReadonly } from "./component"
import { prepareHostTaskGrant } from "./host-grant"
import { acquireCodemodeReadonly } from "./live-codemode-readonly"

type Info = ReturnType<ToolEditor["list"]>[number]
type Context = Parameters<Info["execute"]>[1]
type Request = typeof AssertInput.Encoded

const CHILD = "ses_codemode_child", PARENT = "ses_parent", AGENT = "build"
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}
function failureMessage(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) throw Error("Expected a failed tool call")
  const error = exit.cause.reasons.map(reason => reason._tag === "Fail" ? reason.error : undefined).find(value => value instanceof ToolError)
  if (!(error instanceof ToolError)) throw Error(`Expected a typed tool error, got ${String(exit.cause)}`)
  return error.message
}
function text(exit: Exit.Exit<{ readonly content?: unknown }, unknown>): string {
  if (!Exit.isSuccess(exit)) throw Error(`Expected success, got ${String(exit.cause)}`)
  const content = exit.value.content
  if (!Array.isArray(content)) throw Error("Expected content parts")
  return content.map(part => (part as { text?: string }).text ?? "").join("")
}

/** Controlled UNIT SDK-domain ports with the real permission owner, ls owner and owned-child guard,
 * registered in the component's order (counterpart BEFORE the guard, so the guard wraps it). */
async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "omo-codemode-ls-"))
  mkdirSync(join(cwd, "Alpha")); writeFileSync(join(cwd, "b.txt"), "b"); writeFileSync(join(cwd, ".hidden"), "h")
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
  const scope = Scope.makeUnsafe(), tools = new Map<string, Info>()
  const editor: ToolEditor = { list: () => [...tools.values()], get: id => tools.get(id), namespace() {}, remove: id => { tools.delete(id) },
    add: value => { tools.set(value.name, { ...value, id: value.name }) },
    update: (id, change) => { const value = tools.get(id); if (value) change(value) } }
  const tool: Pick<ToolDomain, "transform" | "list"> = {
    transform: callback => Effect.sync(() => { callback(editor); return { dispose: Effect.void } }),
    list: () => Effect.sync(() => [...tools.values()]),
  }
  const requests: Request[] = []
  const permission = await Effect.runPromise(Effect.provideService(acquireEffectPermissionApi({ assert: request => { requests.push(request); return Effect.void } }), Scope.Scope, scope))
  const owner = await Effect.runPromise(Effect.provideService(acquireCodemodeReadonly({ tool }, permission), Scope.Scope, scope))
  let hook: ((event: PermissionEvaluation) => Effect.Effect<void>) | undefined
  const guardPermission: Pick<PermissionDomain, "hook"> = { hook: (_name, callback) => Effect.sync(() => { hook = callback; return { dispose: Effect.void } }) }
  const guard = await Effect.runPromise(Effect.provideService(acquireOwnedChildToolGuard({ tool, permission: guardPermission }), Scope.Scope, scope))
  const stages: ReturnType<typeof guard.beginStage>[] = []
  cleanups.push(async () => {
    for (const stage of stages) { await Effect.runPromise(guard.join(stage)); guard.release(stage, () => {}) }
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))); await permission.close()
  })
  const context = (sessionID = CHILD): Context => {
    const value = Schema.decodeUnknownSync(AssertInput)({ sessionID, agent: AGENT, action: "unit", resources: [], source: { type: "tool", messageID: "unit-message", id: "unit-call" } })
    if (!value.agent || value.source?.type !== "tool") throw Error("Invalid controlled UNIT source")
    return { sessionID: value.sessionID, agent: value.agent, messageID: value.source.messageID as Context["messageID"], id: value.source.id as Context["id"], progress: () => Effect.void }
  }
  /** Stage and bind one owned child exactly as the runner does, over the component's binder. */
  function stageChild(withListing: boolean) {
    const nativeTools = ["read", "grep", ...(withListing ? ["ls"] : [])].map(name => ({ name }))
    const selection = prepareHostTaskGrant({ spec: { prompt: "unit", parent_session_id: PARENT, depth: 1 }, plan: { model: "unit/model", agentType: "sisyphus-junior" },
      includeTaskTools: true, nativeTools, catalog: childCatalog([...tools.values()]), customCounterparts: withListing ? [{ nativeName: "ls", hostID: owner.hostID }] : [],
      canonical: { filterSharedParentTools } })
    const spec: ManagedStartSpec = { taskId: "st_00000001", cwd, stateDir: "/state", prompt: "unit", depth: 1, parentSessionId: PARENT, rootSessionId: PARENT, agentType: "sisyphus-junior" }
    const producer = createNativeChildGuardBinding({ assertGeneration() {}, codemodeReadonly: owner, network: { guard } })(spec, { buildAgentID: AGENT, selection })
    const stage = guard.beginStage(guard.approve({}, { selection, buildAgentID: AGENT, assertCurrent() {} }), CHILD, () => {})
    stages.push(stage)
    guard.bind(stage, producer.bind({ locator: { sessionID: CHILD }, lease: {} } as unknown as ChildHandle, () => {}))
    return selection
  }
  const run = (input: unknown, ctx = context()) => Effect.runPromiseExit(defined(tools.get(CODEMODE_READONLY_TOOL_NAME)).execute(input, ctx))
  const fetch = (url: string, method: string): Promise<PermissionEvaluation> => {
    const event: PermissionEvaluation = { sessionID: CHILD, agent: AGENT, action: "webfetch", resources: [url], metadata: { method, url },
      source: { type: "tool", id: "unit-call", messageID: "unit-message" }, effect: "allow" }
    return Effect.runPromise(defined(hook)(event)).then(() => event)
  }
  return { cwd, tools, owner, requests, run, stageChild, fetch, context }
}

describe("#given the dedicated CodeMode ls counterpart registration", () => {
  test("#then it is a codemode:true SDK tool with its own permission, in the child catalog", async () => {
    // given
    const f = await fixture()
    // when
    const info = defined(f.tools.get(CODEMODE_READONLY_TOOL_NAME))
    // then
    expect(info.options).toEqual({ codemode: true, permission: CODEMODE_READONLY_PERMISSION })
    expect(f.owner.hostID).toBe(CODEMODE_READONLY_TOOL_NAME)
    expect(childCatalog([...f.tools.values()]).map(tool => tool.id)).toContain(f.owner.hostID)
  })

  test("#when a parent or unbound session calls it #then it is refused and hidden from its model context", async () => {
    // given
    const f = await fixture()
    const parent = { sessionID: PARENT, tools: { [f.owner.hostID]: {}, read: {} } as Record<string, unknown> }
    // when
    const exit = await f.run({}, f.context(PARENT))
    hideUnboundCodemodeReadonly(parent, f.owner)
    // then
    expect(failureMessage(exit)).toContain("only to a Native child issued by this component")
    expect(Object.keys(parent.tools)).toEqual(["read"])
    expect(f.requests).toEqual([])
  })
})

describe("#given an owned child granted Native ls under the deny-all network guard", () => {
  test("#when the inner CodeMode call runs #then the guard admits it and the Native listing answers under its own permission", async () => {
    // given
    const f = await fixture()
    const selection = f.stageChild(true)
    const child = { sessionID: CHILD, tools: { [f.owner.hostID]: {} } as Record<string, unknown> }
    // when
    const exit = await f.run({})
    hideUnboundCodemodeReadonly(child, f.owner)
    // then
    expect(selection.requirements).toEqual(["codemode-network-guard"])
    expect(text(exit)).toBe(".hidden\nAlpha/\nb.txt")
    expect(f.requests.map(request => ({ action: request.action, resources: request.resources }))).toEqual([{ action: CODEMODE_READONLY_PERMISSION, resources: [f.cwd] }])
    expect(Object.keys(child.tools)).toEqual([f.owner.hostID])
  })

  test("#when CodeMode fetch raises webfetch #then every method is denied because no network producer is bound", async () => {
    // given
    const f = await fixture()
    f.stageChild(true)
    // when
    const get = await f.fetch("https://example.test/", "GET")
    const post = await f.fetch("https://example.test/", "POST")
    // then
    expect(get.effect).toBe("deny")
    expect(post.effect).toBe("deny")
    expect(get.message).toBe("Owned child network grant refused")
  })

  test("#when a child without the ls grant calls it #then the guard refuses it before the listing runs", async () => {
    // given
    const f = await fixture()
    f.stageChild(false)
    // when
    const exit = await f.run({})
    // then
    expect(failureMessage(exit)).toBe("Final child tool is outside the Native grant")
    expect(f.requests).toEqual([])
  })
})
