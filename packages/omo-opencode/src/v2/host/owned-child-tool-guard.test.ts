import { afterEach, expect, test } from "bun:test"
import { Cause, Effect, Exit, Scope, Schema } from "effect"
import type { ToolDomain, ToolEditor } from "@opencode/plugin/effect/tool"
import type { PermissionDomain, PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { AssertInput } from "@opencode/plugin/permission"
import { acquireOwnedChildToolGuard } from "./owned-child-tool-guard"
import type { PreparedHostTaskGrant } from "../orchestration/native-task/host-grant"

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}

type Info = ReturnType<ToolEditor["list"]>[number]
type Context = Parameters<Info["execute"]>[1]
const selection: PreparedHostTaskGrant = { selected: [{ nativeName: "read", hostID: "read" }, { nativeName: "web_fetch", hostID: "web" }], deniedHostIDs: ["edit"], unavailableNativeNames: [], requirements: [], bindingSlots: [], allowsCodeModeTransport: true, modelCoverage: "native-selection-with-unchanged-persona-and-tool-policy" }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0)) await close() })

/** Controlled UNIT SDK-domain ports. Contexts below are explicit unit data,
 * never claimed as actual host-created callers or CodeMode dispatch evidence. */
async function fixture(execute?: Info["execute"], disposePermission?: () => Effect.Effect<void>) {
  const calls: { tool: string; context: Context; receiver: unknown }[] = []
  const scope = Scope.makeUnsafe(), tools = new Map<string, Info>()
  let hook: ((event: PermissionEvaluation) => Effect.Effect<void>) | undefined
  let toolDisposals = 0, permissionDisposals = 0, failToolDispose = false
  for (const id of ["read", "edit", "web"]) {
    const original: Info = { id, name: id, description: id, input: { type: "object" }, execute: execute ?? function(this: unknown, _input, context) {
      const receiver = this
      return Effect.sync(() => { calls.push({ tool: id, context, receiver }); return { content: id } })
    } }
    tools.set(id, original)
  }
  const originals = new Map(tools)
  const editor: ToolEditor = { list: () => [...tools.values()], get: id => tools.get(id), namespace() {}, remove: id => { tools.delete(id) },
    add: value => { tools.set(value.name, { ...value, id: value.name }) },
    update: (id, change) => { const value = tools.get(id); if (value) change(value) } }
  const tool: Pick<ToolDomain, "transform"> = { transform: callback => Effect.sync(() => {
    callback(editor)
    return { dispose: Effect.sync(() => { toolDisposals++; if (failToolDispose) { failToolDispose = false; throw Error("Tool disposer failed once") } }) }
  }) }
  const permission: Pick<PermissionDomain, "hook"> = { hook: (_name, callback) => Effect.sync(() => {
    hook = callback
    return { dispose: Effect.suspend(() => { permissionDisposals++; return (disposePermission?.() ?? Effect.void).pipe(Effect.andThen(Effect.sync(() => { hook = undefined }))) }) }
  }) }
  const owner = await Effect.runPromise(Effect.provideService(acquireOwnedChildToolGuard({ tool, permission }), Scope.Scope, scope))
  const claimed: ReturnType<typeof owner.beginStage>[] = []
  const newStage = (approval: Parameters<typeof owner.beginStage>[0], sessionID = "ses_unit_child") => {
    const stage = owner.beginStage(approval, sessionID, () => {}); claimed.push(stage); return stage
  }
  cleanups.push(async () => {
    for (const stage of claimed) { await Effect.runPromise(owner.join(stage)); owner.release(stage, () => {}) }
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
  })
  const context = (sessionID = "ses_unit_child", agent = "unit-build"): Context => {
    const value = Schema.decodeUnknownSync(AssertInput)({ sessionID, agent, action: "unit", resources: [], source: { type: "tool", messageID: "unit-message", id: "unit-call" } })
    if (!value.agent || value.source?.type !== "tool") throw Error("Invalid controlled UNIT source")
    // AssertInput deliberately encodes source IDs as strings. Only these known
    // UNIT literals receive their field brands; no whole-context unknown cast.
    return { sessionID: value.sessionID, agent: value.agent, messageID: value.source.messageID as Context["messageID"], id: value.source.id as Context["id"], progress: () => Effect.void }
  }
  const approve = (assertCurrent = () => {}) => owner.approve({}, { selection, buildAgentID: "unit-build", assertCurrent })
  const begin = () => newStage(approve())
  const bind = (stage: ReturnType<typeof begin>, assertCurrent = () => {}) => owner.bind(stage, { child: {}, agent: "unit-build", assertCurrent })
  const run = (id: string, ctx = context()) => Effect.runPromiseExit(defined(tools.get(id)).execute({}, ctx))
  const network = (update: Partial<PermissionEvaluation> = {}): PermissionEvaluation => {
    const ctx = context()
    return { sessionID: ctx.sessionID, agent: ctx.agent, action: "webfetch", resources: ["https://allowed.test/one"], metadata: { method: "GET" }, source: { type: "tool", id: ctx.id, messageID: ctx.messageID }, effect: "allow", ...update }
  }
  return { owner, tools, originals, calls, context, approve, begin, newStage, bind, run, network, evaluateEffect: (value: PermissionEvaluation) => defined(hook)(value), evaluate: (value: PermissionEvaluation) => Effect.runPromise(defined(hook)(value)),
    failDisposal() { failToolDispose = true }, disposals: () => ({ toolDisposals, permissionDisposals }) }
}

