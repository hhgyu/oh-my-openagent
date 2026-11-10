import { withNativeTargetPermissionService } from "../orchestration/native-task/service.test"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Schema, Scope } from "effect"
import { join, resolve } from "node:path"
import type { ToolContext, ToolDomain, ToolEditor, Info } from "@opencode/plugin/promise/tool"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import type { NativeOperationOwner } from "../orchestration/native-task/operation-ports"
import { createToolRegistry, type ListedTool } from "../host/tool-registry"
import { createToolKernel } from "../host/tool-kernel"
import { createSessionScopes } from "../host/session-state"
import { createPolicyPipeline } from "../host/policy-pipeline"
import { createNativeTaskBridge, nativeTaskPublicInput, type NativeTaskBridgeOwner, type NativeTaskBridgeOptions } from "./native-task"
import { prepareNativeTaskRuntime, type NativeTaskPreparationOptions, type PreparedNativeTaskRuntime } from "./native-task-preparation"
import { acquireEffectPermissionApi, type JoinedPermissionApi } from "../host/effect-permission-api"
import { nativeTaskInputSchemas } from "./native-task-codecs"

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

/** Explicit controlled UNIT host. Actual registry/kernel issuance is exercised;
 * no SDK callback, host evaluator, child session or Native engine is claimed. */
