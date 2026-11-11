import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Schema, Scope } from "effect"
import type { ToolDomain, ToolEditor } from "@opencode/plugin/effect/tool"
import type { PermissionDomain, PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { AssertInput } from "@opencode/plugin/permission"
import { filterSharedParentTools } from "@oh-my-opencode/senpi-task/task-operations"
import type { ManagedStartSpec } from "@oh-my-opencode/senpi-task/manager-kernel"
import { acquireOwnedChildToolGuard } from "../../host/owned-child-tool-guard"
import type { ChildHandle } from "../../host/session-backend"
import { createNativeChildGuardBinding } from "./child-guard-binding"
import { prepareHostTaskGrant } from "./host-grant"

type Info = ReturnType<ToolEditor["list"]>[number]
type Context = Parameters<Info["execute"]>[1]
const LISTING_ID = "omo_native_ls", CHILD = "ses_network_child"
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}
function context(): Context {
  const value = Schema.decodeUnknownSync(AssertInput)({ sessionID: CHILD, agent: "build", action: "unit", resources: [], source: { type: "tool", messageID: "unit-message", id: "unit-call" } })
  if (!value.agent || value.source?.type !== "tool") throw Error("Invalid controlled UNIT source")
  return { sessionID: value.sessionID, agent: value.agent, messageID: value.source.messageID as Context["messageID"], id: value.source.id as Context["id"], progress: () => Effect.void }
}
/** The `webfetch` evaluation OpenCode raises: CodeMode `fetch` sends `{method, url}`, the stock tool sends no method. */
function fetchEvent(url: string, update: Partial<PermissionEvaluation> = {}): PermissionEvaluation {
  const ctx = context()
  return { sessionID: ctx.sessionID, agent: ctx.agent, action: "webfetch", resources: [url], metadata: { method: "GET", url }, source: { type: "tool", id: ctx.id, messageID: ctx.messageID }, effect: "allow", ...update }
}

/** Controlled UNIT SDK ports around the REAL guard and the REAL component binder. */
async function boundChild(nativeNames: readonly string[]) {
  const scope = Scope.makeUnsafe(), tools = new Map<string, Info>()
  let hook: ((event: PermissionEvaluation) => Effect.Effect<void>) | undefined
  const evaluate = (event: PermissionEvaluation) => defined(hook)(event)
  const webfetch: Info["execute"] = (_input, ctx) => Effect.gen(function* () {
    const direct = fetchEvent("https://docs.test/page", { sessionID: ctx.sessionID, agent: ctx.agent, metadata: { url: "https://docs.test/page", format: "text" }, source: { type: "tool", id: ctx.id, messageID: ctx.messageID } })
    yield* evaluate(direct)
    return { content: direct.effect }
  })
  for (const [id, execute] of [["read", undefined], ["webfetch", webfetch], [LISTING_ID, undefined]] as const)
    tools.set(id, { id, name: id, description: id, input: { type: "object" }, execute: execute ?? (() => Effect.succeed({ content: id })) })
  const editor: ToolEditor = { list: () => [...tools.values()], get: id => tools.get(id), namespace() {}, remove: id => { tools.delete(id) },
    add: value => { tools.set(value.name, { ...value, id: value.name }) }, update: (id, change) => { const value = tools.get(id); if (value) change(value) } }
  const tool: Pick<ToolDomain, "transform"> = { transform: callback => Effect.sync(() => { callback(editor); return { dispose: Effect.void } }) }
  const permission: Pick<PermissionDomain, "hook"> = { hook: (_name, callback) => Effect.sync(() => { hook = callback; return { dispose: Effect.sync(() => { hook = undefined }) } }) }
  const guard = await Effect.runPromise(Effect.provideService(acquireOwnedChildToolGuard({ tool, permission }), Scope.Scope, scope))
  const catalog = [{ id: "read", name: "read", options: { codemode: false as const } }, { id: "webfetch", name: "webfetch", options: { codemode: false as const } }, { id: LISTING_ID, name: LISTING_ID, options: { codemode: true } }]
  const selection = prepareHostTaskGrant({ spec: { prompt: "unit", parent_session_id: "ses_parent", depth: 1 }, plan: { model: "unit/model", agentType: "sisyphus-junior" },
    includeTaskTools: true, nativeTools: nativeNames.map(name => ({ name })), catalog, customCounterparts: [{ nativeName: "ls", hostID: LISTING_ID }], canonical: { filterSharedParentTools } })
  const spec: ManagedStartSpec = { taskId: "st_00000001", cwd: "/project", stateDir: "/state", prompt: "unit", depth: 1, parentSessionId: "ses_parent", rootSessionId: "ses_parent", agentType: "sisyphus-junior" }
  const stage = guard.beginStage(guard.approve({}, { selection, buildAgentID: "build", assertCurrent() {} }), CHILD, () => {})
  const binding = createNativeChildGuardBinding({ assertGeneration() {}, network: { guard } })(spec, { buildAgentID: "build", selection })
    .bind({ locator: { sessionID: CHILD }, lease: {} } as unknown as ChildHandle, () => {})
  guard.bind(stage, binding)
  cleanups.push(async () => {
    await Effect.runPromise(guard.join(stage)); guard.release(stage, () => {})
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
  })
  const decide = async (event: PermissionEvaluation) => { await Effect.runPromise(evaluate(event)); return event.effect }
  return { guard, stage, selection, binding, decide, runWebfetch: () => Effect.runPromise(defined(tools.get("webfetch")).execute({}, context())) }
}