test("provisional, halfbound and revoked children cannot fall through as unrelated", async () => {
  const f = await fixture(), stage = f.begin()
  expect(Exit.isFailure(await f.run("read"))).toBe(true)
  expect(() => f.bind(stage, () => { throw Error("Original journal fence") })).toThrow("Original journal fence")
  expect(Exit.isFailure(await f.run("read"))).toBe(true)
  f.bind(stage); f.owner.revoke(stage)
  expect(Exit.isFailure(await f.run("read"))).toBe(true); expect(f.calls).toHaveLength(0)
})

test("final original leaf, actual agent and current original child fence decide; unrelated root untouched", async () => {
  const f = await fixture(), stage = f.begin(); let current = true
  f.bind(stage, () => { if (!current) throw Error("stale epoch/owner") })
  const ctx = f.context()
  expect(Exit.isSuccess(await f.run("read", ctx))).toBe(true)
  expect(f.calls[0].context).toBe(ctx); expect(f.calls[0].receiver).toBe(f.originals.get("read"))
  // A requested/call identity is not the leaf ID: a permitted read call routed
  // to edit is rejected by the edit wrapper, including an inner CodeMode call.
  expect(Exit.isFailure(await f.run("edit", ctx))).toBe(true)
  expect(Exit.isFailure(await f.run("read", f.context(undefined, "foreign-agent")))).toBe(true)
  current = false; expect(Exit.isFailure(await f.run("read"))).toBe(true)
  expect(Exit.isSuccess(await f.run("edit", f.context("ses_unrelated")))).toBe(true)
  expect(f.calls.map(value => value.tool)).toEqual(["read", "edit"])
})

test("forged tokens, duplicate stages/children and stale approval cannot mint execution", async () => {
  const f = await fixture(); let live = true
  const approval = f.approve(() => { if (!live) throw Error("retired producer") })
  expect(() => f.owner.beginStage({ ...approval }, "ses_clone", () => {})).toThrow()
  const stage = f.newStage(approval)
  expect(() => f.owner.beginStage(approval, "ses_duplicate", () => {})).toThrow()
  expect(() => f.owner.bind({ ...stage }, { child: {}, agent: "unit-build", assertCurrent() {} })).toThrow()
  f.bind(stage); live = false
  expect(Exit.isFailure(await f.run("read"))).toBe(true); expect(f.calls).toHaveLength(0)
})

test("same-admission retry waits original cleanup and actual closed proof; denied marker retained on failed close", async () => {
  const f = await fixture(), approval = f.approve(), stage = f.newStage(approval)
  expect(() => f.owner.release(stage, () => {})).toThrow("not joined")
  await Effect.runPromise(f.owner.join(stage))
  expect(() => f.owner.release(stage, () => { throw Error("actual remove failed") })).toThrow("actual remove failed")
  expect(Exit.isFailure(await f.run("read"))).toBe(true)
  expect(() => f.owner.beginStage(approval, "ses_retry", () => {})).toThrow()
  f.owner.release(stage, () => {})
  const retry = f.newStage(approval, "ses_retry"); f.bind(retry)
  expect(Exit.isSuccess(await f.run("read", f.context("ses_retry")))).toBe(true)
})