function unitFixture(initial: ListedTool[] = [], sessionID = "unit-parent") {
  const events: string[] = [], starts: unknown[] = [], updates: unknown[] = [], entries = [...initial]
  let before: ((event: { tool: string; input: unknown }) => void | Promise<void>) | undefined
  let transform: ((editor: ToolEditor) => void) | undefined
  let parentGate: Promise<unknown> | undefined, acquisitionGate: Promise<unknown> | undefined
  let disposalFailures = 0, serviceFailures = 0, releaseFailures = 0
  let rollbackFailures = 0, contextCwd = "C:/unit/project"
  const callerController = new AbortController()
  let waitGate: ReturnType<typeof deferred<unknown>> | undefined, closeRejectsWait = false
  const waitEntered = deferred<void>()
  let startedResult: unknown = { kind: "started", task_id: "unit-child", status: "running", name: "unit-child", run_epoch: 1 }
  const editor: ToolEditor = {
    list: () => entries,
    get: id => entries.find(tool => tool.id === id), namespace() {},
    add(tool) { entries.push({ ...tool, id: `actual-${tool.name}` }); events.push(`add:${tool.name}`) },
    update(id, change) { events.push(`update:${id}`); const entry = entries.find(tool => tool.id === id); if (entry) change(entry) },
    remove(id) { const index = entries.findIndex(tool => tool.id === id); if (index >= 0) entries.splice(index, 1) },
  }
  const tool: ToolDomain = {
    async hook(_name, callback) {
      before = callback as typeof before; events.push("hook")
      return { async dispose() { events.push("dispose:hook"); before = undefined } }
    },
    async transform(callback) {
      transform = callback; callback(editor); events.push("transform")
      return { async dispose() {
        events.push("dispose:transform")
        if (disposalFailures-- > 0) throw false
        transform = undefined
      } }
    },
    async reload() { transform?.(editor) }, async list() { return entries },
  }
  const scopes = createSessionScopes()
  const prepared = {
    config: { task: { default_execution_mode: "in-process" } },
    agents: { worker: { name: "worker", prompt: "unit worker" } },
    authorizeSkills: async () => (names: readonly string[]) => ({ prepend: "KNOWN SKILL\n", resolved: names, missing: [] }),
  } as unknown as PreparedNativeTaskRuntime
  const caller = {
    sessionID, agent: "unit-agent", messageID: "unit-message", id: "unit-call",
    signal: callerController.signal, progress: async update => { events.push("progress"); updates.push(update) },
  } as ToolContext
  let resources!: NativeTaskBridgeOwner
  const options: NativeTaskBridgeOptions = { tool, prepared,
    async rollbackAcquisition() { events.push("rollback"); if (rollbackFailures-- > 0) throw false },
    async acquire(targets, signal) {
    events.push("acquire")
    if (acquisitionGate) await acquisitionGate
    // UNIT policy only. This is never imported by production assembly.
    const registry = createToolRegistry(targets.tools, { task: () => [{ action: "unit-task", resources: ["unit-parent"] }], task_output: () => [{ action: "unit-output", resources: ["unit-child"] }], task_send: () => [{ action: "unit-send", resources: ["unit-child"] }], task_cancel: () => [{ action: "unit-cancel", resources: ["unit-child"] }] }, targets.codecs, targets.normalizers)
    const kernel = createToolKernel({ registry, scopes, pipeline: createPolicyPipeline(), permission: { async assert() { events.push("permission") } } })
    const service = {
      async parent(actual: ToolContext) {
        events.push("parent:begin"); if (parentGate) await parentGate
        events.push("parent:end")
        return scopes.open(actual.sessionID, { tools: ["task", "task_output", "task_send", "task_cancel"], authorize() { events.push("authorize") } })
      },
      async forCall(actual: ToolContext) {
        kernel.callAuthority.assertCall(kernel.callAuthority.capture(actual)); events.push("forCall")
        return { async operation(run: (value: undefined, current: () => undefined, signal: AbortSignal, owner: NativeOperationOwner) => unknown, reporting: { progress: ToolContext["progress"] }) {
          events.push("operation")
          const owner = {
            task: {
              async start(spec: unknown) { starts.push(spec); return startedResult },
              get: () => undefined, subscribeChild: () => () => { events.push("unsubscribe") },
              waitFor: () => { waitEntered.resolve(); return defined(waitGate).promise },
            },
            output: { list: () => [], get: () => undefined },
            reportProgress: (update: Record<string, unknown>) => { void reporting.progress(update) },
          } as unknown as NativeOperationOwner
          return run(undefined, () => undefined, signal, owner)
        } }
      },
      async close() { events.push("service:close"); if (serviceFailures-- > 0) throw 0; if (closeRejectsWait) waitGate?.reject(Error("unit service stopped")) },
    } as unknown as NativeTaskBridgeOwner["service"]
    resources = { registry, kernel, service,
      context(actual) { events.push("context"); return { cwd: contextCwd, sessionManager: { getSessionId: () => actual.sessionID } } },
      taskDependencies: () => ({}), outputDependencies: () => ({ stateDir: "C:/unit/state" }),
      async release() { events.push("release"); if (releaseFailures-- > 0) throw null; scopes.dispose() },
    }
    return resources
  } }
  return { options, tool, editor, entries, caller, events, starts, updates, waitEntered: waitEntered.promise,
    get resources() { return resources },
    setParentGate(work: Promise<unknown>) { parentGate = work }, setAcquisitionGate(work: Promise<unknown>) { acquisitionGate = work },
    failDisposal() { disposalFailures++ }, failService() { serviceFailures++ }, failRelease() { releaseFailures++ },
    failRollback() { rollbackFailures++ },
    setStart(value: unknown) { startedResult = value },
    setCwd(value: string) { contextCwd = value },
    abortCaller(reason: unknown) { callerController.abort(reason) },
    waitFor(work: ReturnType<typeof deferred<unknown>>, stopOnClose = false) { waitGate = work; closeRejectsWait = stopOnClose },
    async call(name: string, input: unknown) {
      const selected = defined(entries.find(entry => entry.name === name))
      const event = { tool: selected.id, input }
      await before?.(event)
      // Real Effect validation; controlled caller is explicitly unit, above.
      const decoded = await Schema.decodeUnknownPromise(selected.input as ReturnType<typeof nativeTaskPublicInput>)(event.input)
      return selected.execute(decoded, caller)
    },
  }
}