describe("#given an owned child whose Native selection includes webfetch", () => {
  test("#when CodeMode fetch issues GET #then the guard keeps the URL's own permission decision", async () => {
    // given
    const child = await boundChild(["read", "webfetch", "ls"])
    expect(child.selection.requirements).toEqual(["codemode-network-guard"])
    expect(child.binding.network?.hostID).toBe("webfetch")
    // when
    const allowed = await child.decide(fetchEvent("http://127.0.0.1:4096/data"))
    const asked = await child.decide(fetchEvent("https://other.test/x", { effect: "ask" }))
    // then
    expect(allowed).toBe("allow")
    expect(asked).toBe("ask")
  })

  test("#when the user's webfetch rule denies the URL #then GET stays denied", async () => {
    // given
    const child = await boundChild(["read", "webfetch", "ls"])
    // when
    const effect = await child.decide(fetchEvent("https://blocked.test/secret", { effect: "deny" }))
    // then
    expect(effect).toBe("deny")
  })

  test("#when CodeMode fetch uses POST, PUT or a non-http scheme #then it is denied", async () => {
    // given
    const child = await boundChild(["read", "webfetch", "ls"])
    // when
    const effects = await Promise.all([
      child.decide(fetchEvent("https://docs.test/a", { metadata: { method: "POST", url: "https://docs.test/a" } })),
      child.decide(fetchEvent("https://docs.test/a", { metadata: { method: "PUT", url: "https://docs.test/a" } })),
      child.decide(fetchEvent("file:///etc/hosts")),
    ])
    // then
    expect(effects).toEqual(["deny", "deny", "deny"])
  })

  test("#when the stock webfetch tool runs its own methodless request #then the pre-wrap original is recognised", async () => {
    // given
    const child = await boundChild(["read", "webfetch", "ls"])
    // when
    const result = await child.runWebfetch()
    // then
    expect(result).toEqual({ content: "allow" })
  })

  test("#when the child is revoked #then GET is denied again", async () => {
    // given
    const child = await boundChild(["read", "webfetch", "ls"])
    expect(await child.decide(fetchEvent("https://docs.test/a"))).toBe("allow")
    // when
    child.guard.revoke(child.stage)
    // then
    expect(await child.decide(fetchEvent("https://docs.test/a"))).toBe("deny")
  })
})

describe("#given an owned child whose Native selection has no webfetch", () => {
  test("#when CodeMode fetch issues GET #then the guard stays deny-all", async () => {
    // given
    const child = await boundChild(["read", "ls"])
    expect(child.binding.network).toBeUndefined()
    // when
    const effect = await child.decide(fetchEvent("https://docs.test/a"))
    // then
    expect(effect).toBe("deny")
  })
})