test("revoke synchronously denies new calls and join waits ORIGINAL delayed Effect finalizer", async () => {
  const entered = Promise.withResolvers<void>(), finalizing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = await fixture(() => Effect.sync(() => entered.resolve()).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.promise(async () => { finalizing.resolve(); await release.promise }))))
  const stage = f.begin(); f.bind(stage)
  const work = f.run("read"); await entered.promise
  let joined = false, secondJoined = false, callbackSettled = false; void work.then(() => { callbackSettled = true })
  const closing = Effect.runPromise(f.owner.join(stage)).then(() => { joined = true })
  let secondClosing: Promise<void> | undefined
  try {
    await finalizing.promise
    secondClosing = Effect.runPromise(f.owner.join(stage)).then(() => { secondJoined = true })
    expect(joined).toBe(false); expect(callbackSettled).toBe(false)
    expect(Exit.isFailure(await f.run("read"))).toBe(true)
    await Effect.runPromise(Effect.yieldNow)
    expect(secondJoined).toBe(false)
    expect(() => f.owner.release(stage, () => {})).toThrow("not joined")
  } finally { release.resolve(); await closing; await secondClosing; await work }
  expect(joined).toBe(true); expect(callbackSettled).toBe(true)
})

test("original typed Tool.Error identity survives leaf execution", async () => {
  const error = new ToolError({ message: "actual original unit error" })
  const f = await fixture(() => Effect.fail(error)), stage = f.begin(); f.bind(stage)
  const exit = await f.run("read")
  if (Exit.isSuccess(exit)) throw Error("Expected original error")
  const reason = exit.cause.reasons.find(Cause.isFailReason)
  expect(reason?.error).toBe(error)
})

test("network provisional deny, live GET and host ask/deny unchanged; POST, redirect, missing metadata fail closed", async () => {
  const f = await fixture(), stage = f.begin()
  const provisional = f.network(); await f.evaluate(provisional); expect(provisional.effect).toBe("deny")
  f.owner.bind(stage, { child: {}, agent: "unit-build", assertCurrent() {}, network: { hostID: "web", assertCurrent() {}, allowsGet: url => new URL(url).hostname === "allowed.test" } })
  for (const effect of ["allow", "ask", "deny"] as const) {
    const value = f.network({ effect }); await f.evaluate(value); expect(value.effect).toBe(effect)
  }
  for (const update of [{ metadata: { method: "POST" } }, { metadata: undefined }, { source: undefined }, { resources: ["https://denied.test/hop"], metadata: { method: "GET", redirectedFrom: "https://allowed.test/one" } }, { agent: f.context(undefined, "foreign").agent }]) {
    const value = f.network(update); await f.evaluate(value); expect(value.effect).toBe("deny")
  }
  const foreign = f.network({ sessionID: f.context("ses_unrelated").sessionID, metadata: { method: "POST" } }); await f.evaluate(foreign); expect(foreign.effect).toBe("allow")
})

test("failed original registration disposal is retained and retried; stopped owner cannot create more stages", async () => {
  const f = await fixture(), stage = f.begin(); f.bind(stage); f.failDisposal()
  await Effect.runPromise(f.owner.join(stage)); f.owner.release(stage, () => {})
  const first = await Effect.runPromiseExit(f.owner.close()); expect(Exit.isFailure(first)).toBe(true)
  expect(() => f.begin()).toThrow("closing")
  await Effect.runPromise(f.owner.close())
  expect(f.disposals()).toEqual({ toolDisposals: 2, permissionDisposals: 1 })
})

test("released owned IDs remain denied, including an original wrapped Effect captured before revocation", async () => {
  const f = await fixture(), stage = f.begin(); f.bind(stage)
  const retained = defined(f.tools.get("read")).execute({}, f.context())
  await Effect.runPromise(f.owner.join(stage)); f.owner.release(stage, () => {})
  expect(Exit.isFailure(await Effect.runPromiseExit(retained))).toBe(true)
  expect(Exit.isFailure(await f.run("read"))).toBe(true); expect(f.calls).toHaveLength(0)
})