test("strict public schema publishes SAME constraints and preserves original false and object identity", async () => {
  for (const name of ["task", "task_output", "task_send", "task_cancel"] as const) {
    const schema = nativeTaskPublicInput(name)
    expect(Schema.toJsonSchemaDocument(schema).schema).toEqual(JSON.parse(JSON.stringify(nativeTaskInputSchemas[name])))
  }
  for (const input of [{ prompt: "x", run_in_background: false }, { prompt: "x", run_in_background: true }, { tasks: [{ prompt: "x", run_in_background: false }] }]) {
    expect(await Schema.decodeUnknownPromise(nativeTaskPublicInput("task"))(input)).toBe(input)
  }
  await expect(Schema.decodeUnknownPromise(nativeTaskPublicInput("task"))({ isolated: "true" })).rejects.toThrow()
  await expect(Schema.decodeUnknownPromise(nativeTaskPublicInput("task"))({ run_in_background: "false" })).rejects.toThrow()
})

test("unit public callback uses real kernel issuance, canonical Native start and owner.output", async () => {
  const f = unitFixture(), component = createNativeTaskBridge(f.options)
  await component.ready
  const result = await f.call("task", { prompt: "work", subagent_type: "worker", run_in_background: true, load_skills: ["known"], task_summary: "s".repeat(110) })
  expect(f.starts).toHaveLength(1)
  expect(f.starts[0]).toMatchObject({ prompt: "KNOWN SKILL\nwork", parent_session_id: "unit-parent", run_in_background: true, task_summary: "s".repeat(77) + "..." })
  expect(defined(result.metadata).native.details.task_id).toBe("unit-child")
  expect(f.events.indexOf("permission")).toBeLessThan(f.events.indexOf("forCall"))
  expect(f.events.indexOf("authorize")).toBeLessThan(f.events.indexOf("operation"))
  const output = await f.call("task_output", { task_id: "missing" })
  expect(defined(output.metadata).native.details.kind).toBe("not_found")
  expect(f.starts).toHaveLength(1)
  await component.close()
  expect(f.events.indexOf("service:close")).toBeLessThan(f.events.indexOf("release"))
})

test("canonical normalization precedes strict public validation; malformed isolation never reaches manager", async () => {
  const f = unitFixture(), component = createNativeTaskBridge(f.options); await component.ready
  const result = await f.call("task", { prompt: 42 })
  expect(defined(result.metadata).native.details.status).toBe("invalid_arguments")
  await expect(f.call("task", { isolated: "true" })).rejects.toThrow()
  expect(f.starts).toHaveLength(0); await component.close()
})

test("collision update uses actual ID and clears inherited output/options; close owns registrations", async () => {
  const initial = { id: "builtin-opaque-47", name: "task", description: "old", input: Schema.Unknown, output: Schema.String, options: { permission: "old" }, execute: async () => ({}) } satisfies ListedTool
  const f = unitFixture([initial]), component = createNativeTaskBridge(f.options); await component.ready
  expect(f.events).toContain("update:builtin-opaque-47")
  expect(f.entries.filter(entry => entry.name === "task")).toHaveLength(1)
  expect(defined(f.entries[0]).output).toBeUndefined(); expect(defined(f.entries[0]).options).toBeUndefined()
  await component.close()
  expect(f.events).toContain("dispose:transform"); expect(f.events).toContain("dispose:hook")
  expect(f.events.some(event => event.startsWith("remove:"))).toBe(false)
})

test("ambiguous collision rejects before editor mutation and acquired hook rolls back on owned close", async () => {
  const tool = { name: "task", description: "old", input: Schema.Unknown, execute: async () => ({}) }
  const f = unitFixture([{ ...tool, id: "one" }, { ...tool, id: "two" }]), component = createNativeTaskBridge(f.options)
  await expect(component.ready).rejects.toThrow("Ambiguous")
  expect(f.events.some(event => /^(add|update):/.test(event))).toBe(false)
  await component.close(); expect(f.events).toContain("dispose:hook"); expect(f.events).toContain("release")
})

test("close joins original pre-bind parent lookup before closing service and refuses new callbacks", async () => {
  const f = unitFixture(), gate = deferred<void>(), component = createNativeTaskBridge(f.options)
  await component.ready; f.setParentGate(gate.promise)
  const action = f.call("task", { prompt: "work", subagent_type: "worker", run_in_background: true })
  await tick(); const closing = component.close(); await tick()
  expect(f.events).toContain("parent:begin"); expect(f.events).not.toContain("service:close")
  gate.resolve(); await expect(action).rejects.toThrow("closing"); await closing
  expect(f.starts).toHaveLength(0)
  expect(f.events.indexOf("parent:end")).toBeLessThan(f.events.indexOf("service:close"))
  await expect(f.call("task_output", {})).rejects.toThrow("closing")
})

test("close joins original acquisition and disposes a late owner without registration", async () => {
  const f = unitFixture(), gate = deferred<void>(); f.setAcquisitionGate(gate.promise)
  const component = createNativeTaskBridge(f.options); await tick()
  let done = false; const closing = component.close().then(() => { done = true }); await tick()
  expect(done).toBe(false); expect(f.events).not.toContain("release")
  gate.resolve(); await expect(component.ready).rejects.toThrow("closing"); await closing
  expect(f.events).not.toContain("hook"); expect(f.events).toContain("service:close"); expect(f.events).toContain("release")
})

test("falsey registration cleanup failure retains custody and retry really disposes again", async () => {
  const f = unitFixture(), component = createNativeTaskBridge(f.options); await component.ready; f.failDisposal()
  let thrown: unknown; try { await component.close() } catch (error) { thrown = error }
  expect(thrown).toBeInstanceOf(AggregateError); if (!(thrown instanceof AggregateError)) throw Error("expected AggregateError"); expect(thrown.errors).toContain(false)
  expect(f.events).not.toContain("release"); await component.close()
  expect(f.events.filter(event => event === "dispose:transform")).toHaveLength(2)
  expect(f.events).toContain("release")
})

test("falsey service/release failure cannot mark closed and each retained owner retries", async () => {
  for (const phase of ["service", "release"] as const) {
    const f = unitFixture(), component = createNativeTaskBridge(f.options); await component.ready
    if (phase === "service") f.failService(); else f.failRelease()
    await expect(component.close()).rejects.toBeInstanceOf(AggregateError)
    await component.close()
    expect(f.events.filter(event => event === (phase === "service" ? "service:close" : "release"))).toHaveLength(2)
  }
})

test("foreground progress uses SDK metadata envelope; actual Tool.Error survives canonical failure and kernel", async () => {
  const f = unitFixture(), waiting = deferred<unknown>(); f.waitFor(waiting)
  const component = createNativeTaskBridge(f.options); await component.ready
  const action = f.call("task", { prompt: "work", subagent_type: "worker", run_in_background: false })
  await f.waitEntered
  expect(f.updates).toHaveLength(1)
  expect(f.updates[0]).toMatchObject({ nativeTask: { details: { task_id: "unit-child", run_in_background: false } } })
  const failure = new ToolError({ message: "actual public Tool.Error", metadata: { exact: true } })
  waiting.reject(failure)
  await expect(action).rejects.toBe(failure)
  expect(f.events).toContain("unsubscribe")
  await component.close()
})

test("close stops service before joining a foreground callback that requires service stop", async () => {
  const f = unitFixture(), waiting = deferred<unknown>(); f.waitFor(waiting, true)
  const component = createNativeTaskBridge(f.options); await component.ready
  const action = f.call("task", { prompt: "work", subagent_type: "worker", run_in_background: false })
  await f.waitEntered; expect(f.events).toContain("operation")
  const close = component.close()
  await expect(action).rejects.toThrow("unit service stopped"); await close
  expect(f.events.indexOf("service:close")).toBeLessThan(f.events.indexOf("unsubscribe"))
  expect(f.events.indexOf("unsubscribe")).toBeLessThan(f.events.indexOf("release"))
})

test("falsey failed acquisition retains rollback custody and failed rollback remains retryable", async () => {
  const f = unitFixture(), acquisition = deferred<void>(); f.setAcquisitionGate(acquisition.promise)
  const component = createNativeTaskBridge(f.options); f.failRollback()
  acquisition.reject(0); await expect(component.ready).rejects.toBe(0)
  await expect(component.close()).rejects.toBeInstanceOf(AggregateError)
  expect(f.events).not.toContain("release")
  await component.close(); expect(f.events.filter(event => event === "rollback")).toHaveLength(2)
})