test("explicit early close retains deny hooks until actual child close proof, then retry disposes", async () => {
  const f = await fixture(), stage = f.begin(); f.bind(stage)
  expect(Exit.isFailure(await Effect.runPromiseExit(f.owner.close()))).toBe(true)
  expect(f.disposals()).toEqual({ toolDisposals: 0, permissionDisposals: 0 })
  expect(Exit.isFailure(await f.run("read"))).toBe(true)
  const network = f.network(); await f.evaluate(network); expect(network.effect).toBe("deny")
  f.owner.release(stage, () => {})
  await Effect.runPromise(f.owner.close())
  expect(f.disposals()).toEqual({ toolDisposals: 1, permissionDisposals: 1 })
})

test("methodless direct SDK webfetch requires exact original intrinsic GET Effect context; parallel CodeMode cannot borrow", async () => {
  const entered = Promise.withResolvers<void>(), proceed = Promise.withResolvers<void>()
  let direct!: PermissionEvaluation, evaluated!: (event: PermissionEvaluation) => Effect.Effect<void>
  const original: Info["execute"] = (_input, context) => Effect.gen(function* () {
    direct = { sessionID: context.sessionID, agent: context.agent, action: "webfetch", resources: ["https://allowed.test/one"], metadata: { url: "https://allowed.test/one#fragment", format: "text", timeout: 10 }, source: { type: "tool", id: context.id, messageID: context.messageID }, effect: "allow" }
    entered.resolve(); yield* Effect.promise(() => proceed.promise)
    yield* evaluated(direct); return { content: "direct fetched" }
  })
  const f = await fixture(original), stage = f.begin(); evaluated = f.evaluateEffect
  f.owner.bind(stage, { child: {}, agent: "unit-build", assertCurrent() {}, network: { hostID: "web", intrinsicGetOriginal: original, assertCurrent() {}, allowsGet: () => true } })
  const work = f.run("web"); await entered.promise
  try {
    const code = f.network({ metadata: { url: "https://allowed.test/one" } })
    await f.evaluate(code); expect(code.effect).toBe("deny")
  } finally { proceed.resolve(); await work }
  expect(direct.effect).toBe("allow")
})

test("revocation during the final original child fence cannot execute the target", async () => {
  const f = await fixture(), stage = f.begin(); let checks = 0
  f.bind(stage, () => { if (++checks === 3) f.owner.revoke(stage) })
  // bind check, wrapper check, executor's immediate final check revokes.
  expect(Exit.isFailure(await f.run("read"))).toBe(true); expect(f.calls).toHaveLength(0)
})

test("concurrent owner close joins SAME original delayed disposer exactly once", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = await fixture(undefined, () => Effect.promise(async () => { entered.resolve(); await release.promise }))
  let firstSettled = false, secondSettled = false
  const first = Effect.runPromise(f.owner.close()).then(() => { firstSettled = true })
  await entered.promise
  const second = Effect.runPromise(f.owner.close()).then(() => { secondSettled = true })
  try {
    await Effect.runPromise(Effect.yieldNow)
    expect(firstSettled).toBe(false); expect(secondSettled).toBe(false)
    expect(f.disposals()).toEqual({ permissionDisposals: 1, toolDisposals: 0 })
  } finally { release.resolve(); await first; await second }
  expect(f.disposals()).toEqual({ permissionDisposals: 1, toolDisposals: 1 })
})