test("missing editor update and mismatched internal target cannot silently advertise the Native adapter", async () => {
  const existing = { id: "actual-builtin", name: "task", description: "old", input: Schema.Unknown, output: Schema.String, execute: async () => ({}) }
  const f = unitFixture([existing]); f.editor.update = () => {}
  const component = createNativeTaskBridge(f.options)
  await expect(component.ready).rejects.toThrow("replacement failed"); await component.close()
  const g = unitFixture(), original = g.options.acquire
  g.options.acquire = async (...args) => {
    const value = await original(...args)
    value.registry.replace([{ id: "foreign", name: "task", description: "foreign", input: Schema.Unknown, execute: async () => ({}) }])
    return value
  }
  const invalid = createNativeTaskBridge(g.options)
  await expect(invalid.ready).rejects.toThrow("exact canonical targets"); await invalid.close()
  expect(g.events).not.toContain("hook")
})

test("new Native permission mode rejects a different actual service and missing original association before registration",async()=>{
 for(const wrongOwner of [false,true])await withNativeTargetPermissionService(async({service,registry,kernel,f})=>{
  const protocol=unitFixture();protocol.options.acquire=async targets=>{
   const targetPermissions=targets.tools.map(tool=>({tool,permission:service.targetPermission(tool)}))
   registry.replace(targets.tools,targets.codecs,targets.normalizers,targetPermissions)
   return{registry,kernel,service:wrongOwner?f.service:service,...(wrongOwner?{targetPermissions}:{}),context:()=>({cwd:f.dir,sessionManager:{getSessionId:()=>"unit-parent"}}),taskDependencies:()=>({}),outputDependencies:()=>({stateDir:f.dir}),async release(){}}
  }
  const bridge=createNativeTaskBridge(protocol.options)
  try{await expect(bridge.ready).rejects.toThrow(wrongOwner?"Foreign Native task permission owner":"association differs");expect(protocol.events).not.toContain("hook")}finally{await bridge.close()}
 })
})

type SkillAssert = { readonly sessionID: string; readonly agent?: string; readonly action: string; readonly resources: readonly string[]; readonly source?: { readonly type: "tool"; readonly messageID: string; readonly id: string } }
type SkillCatalog = Awaited<ReturnType<NativeTaskPreparationOptions["skills"]["list"]>>

/** UNIT SDK domain behind the GENUINE joined permission owner (real Effect fibers, real AssertInput codec). */
async function joinedSkillPermission(decide: (request: SkillAssert) => Effect.Effect<void, unknown> = () => Effect.void) {
  const scope = Scope.makeUnsafe(), requests: SkillAssert[] = []
  const api = await Effect.runPromise(Effect.provideService(acquireEffectPermissionApi({ assert: request => {
    requests.push(request); return decide(request) as Effect.Effect<void, ToolError>
  } }), Scope.Scope, scope))
  return { api, requests, skillRequests: () => requests.filter(request => request.action === "skill"),
    async close() { await api.close(); await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))) } }
}

/** The REAL preparation over a UNIT SDK skill catalog; the live catalog may be changed after the snapshot. */
async function preparedWithSkills(permission: JoinedPermissionApi) {
  const home = resolve("virtual-native-task-skill-home"), cwd = join(home, "project"), user = join(home, ".omo", "omo.jsonc")
  const config = { task: { default_execution_mode: "in-process" }, memory: { enabled: false }, disabled_skills: ["disabled"] }
  let catalog: SkillCatalog = { location: { directory: cwd }, data: [
    { id: "alpha-id", name: "alpha", path: join(home, "skills", "alpha", "SKILL.md"), content: "ALPHA CONTENT" },
    { id: "skill-beta-7", name: "beta", path: join(home, "skills", "beta", "SKILL.md"), content: "BETA CONTENT" },
    { id: "disabled-id", name: "disabled", path: join(home, "skills", "disabled", "SKILL.md"), content: "DISABLED CONTENT" },
  ] } as SkillCatalog
  let lists = 0
  const empty = { location: { directory: cwd }, data: [] }
  const options = { cwd, permission, signal: new AbortController().signal, assertCurrent() {},
    models: { model: { async list() { return empty } }, provider: { async list() { return empty } } },
    skills: { async list() { lists++; return structuredClone(catalog) } },
    canonical: {
      resolveTaskAgents: () => ({ worker: { name: "worker", prompt: "unit worker" } }),
      buildSkillPrepend: (selected: readonly { readonly name: string; readonly content: string }[], prompt: string) => selected.map(skill => `<${skill.name}>${skill.content}</${skill.name}>\n`).join("") + prompt,
    },
    configOptions: { env: { HOME: home }, platform: "linux", fileSystem: {
      existsSync: (path: string) => path === user,
      readFileSync: (path: string) => { if (path !== user) throw Error("Virtual config only"); return JSON.stringify(config) },
    } },
  } as unknown as NativeTaskPreparationOptions
  const prepared = await prepareNativeTaskRuntime(options)
  return { prepared, cwd, lists: () => lists, replaceCatalog(change: (value: SkillCatalog) => SkillCatalog) { catalog = change(structuredClone(catalog)) } }
}

async function skillBridge(decide?: (request: SkillAssert) => Effect.Effect<void, unknown>) {
  const permission = await joinedSkillPermission(decide), real = await preparedWithSkills(permission.api)
  const f = unitFixture([], "ses_unit_parent"); f.setCwd(real.cwd)
  const component = createNativeTaskBridge({ ...f.options, prepared: real.prepared })
  await component.ready
  return { f, permission, real, component, async close() { await component.close(); await permission.close() } }
}

describe("#given task load_skills reaching an owned child", () => {
  test("#when one allowed skill is requested #then the genuine caller asserts its SDK id before the child receives content", async () => {
    // given
    const unit = await skillBridge()
    try {
      // when
      await unit.f.call("task", { prompt: "work", subagent_type: "worker", run_in_background: true, load_skills: ["alpha"] })
      // then
      expect(unit.f.starts).toHaveLength(1)
      expect(unit.f.starts[0]).toMatchObject({ prompt: "<alpha>ALPHA CONTENT</alpha>\nwork" })
      expect(unit.permission.skillRequests()).toEqual([{ sessionID: "ses_unit_parent", agent: "unit-agent", action: "skill", resources: ["alpha-id"],
        source: { type: "tool", messageID: "unit-message", id: "unit-call" } }])
    } finally { await unit.close() }
  })

  test("#when the display name differs from the SDK id #then the assert uses the id and the name is never a resource", async () => {
    // given
    const unit = await skillBridge()
    try {
      // when
      await unit.f.call("task", { prompt: "work", subagent_type: "worker", run_in_background: true, load_skills: ["beta"] })
      // then
      expect(unit.permission.skillRequests().map(request => request.resources)).toEqual([["skill-beta-7"]])
      expect(unit.f.starts[0]).toMatchObject({ prompt: "<beta>BETA CONTENT</beta>\nwork" })
    } finally { await unit.close() }
  })

  test("#when one of two skill ids is denied #then the whole task is refused with the permission error and no child is staged", async () => {
    // given
    const denial = new ToolError({ message: "skill denied by rule" })
    const unit = await skillBridge(request => request.resources[0] === "skill-beta-7" ? Effect.fail(denial) : Effect.void)
    try {
      // when
      const work = unit.f.call("task", { prompt: "work", subagent_type: "worker", run_in_background: true, load_skills: ["alpha", "beta"] })
      // then
      await expect(work).rejects.toBe(denial)
      expect(unit.permission.skillRequests().map(request => request.resources)).toEqual([["alpha-id"], ["skill-beta-7"]])
      expect(unit.f.starts).toHaveLength(0)
    } finally { await unit.close() }
  })

  test("#when batch items overlap and inherit skills #then each SDK id is asserted exactly once for the call", async () => {
    // given
    const unit = await skillBridge()
    try {
      // when
      await unit.f.call("task", { subagent_type: "worker", run_in_background: true, load_skills: ["alpha"], tasks: [
        { prompt: "one", load_skills: ["beta", "alpha"] }, { prompt: "two", load_skills: ["beta"] }, { prompt: "three" },
      ] })
      // then
      expect(unit.permission.skillRequests().map(request => request.resources)).toEqual([["skill-beta-7"], ["alpha-id"]])
      expect(unit.f.starts.map(spec => (spec as { prompt: string }).prompt).sort()).toEqual([
        "<alpha>ALPHA CONTENT</alpha>\nthree", "<beta>BETA CONTENT</beta>\n<alpha>ALPHA CONTENT</alpha>\none", "<beta>BETA CONTENT</beta>\ntwo",
      ])
    } finally { await unit.close() }
  })

  test("#when the host catalog remaps the name to another id while its assert is pending #then the post-assert recheck fails closed", async () => {
    // given
    let remap = () => {}
    const unit = await skillBridge(() => Effect.sync(() => remap()))
    remap = () => unit.real.replaceCatalog(catalog => ({ ...catalog, data: catalog.data.map(skill => skill.name === "beta" ? { ...skill, id: "replacement-id" } : skill) }) as SkillCatalog)
    try {
      // when
      const work = unit.f.call("task", { prompt: "work", subagent_type: "worker", run_in_background: true, load_skills: ["beta"] })
      // then
      await expect(work).rejects.toThrow("Host skill identity changed during authorization: beta")
      expect(unit.permission.skillRequests().map(request => request.resources)).toEqual([["skill-beta-7"]])
      expect(unit.f.starts).toHaveLength(0)
    } finally { await unit.close() }
  })

  test("#when a project skill is discovered after registration #then the task asserts and delivers it at call time", async () => {
    // given
    const unit = await skillBridge()
    unit.real.replaceCatalog(catalog => ({ ...catalog, data: [...catalog.data, { id: "project-late-id", name: "late", path: join(unit.real.cwd, ".opencode", "skills", "late", "SKILL.md"), content: "LATE CONTENT" }] }) as SkillCatalog)
    try {
      // when
      await unit.f.call("task", { prompt: "work", subagent_type: "worker", run_in_background: true, load_skills: ["late"] })
      // then
      expect(unit.permission.skillRequests().map(request => request.resources)).toEqual([["project-late-id"]])
      expect(unit.f.starts[0]).toMatchObject({ prompt: "<late>LATE CONTENT</late>\nwork" })
    } finally { await unit.close() }
  })

  test("#when no load_skills are requested #then no skill permission is asserted and the child still starts", async () => {
    // given
    const unit = await skillBridge()
    try {
      // when
      await unit.f.call("task", { prompt: "work", subagent_type: "worker", run_in_background: true })
      // then
      expect(unit.permission.skillRequests()).toHaveLength(0)
      expect(unit.real.lists()).toBe(1)
      expect(unit.f.starts[0]).toMatchObject({ prompt: "work" })
    } finally { await unit.close() }
  })

  test("#when only disabled or missing names are requested #then nothing is asserted and Native resolution data is kept", async () => {
    // given
    const unit = await skillBridge()
    try {
      // when
      await unit.f.call("task", { prompt: "work", subagent_type: "worker", run_in_background: true, load_skills: ["disabled", "absent"] })
      // then
      expect(unit.permission.skillRequests()).toHaveLength(0)
      expect(unit.f.starts[0]).toMatchObject({ prompt: "work", skills: { missing: ["absent"] } })
    } finally { await unit.close() }
  })

  test("#when the caller aborts while the skill assert is pending #then the call rejects with the abort reason and no child is staged", async () => {
    // given
    const unit = await skillBridge(() => Effect.never)
    const reason = Error("caller aborted during skill permission")
    try {
      // when
      const work = unit.f.call("task", { prompt: "work", subagent_type: "worker", run_in_background: true, load_skills: ["alpha"] })
      for (let turn = 0; turn < 50 && unit.permission.skillRequests().length === 0; turn++) await new Promise(done => setTimeout(done, 1))
      expect(unit.permission.skillRequests()).toHaveLength(1)
      unit.f.abortCaller(reason)
      // then
      await expect(work).rejects.toBe(reason)
      expect(unit.f.starts).toHaveLength(0)
    } finally { await unit.close() }
  })
})
function defined<T>(value: T | null | undefined): T { if (value === undefined || value === null) throw new Error("expected a defined value"); return value }