test("parked retirement needs joined originals plus the backend-validated receipt; parked IDs stay denied and close completes", async () => {
  // given a bound stage whose original Promise producer is still held
  const f = await fixture(), held = Promise.withResolvers<void>(), child = {}, receipt = {}, validated: object[] = []
  let revoked = 0
  const stage = f.owner.beginStage(f.approve(), "ses_unit_parked", () => {})
  f.owner.bind(stage, { child, agent: "unit-build", assertCurrent() {}, producers: { revoke() { revoked++ }, join: () => held.promise } })
  const lazy = defined(f.tools.get("read")).execute({}, f.context("ses_unit_parked"))
  const validate = (value: object, issued: object) => { if (value !== receipt) throw Error("Unissued parking receipt"); validated.push(issued) }
  // when its Effect scope joins but the producer has not settled
  let joined = false
  const joining = Effect.runPromise(f.owner.join(stage)).then(() => { joined = true })
  await Effect.runPromise(Effect.yieldNow)
  // then parked retirement is refused and nothing was validated
  expect(revoked).toBeGreaterThan(0); expect(joined).toBe(false)
  expect(() => f.owner.retireParked(stage, receipt, validate)).toThrow("not joined"); expect(validated).toHaveLength(0)
  held.resolve(); await joining
  // a forged receipt cannot mint retirement; the original one validates against the ORIGINAL child
  expect(() => f.owner.retireParked(stage, {}, validate)).toThrow("Unissued")
  f.owner.retireParked(stage, receipt, validate); expect(validated).toEqual([child])
  f.owner.retireParked(stage, receipt, validate)
  expect(() => f.owner.release(stage, () => {})).toThrow("no closed receipt")
  // and the owned ID keeps its deny tombstone, including a lazy wrapper captured before parking
  expect(Exit.isFailure(await Effect.runPromiseExit(lazy))).toBe(true)
  expect(Exit.isFailure(await f.run("read", f.context("ses_unit_parked")))).toBe(true); expect(f.calls).toHaveLength(0)
  await Effect.runPromise(f.owner.close())
  expect(f.disposals()).toEqual({ toolDisposals: 1, permissionDisposals: 1 })
})

test("a failed original producer join keeps custody and a later explicit join retries it", async () => {
  const f = await fixture(); let attempts = 0
  const stage = f.owner.beginStage(f.approve(), "ses_unit_producer", () => {}), receipt = {}
  f.owner.bind(stage, { child: {}, agent: "unit-build", assertCurrent() {}, producers: { revoke() {}, async join() { if (++attempts === 1) throw Error("producer finalizer failed") } } })
  expect(Exit.isFailure(await Effect.runPromiseExit(f.owner.join(stage)))).toBe(true)
  expect(() => f.owner.retireParked(stage, receipt, () => {})).toThrow("not joined")
  expect(Exit.isFailure(await Effect.runPromiseExit(f.owner.close()))).toBe(true)
  // close retried the failed producer join (attempt 2) yet still retained the unretired stage
  expect(attempts).toBe(2); await Effect.runPromise(f.owner.join(stage)); expect(attempts).toBe(2)
  f.owner.retireParked(stage, receipt, () => {})
  await Effect.runPromise(f.owner.close())
})

test("explicit renewal replaces only a joined parked tombstone; old-generation lazy calls stay denied", async () => {
  // given a bound child with a lazy call created in its generation
  const f = await fixture(), receipt = {}, sessionID = "ses_unit_renewed"
  const first = f.owner.beginStage(f.approve(), sessionID, () => {})
  f.owner.bind(first, { child: {}, agent: "unit-build", assertCurrent() {} })
  const stale = defined(f.tools.get("read")).execute({}, f.context(sessionID))
  // then a live (unparked) stage can neither be renewed nor begun again
  expect(() => f.owner.renewStage(f.approve(), sessionID, () => {})).toThrow("joined parked")
  await Effect.runPromise(f.owner.join(first)); f.owner.retireParked(first, receipt, () => {})
  expect(() => f.owner.beginStage(f.approve(), sessionID, () => {})).toThrow("busy")
  // when a fresh approval renews the parked tombstone and binds the new child
  const renewed = f.owner.renewStage(f.approve(), sessionID, () => {})
  f.owner.bind(renewed, { child: {}, agent: "unit-build", assertCurrent() {} })
  // then the old generation's lazy call is denied while a fresh call executes
  expect(Exit.isFailure(await Effect.runPromiseExit(stale))).toBe(true)
  expect(Exit.isSuccess(await f.run("read", f.context(sessionID)))).toBe(true); expect(f.calls).toHaveLength(1)
  await Effect.runPromise(f.owner.join(renewed)); f.owner.retireParked(renewed, {}, () => {})
  await Effect.runPromise(f.owner.close())
})
