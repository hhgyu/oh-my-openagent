import { OmoTaskSettingsSchema } from "@oh-my-opencode/omo-config-core"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "bun:sqlite"
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { acquireEffectToolMetadataSource } from "../../host/effect-tool-metadata-source"
import { createSessionScopes } from "../../host/session-state"
import { withJoinedSessionCancellation } from "../../host/session-cancellation"
import { createNativeOwnedTaskRuntime } from "./runtime"
import { ChildObservationUncertain } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { OwnedTaskHost } from "./owned-runner"
import { createOwnedTaskRecovery } from "./owned-recovery"
import { prepareHostTaskGrant } from "./host-grant"
import { filterSharedParentTools } from "@oh-my-opencode/senpi-task/task-operations"

type RuntimeOverrides = Partial<Pick<Parameters<typeof createNativeOwnedTaskRuntime>[1], "authorizePlannedStart" | "authorizeRecovery" | "config" | "childToolGuard" | "childGuardBinding" | "captureStartAuthority" | "locationReleased">>
type PlannedStartArgs = Parameters<NonNullable<RuntimeOverrides["authorizePlannedStart"]>>
function defined<T>(value: T | null | undefined): T { if (value === undefined || value === null) throw new Error("Expected value to be defined in controlled fixture"); return value }
/** Controlled protocol fixture only; real harness acceptance is a separate actual2.2.6 driver. */
async function fixture(run: (runtime: Awaited<ReturnType<typeof createNativeOwnedTaskRuntime>>, state: { calls: string[]; contexts: unknown[]; createdAgents: string[]; holdUpdate(): void; updateEntered: Promise<void>; releaseUpdate(): void; failChildGetOnce(): void; failRemoveOnce(): void; receiptEntered: Promise<void>; releaseReceipt(): void; removeEntered: Promise<void>; holdRemove(): void; releaseRemove(): void; breakObservation(): void; callerAbort: AbortController; useStartSignal(signal:AbortSignal): void; createEntered: Promise<void>; holdCreate(): void; releaseCreate(): void; hostWaitEntered: Promise<void>; holdHostWait(): void; releaseHostWait(): void; policyActive(): boolean; hostActive(): boolean; inputEntered: Promise<void>; drainEvents(): Promise<void>; holdInputAck(): void; releaseInputAck(): void; finishFrame(sessionID: string): void; emit(type: string, sessionID: string, data?: object): void; session(sessionID: string): unknown; changeSession(sessionID: string, patch: object): void; removeByHost(sessionID: string): void; onUpdate(hook: (input: { sessionID: string; permissions?: unknown; metadata?: unknown }) => void | Promise<void>): void; reopen(overrides?: RuntimeOverrides): Promise<Awaited<ReturnType<typeof createNativeOwnedTaskRuntime>>>; openAlongside(overrides?: RuntimeOverrides): Promise<Awaited<ReturnType<typeof createNativeOwnedTaskRuntime>>>; hostShutdownOrdering(): void; flushDeferredInterrupts(): void; endTeardown(): void }) => Promise<void>, optionalRuntime: RuntimeOverrides = {}, unitContextTools: readonly string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "omo-task-runtime-unit-")), scopes = createSessionScopes(), calls: string[] = [], contexts: unknown[] = []
  const parentID = "parent" as ToolContext["sessionID"], policy = { tools: [] as string[], authorize() {} }
  const parent = scopes.open(parentID, policy), sessions = new Map<string, unknown>([[parentID, { id: parentID, location: { directory: dir } }]]), queue: unknown[] = []
  const callerAbort = new AbortController(), createEntered = Promise.withResolvers<void>(), createGate = Promise.withResolvers<void>()
  const createdAgents: string[] = []
  let startSignal=callerAbort.signal
  let heldCreate = false
  let heldUpdate=false;const updateEntered=Promise.withResolvers<void>(),updateGate=Promise.withResolvers<void>()
  let seq = 0, ended = false, wake: ((value: IteratorResult<unknown>) => void) | undefined
  const streams=new Set<{queue:unknown[];wake?: (value:IteratorResult<unknown>)=>void;ended:boolean}>()
  const receipt = Promise.withResolvers<void>(), receiptEntered = Promise.withResolvers<void>(), removeEntered = Promise.withResolvers<void>(), removeGate = Promise.withResolvers<void>()
  let heldRemove = false, failRemoval = false, failChildGet = false
  const inputEntered = Promise.withResolvers<void>(), inputAck = Promise.withResolvers<void>()
  let heldInput = false
  const initialEnded = new Set<string>()
  const drained = new Set<() => void>()
  const hostWaitEntered=Promise.withResolvers<void>(),hostWaitGate=Promise.withResolvers<void>();let heldHostWait=false
  // OpenCode 2.2.6 location shutdown: a host wait on an interrupted step's session returns only after the
  // plugin's location is released, and the interrupt's outcome event arrives during that teardown.
  let shutdownOrdering=false;const deferredInterrupts:string[]=[],teardownHeld=new Set<string>(),teardownWaiters=new Set<()=>void>()
  const blocked = new Set<string>()
  // Sessions the host itself removed (OpenCode removes a removed lead's children with it):
  // every later call names them with the host's own tagged not-found failure.
  const removedByHost = new Set<string>()
  const assertPresent = (sessionID: string) => { if (removedByHost.has(sessionID)) throw Object.assign(new Error(`Session not found: ${sessionID}`), { _tag: "Session.NotFoundError", sessionID }) }
  const hooks = new Map<string, (value: unknown) => unknown>()
  let updateHook: ((input: { sessionID: string; permissions?: unknown; metadata?: unknown }) => void | Promise<void>) | undefined
  function emit(type: string, sessionID: string, data: object = {}) {
    const value = { id: `event:${seq}`, created: seq, type, durable: { aggregateID: sessionID, seq: seq++, version: 1 }, data: { sessionID, ...data } }
    for(const stream of streams){if(stream.ended)continue;if(stream.wake){const yes=stream.wake;stream.wake=undefined;yes({done:false,value})}else stream.queue.push(value)}
  }
  const api = {
    async create(input: { id: string; parentID?: string; location?: unknown; agent: string }) { calls.push("create"); createdAgents.push(input.agent); const value = { id: input.id, parentID: input.parentID, location: input.location, agent: input.agent }; sessions.set(input.id, value); if (heldCreate) { createEntered.resolve(); await createGate.promise }; return value },
    async get({ sessionID }: { sessionID: string }) { calls.push("get"); assertPresent(sessionID); if(sessionID!==parentID&&failChildGet){failChildGet=false;throw Error("controlled transient child lookup")}; if (!sessions.has(sessionID)) throw Error("Missing controlled session"); return sessions.get(sessionID) },
    async list() { return { data: [...sessions.values()], cursor: {} } },
    async hook(name: string, callback: (value: unknown) => unknown) { hooks.set(name, callback); return { dispose() { if(name==="context")calls.push("policy-disposed");hooks.delete(name) } } },
    async update(input: { sessionID: string; permissions?: unknown; metadata?: unknown },options?:{signal?:AbortSignal}) { assertPresent(input.sessionID); if(heldUpdate){updateEntered.resolve();await new Promise<void>((yes,no)=>{const signal=options?.signal;const stop=()=>{signal?.removeEventListener("abort",stop);no(signal?.reason)};signal?.addEventListener("abort",stop,{once:true});updateGate.promise.then(()=>{signal?.removeEventListener("abort",stop);yes()},no);if(signal?.aborted)stop()})};await updateHook?.(input)
      // Controlled host semantics: own-session permissions/metadata are replaced as sent.
      const session = sessions.get(input.sessionID) as Record<string, unknown> | undefined
      if (session && input.permissions) { calls.push("park-update"); session.permissions = structuredClone(input.permissions) }
      if (session && input.metadata) session.metadata = structuredClone(input.metadata)
      emit("session.renamed", input.sessionID) },
    async prompt(input: { id: string; sessionID: string; delivery?: string; text: string }, options?: { signal?: AbortSignal }) {
      calls.push("prompt")
      if (input.id.startsWith("msg_omo_")) {
        calls.push(`input:${input.delivery}`)
        if(!blocked.has(input.sessionID)){emit("session.execution.started",input.sessionID);blocked.add(input.sessionID);initialEnded.add(input.sessionID)}
        if (!initialEnded.has(input.sessionID)) { initialEnded.add(input.sessionID); emit("session.step.ended", input.sessionID, { assistantMessageID: "assistant", finish: "tool-calls" }) }
        emit("session.inbox.delivered", input.sessionID, { inboxID: input.id })
        inputEntered.resolve()
        if (heldInput) await new Promise<void>((yes, no) => {
          const signal=options?.signal
          const abort=()=>{signal?.removeEventListener("abort",abort);calls.push("input-abort-joined");no(signal?.reason)}
          signal?.addEventListener("abort",abort,{once:true})
          inputAck.promise.then(()=>{signal?.removeEventListener("abort",abort);yes()},no)
          if(signal?.aborted)abort()
        })
        if (input.text.includes("lose-input-ack")) throw Error("Controlled continuation ACK lost")
        return { id: input.id, sessionID: input.sessionID }
      }
      const context = { sessionID: input.sessionID, system: [], tools: Object.fromEntries(unitContextTools.map(name => [name, { description: "Controlled UNIT tool", input: { type: "object" } }])) }; await hooks.get("context")?.(context); contexts.push(context)
      emit("session.execution.started", input.sessionID); emit("session.inbox.delivered", input.sessionID, { inboxID: input.id })
      const assistantMessageID = "assistant"
      emit("session.step.started", input.sessionID, { assistantMessageID, model: { providerID: "qa", id: "model" } })
      if (input.text.includes("block-until-interrupt")) { blocked.add(input.sessionID); return { id: input.id, sessionID: input.sessionID } }
      emit("session.text.started", input.sessionID, { assistantMessageID, ordinal: 0 }); emit("session.text.ended", input.sessionID, { assistantMessageID, ordinal: 0, text: "controlled actual step" })
      emit("session.step.ended", input.sessionID, { assistantMessageID, finish: "stop" }); emit("session.execution.succeeded", input.sessionID)
      if (input.text.includes("lose-ack")) throw Error("Controlled admission receipt lost")
      if (input.text.includes("hold-ack")) { receiptEntered.resolve(); await receipt.promise }
      return { id: input.id, sessionID: input.sessionID }
    },
    async interrupt({ sessionID }: { sessionID: string }) { calls.push("interrupt"); assertPresent(sessionID); if (blocked.delete(sessionID)) { if (shutdownOrdering) { deferredInterrupts.push(sessionID); teardownHeld.add(sessionID); return { interrupted: true } }; if (!initialEnded.has(sessionID)) emit("session.step.failed", sessionID, { assistantMessageID: "assistant", error: { type: "aborted" } }); emit("session.execution.interrupted", sessionID); return { interrupted: true } }; return { interrupted: false } }, async wait({ sessionID }: { sessionID: string }, options?: { signal?: AbortSignal }) { calls.push("host-wait"); assertPresent(sessionID);hostWaitEntered.resolve();if(heldHostWait)await hostWaitGate.promise
      if (teardownHeld.has(sessionID)) await new Promise<void>((resolve, reject) => { const done = () => { teardownWaiters.delete(done); resolve() }; teardownWaiters.add(done); const signal = options?.signal; if (!signal) return; if (signal.aborted) { teardownWaiters.delete(done); reject(signal.reason); return }; signal.addEventListener("abort", () => { teardownWaiters.delete(done); reject(signal.reason) }, { once: true }) }) },
    async remove(input: { sessionID: string }) { calls.push("remove"); assertPresent(input.sessionID); if (heldRemove) { removeEntered.resolve(); await removeGate.promise }; if(failRemoval){failRemoval=false;throw Error("Controlled actual remove failure")}; sessions.delete(input.sessionID) },
    async context() { return {} }, instructions: { entry: { async list() { return [] }, async put() {}, async remove() {} } },
  }
  withJoinedSessionCancellation(api, "controlled-test")
  const ctx = { app: { version: "2.2.6" }, location: { directory: dir }, session: api,
    model: { async list() { return { data: [{ providerID: "qa", id: "model", modelID: "model", name: "model", type: "chat", status: "active", enabled: true, variants: [], capabilities: { tools: true, input: ["text"], output: ["text"] }, limit: { context: 32000, output: 1000 } }] } } },
    provider: { async list() { return { data: [{ id: "qa", activation: "enabled" }] } } },
    event: { subscribe({signal}:{signal:AbortSignal}){const stream:{queue:unknown[];wake?:(value:IteratorResult<unknown>)=>void;ended:boolean}={queue:[],ended:false};streams.add(stream);signal.addEventListener("abort",()=>{stream.ended=true;stream.wake?.({done:true,value:undefined});stream.wake=undefined;streams.delete(stream)},{once:true});return {[Symbol.asyncIterator](){return {async next(){if(stream.queue.length)return {done:false,value:stream.queue.shift()};if(stream.ended||ended)return {done:true,value:undefined};if([...streams].every(x=>x===stream||x.queue.length===0&&!!x.wake)){for(const done of drained)done();drained.clear()}return new Promise<IteratorResult<unknown>>(resolve=>{stream.wake=resolve})}}}}} },
  } as unknown as OwnedTaskHost
  try {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const metadataSource = yield* acquireEffectToolMetadataSource({ hook: () => Effect.void } as never)
      // reopen models a plugin reload: SAME state directory and host sessions, a new runtime.
      const make = (overrides: RuntimeOverrides) => { const merged = { ...optionalRuntime, ...overrides }; return createNativeOwnedTaskRuntime(ctx, { ...merged, stateDir: join(dir, "state"), scopes, parent, policy, metadataSource, captureStartAuthority:merged.captureStartAuthority ?? (()=>{const signal=startSignal;return {admissionSignal:AbortSignal.any([signal,parent.signal]),lifetimeSignal:parent.signal,assertAdmission(){signal.throwIfAborted();scopes.assert(parent)},assertLifetime(){scopes.assert(parent)}}}), config: merged.config ?? (() => ({ categories: { qa: { model: "qa/model" } }, task: OmoTaskSettingsSchema.parse({ max_depth: 2 }) })), agents: {} }) }
      let runtime = yield* Effect.promise(() => make({}))
      const superseded: (typeof runtime)[] = []
      yield* Effect.addFinalizer(() => Effect.promise(async () => { await runtime.close(); for (const previous of superseded) await previous.close() }))
      yield* Effect.promise(() => run(runtime, { callerAbort,useStartSignal:signal=>{startSignal=signal}, createEntered: createEntered.promise, holdCreate: () => { heldCreate = true }, releaseCreate: () => createGate.resolve(), emit, calls, contexts, createdAgents, holdUpdate:()=>{heldUpdate=true},updateEntered:updateEntered.promise,releaseUpdate:()=>updateGate.resolve(),failChildGetOnce:()=>{failChildGet=true}, failRemoveOnce:()=>{failRemoval=true}, receiptEntered: receiptEntered.promise, releaseReceipt: () => receipt.resolve(), removeEntered: removeEntered.promise, holdRemove: () => { heldRemove = true }, releaseRemove: () => removeGate.resolve(), hostWaitEntered: hostWaitEntered.promise, holdHostWait:()=>{heldHostWait=true},releaseHostWait:()=>hostWaitGate.resolve(),policyActive:()=>hooks.has("context"),hostActive:()=>blocked.size>0,inputEntered: inputEntered.promise, drainEvents: () => [...streams].every(x=>x.queue.length===0&&!!x.wake) ? Promise.resolve() : new Promise<void>(yes=>drained.add(yes)), holdInputAck: () => { heldInput = true }, releaseInputAck: () => inputAck.resolve(), finishFrame(sessionID) {
        if(!initialEnded.has(sessionID)){initialEnded.add(sessionID);emit("session.step.ended",sessionID,{assistantMessageID:"assistant",finish:"tool-calls"})}
        emit("session.step.started",sessionID,{assistantMessageID:"assistant-final",model:{providerID:"qa",id:"model"}})
        emit("session.text.started",sessionID,{assistantMessageID:"assistant-final",ordinal:0});emit("session.text.ended",sessionID,{assistantMessageID:"assistant-final",ordinal:0,text:"after managed inputs"})
        emit("session.step.ended",sessionID,{assistantMessageID:"assistant-final",finish:"stop"});emit("session.execution.succeeded",sessionID);blocked.delete(sessionID)
      }, session: sessionID => structuredClone(sessions.get(sessionID)), changeSession: (sessionID, patch) => { const session = sessions.get(sessionID); if (session) Object.assign(session, patch) },
      removeByHost: sessionID => { sessions.delete(sessionID); removedByHost.add(sessionID); blocked.delete(sessionID) },
      onUpdate: hook => { updateHook = hook }, reopen: async (overrides = {}) => { await runtime.close(); runtime = await make(overrides); return runtime },
      // An in-process reload the host has not closed yet: the next runtime opens while the current one stays open.
      openAlongside: async (overrides = {}) => { superseded.push(runtime); runtime = await make(overrides); return runtime },
      hostShutdownOrdering: () => { shutdownOrdering = true },
      // The interrupted executions settle once the plugin's close has returned: host waits on them return.
      endTeardown: () => { shutdownOrdering = false; teardownHeld.clear(); for (const done of [...teardownWaiters]) done() },
      flushDeferredInterrupts: () => { for (const sessionID of deferredInterrupts.splice(0)) { if (!initialEnded.has(sessionID)) emit("session.step.failed", sessionID, { assistantMessageID: "assistant", error: { type: "aborted" } }); emit("session.execution.interrupted", sessionID) } }, breakObservation: () => { ended=true;for(const stream of streams){stream.ended=true;stream.wake?.({done:true,value:undefined});stream.wake=undefined} } }))
    }))).catch(error => { console.error("RUNTIME_FIXTURE_ERROR", error); throw error })
  } finally { scopes.dispose(); rmSync(dir, { recursive: true, force: true }) }
}

test("same Native manager category reaches real Native record store and existing own-log output", async () => {
  await fixture(async (runtime, state) => {
    expect(runtime.manager.constructor.name).toBe("TaskManagerImpl")
    const result = await runtime.start({ category: "qa", prompt: "controlled task" })
    if (result.kind !== "started") throw Error(JSON.stringify(result))
    const record = await runtime.wait(result.task_id, AbortSignal.timeout(2000))
    expect(record.status).toBe("completed"); expect(record.final_response).toBe("controlled actual step")
    expect(record.runner_kind).toBe("owned-session"); expect(record.pid).toBeUndefined()
    expect(record.run_stats).toBeUndefined()
    const output = await runtime.output({ task_id: result.task_id, mode: "full" })
    expect(JSON.stringify(output)).toContain("controlled actual step")
    expect(state.calls.filter(value => value === "create")).toHaveLength(1)
    await runtime.end(result.task_id)
  })
})

test("original Native admission planned denial prevents record and child before any stage", async () => {
  const failure = Error("controlled original planned permission denial"); let checks = 0
  await fixture(async (runtime, state) => {
    const outcome = await runtime.start({ category: "qa", prompt: "must not stage" }).catch(error => error)
    // Current-source RED still joins its actual controlled child before failing.
    if (outcome?.kind === "started") await runtime.wait(outcome.task_id)
    expect(checks).toBe(1)
    expect(outcome).toBe(failure)
    expect(runtime.manager.list({ scope: "all" })).toHaveLength(0)
    expect(state.calls).not.toContain("create")
  }, { authorizePlannedStart: async () => { checks++; throw failure } })
})

function unitPlannedData(spec: Parameters<NonNullable<Parameters<typeof createNativeOwnedTaskRuntime>[1]["authorizePlannedStart"]>>[0], plan: Parameters<NonNullable<Parameters<typeof createNativeOwnedTaskRuntime>[1]["authorizePlannedStart"]>>[1]) {
 return {buildAgentID:"build",authorityIssued:false as const,selection:prepareHostTaskGrant({spec,plan,includeTaskTools:spec.admission?.runRef.kind!=="dag",nativeTools:[{name:"read"}],catalog:[{id:"unit-read",name:"read",options:{codemode:false}}],canonical:{filterSharedParentTools}})}
}

test("original planned work is joined by parent close and cannot publish child after closing",async()=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 await fixture(async(runtime,state)=>{
  const original=runtime.start({category:"qa",prompt:"never create"}).catch(error=>error);await entered.promise
  expect(runtime.manager.list({scope:"all"})).toHaveLength(0);let closed=false
  const closing=runtime.close().then(()=>{closed=true});await new Promise<void>(yes=>setImmediate(yes));expect(closed).toBe(false)
  release.resolve();await original;await closing;expect(state.calls).not.toContain("create")
 },{authorizePlannedStart:async(spec,plan)=>{entered.resolve();await release.promise;return unitPlannedData(spec,plan)}})
})

for(const point of ["subagents","depth","mode"] as const)test(`same admission cannot expand original ${point} policy during approval`,async()=>{
 await fixture(async(runtime,state)=>{
  const result=await runtime.start({category:"qa",prompt:"never create"}).catch(error=>error)
  expect(String(result)).toContain("changed during authorization");expect(state.calls).not.toContain("create");expect(runtime.manager.list({scope:"all"})).toHaveLength(0)
 },{authorizePlannedStart:async(spec,plan)=>{
  const result=unitPlannedData(spec,plan)
  if(point==="subagents")plan.allowedSubagents=["new-child"]
  if(point==="depth")plan.maxDepth=999
  if(point==="mode")plan.agentExecutionMode="process"
  return result
 }})
})

test("model-only Native plan change does not claim or require final model pin",async()=>{
 await fixture(async(runtime,state)=>{
  const result=await runtime.start({category:"qa",prompt:"model coverage"});expect(result.kind).toBe("started")
  if(result.kind==="started")expect((await runtime.wait(result.task_id)).status).toBe("completed")
  expect(state.calls).toContain("create")
 },{authorizePlannedStart:async(spec,plan)=>{const result=unitPlannedData(spec,plan);plan.model="qa/changed-display-route";return result}})
})

for(const mutation of ["subagents","depth","mode"] as const)test(`queued SAME admission rejects ${mutation} expansion at final stage without reauthorization`,async()=>{
 const captured:Array<{spec:PlannedStartArgs[0];plan:PlannedStartArgs[1]}>=[]
 await fixture(async(runtime,state)=>{
  const first=await runtime.start({category:"qa",prompt:"block-until-interrupt",run_in_background:true});if(first.kind!=="started")throw Error("first")
  const second=await runtime.start({category:"qa",prompt:"never stage expanded policy",run_in_background:true});if(second.kind!=="started")throw Error("second")
  expect(state.calls.filter(x=>x==="create")).toHaveLength(1);expect(captured).toHaveLength(2)
  const originalAdmission=defined(captured[1]).spec.admission,originalAuthority=originalAdmission.hostAuthority
  if(mutation==="subagents")defined(captured[1]).plan.allowedSubagents=["new-descendant"]
  if(mutation==="depth")defined(captured[1]).plan.maxDepth=999
  if(mutation==="mode")defined(captured[1]).plan.agentExecutionMode="process"
  await runtime.end(first.task_id)
  const record=await runtime.wait(second.task_id,AbortSignal.timeout(2000))
  expect(record.status).toBe("error");expect(state.calls.filter(x=>x==="create")).toHaveLength(1)
  expect(defined(captured[1]).spec.admission).toBe(originalAdmission);expect(originalAdmission.hostAuthority).toBe(originalAuthority)
  expect(captured).toHaveLength(2)
 },{config:()=>({categories:{qa:{model:"qa/model"}},task:OmoTaskSettingsSchema.parse({max_depth:2,default_concurrency:1})}),authorizePlannedStart:async(spec,plan)=>{captured.push({spec,plan});return unitPlannedData(spec,plan)}})
})

test.each(["cancel", "end", "detach"] as const)("immediate %s fences a queued send before its first host request", async control => {
  await fixture(async (runtime,state)=>{
    const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
    state.holdInputAck()
    const sending=runtime.send({idOrName:start.task_id,message:"late input",deliverAs:"steer"}).catch(error=>error)
    const stopping=runtime[control](start.task_id)
    const witness=await Promise.race([stopping.then(()=>"control-settled"),state.inputEntered.then(()=>"input-dispatched-after-control")])
    // Always join the controlled RED, rather than leave the intentionally held request behind.
    state.releaseInputAck();await sending;await stopping
    expect(witness).toBe("control-settled")
    expect(state.calls.filter(call=>call.startsWith("input:"))).toEqual([])
  })
})

test("active detach aborts the actual pending input before its held ACK is released",async()=>{
  await fixture(async(runtime,state)=>{
    const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
    const before=defined(runtime.get(start.task_id))
    state.holdInputAck();const sending=runtime.send({idOrName:start.task_id,message:"held detach input",deliverAs:"steer"}).catch(error=>error)
    await state.inputEntered
    const detaching=runtime.detach(start.task_id)
    const abortedBeforeRelease=state.calls.includes("input-abort-joined")
    state.releaseInputAck();await sending;await detaching
    expect(abortedBeforeRelease).toBe(true)
    expect(runtime.get(start.task_id)?.status).toBe("running")
    expect(runtime.get(start.task_id)?.residency_state).toBe("persisted_only")
    expect(runtime.get(start.task_id)?.notification.run_epoch).toBe(before.notification.run_epoch)
    expect(state.calls.filter(call=>call==="remove")).toEqual([])
  })
})

test("permanent END after detach closes the real retained child without execution revival",async()=>{
  await fixture(async(runtime,state)=>{
    const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
    await runtime.detach(start.task_id)
    const before=defined(runtime.get(start.task_id))
    expect(before.residency_state).toBe("persisted_only")
    await runtime.end(start.task_id)
    expect(runtime.get(start.task_id)?.status).toBe("cancelled")
    expect(state.calls.filter(call=>call==="create")).toHaveLength(1)
    expect(state.calls.filter(call=>call==="prompt")).toHaveLength(1)
    expect(state.calls.filter(call=>call==="remove")).toHaveLength(1)
    expect(state.contexts).toHaveLength(1)
    await expect(runtime.recover(start.task_id)).rejects.toThrow("not recoverable")
    await runtime.end(start.task_id)
    expect(state.calls.filter(call=>call==="remove")).toHaveLength(1)
  })
})

test("failed retained child removal stays owned and a later END retries actual cleanup without replay",async()=>{
  await fixture(async(runtime,state)=>{
    const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
    await runtime.detach(start.task_id)
    state.failRemoveOnce()
    await expect(runtime.end(start.task_id)).rejects.toThrow("cleanup uncertain")
    expect(state.calls.filter(call=>call==="remove")).toHaveLength(1)
    await runtime.end(start.task_id)
    expect(state.calls.filter(call=>call==="remove")).toHaveLength(2)
    expect(state.calls.filter(call=>call==="create")).toHaveLength(1)
    expect(state.calls.filter(call=>call==="prompt")).toHaveLength(1)
    await runtime.end(start.task_id)
    expect(state.calls.filter(call=>call==="remove")).toHaveLength(2)
  })
})

test("retained cleanup refuses a rebound reference before host effects and keeps execution recovery strict",async()=>{
  await fixture(async(runtime,state)=>{
    const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
    await runtime.detach(start.task_id)
    const original=defined(runtime.store.load(start.task_id)),reference=defined(original.owned_session)
    for(const patch of [{sessionID:"foreign-child"},{location:join(reference.location,"foreign-directory")},{parentID:"foreign-parent"},{hostVersion:"2.2.7"},{backendID:"foreign-backend"}]){
      runtime.store.mutate(start.task_id,current=>({...current,child_session_id:patch.sessionID??reference.sessionID,
        parent_session_id:patch.parentID??reference.parentID,owned_session:{...reference,...patch}}))
      const before=state.calls.length
      await expect(runtime.end(start.task_id)).rejects.toThrow()
      expect(state.calls.length).toBe(before)
      runtime.store.mutate(start.task_id,current=>({...current,child_session_id:reference.sessionID,parent_session_id:reference.parentID,owned_session:reference}))
    }
    runtime.store.mutate(start.task_id,current=>({...current,status:"lost"}))
    await expect(runtime.recover(start.task_id)).rejects.toThrow("not recoverable")
    await runtime.end(start.task_id)
    expect(state.calls.filter(call=>call==="remove")).toHaveLength(1)
    expect(state.calls.filter(call=>call==="prompt")).toHaveLength(1)
  })
})

test("reentrant close before handle input begins cannot miss a queued admission",async()=>{
  await fixture(async(runtime,state)=>{
    const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
    state.holdInputAck()
    const beginSend=runtime.manager.tryBeginSend
    if(!beginSend)throw Error("Native send admission missing")
    const original=beginSend.bind(runtime.manager)
    let closing:Promise<void>|undefined
    let closeCalls=0
    runtime.manager.tryBeginSend=id=>{const answer=original(id);closeCalls++;closing=runtime.close();return answer}
    const sending=runtime.send({idOrName:start.task_id,message:"late input",deliverAs:"steer"}).catch(error=>error)
    const witness=await Promise.race([state.inputEntered.then(()=>"input-dispatched-after-close"),sending.then(()=>"send-stopped")])
    state.releaseInputAck();const result=await sending
    await closing
    expect(closeCalls).toBe(1)
    expect(result.kind).toBe("not_continuable")
    expect(witness).toBe("send-stopped")
    expect(state.calls.filter(call=>call.startsWith("input:"))).toEqual([])
  })
})

test("active close keeps child policy until actual interrupt and host idle join without a fake terminal",async()=>{
  await fixture(async(runtime,state)=>{
    const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
    const before=defined(runtime.get(start.task_id)),path=join(runtime.store.stateDir,"tasks",`${start.task_id}.json`)
    state.holdHostWait();let closed=false
    const closing=runtime.close().then(()=>{closed=true})
    const witness=await Promise.race([closing.then(()=>"closed-without-idle-join"),state.hostWaitEntered.then(()=>"waiting-for-host-idle")])
    const policyWhileWaiting=state.policyActive(),activeWhileWaiting=state.hostActive()
    state.releaseHostWait();await closing
    expect(witness).toBe("waiting-for-host-idle");expect(policyWhileWaiting).toBe(true);expect(activeWhileWaiting).toBe(false)
    expect(closed).toBe(true);expect(state.policyActive()).toBe(false)
    expect(state.calls.indexOf("policy-disposed")).toBeGreaterThan(state.calls.indexOf("host-wait"))
    expect(state.calls.filter(call=>call==="remove")).toEqual([])
    const after=JSON.parse(readFileSync(path,"utf8"))
    expect(after.status).toBe("running");expect(after.residency_state).toBe("persisted_only");expect(after.notification.run_epoch).toBe(before.notification.run_epoch)
  })
})

test("recovery settle joins the actual recover operation without disposing a healthy runner",async()=>{
  await fixture(async(runtime,state)=>{
    const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
    const record=defined(runtime.get(start.task_id)),handle=defined(runtime.manager.getResidentHandle(start.task_id))
    const entered=Promise.withResolvers<void>(),finish=Promise.withResolvers<void>();let disposed=0,joined=false
    const recovery=createOwnedTaskRecovery({async recover(){entered.resolve();await finish.promise;return {handle}},async dispose(){disposed++}} as never,runtime.store.stateDir)
    const work=recovery.respawn({record,sessionPath:undefined,beforeLaunch(){}},{} as never,()=>0)
    await entered.promise;const settling=recovery.settleTeardowns().then(()=>{joined=true})
    await Promise.resolve();expect(joined).toBe(false);expect(disposed).toBe(0)
    finish.resolve();expect((await work).ok).toBe(true);await settling;expect(joined).toBe(true);expect(disposed).toBe(0)
    expect((await runtime.send({idOrName:start.task_id,message:"after recovery join",deliverAs:"steer"})).kind).toBe("steered")
    expect(state.calls).toContain("input:steer");await runtime.end(start.task_id)
  })
})

test("SAME manager sends active steer/queue inputs and its existing output follows actual new steps",async()=>{
  await fixture(async(runtime,state)=>{
    const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
    for(const [message,deliverAs] of [["A","steer"],["B","followUp"],["C","steer"]] as const)expect((await runtime.send({idOrName:start.task_id,message,deliverAs})).kind).toBe("steered")
    expect(state.calls.filter(call=>call.startsWith("input:"))).toEqual(["input:steer","input:queue","input:steer"])
    state.finishFrame(defined(defined(runtime.get(start.task_id)).child_session_id))
    const record=await runtime.wait(start.task_id,AbortSignal.timeout(2000))
    expect(record.status).toBe("completed");expect(record.final_response).toBe("after managed inputs");expect(record.run_stats).toBeUndefined()
    expect(JSON.stringify(await runtime.output({task_id:start.task_id,mode:"full"}))).toContain("after managed inputs")
    await runtime.end(start.task_id)
    const before=structuredClone(runtime.get(start.task_id));const calls=[...state.calls]
    expect((await runtime.send({idOrName:start.task_id,message:"ended task must not dispatch"})).kind).toBe("not_continuable")
    expect(runtime.get(start.task_id)).toEqual(before);expect(state.calls).toEqual(calls)
  })
})

test("unknown active admission persists branded uncertainty without a signal waiter, replay, or lane release",async()=>{
  await fixture(async(runtime,state)=>{
    const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
    const waiting=runtime.wait(start.task_id).then(()=>"wrong",error=>ChildObservationUncertain.is(error)?"uncertain":"wrong-error")
    const sent=await runtime.send({idOrName:start.task_id,message:"lose-input-ack",deliverAs:"steer"})
    expect(sent.kind).toBe("uncertain");expect(await waiting).toBe("uncertain")
    const record=defined(runtime.get(start.task_id))
    expect(record.status).toBe("running");expect(record.observation_uncertain).toBeDefined()
    expect(runtime.manager.concurrency?.leaseState(start.task_id,record.notification.run_epoch)).toBe("held")
    expect(state.calls.filter(call=>call.startsWith("input:"))).toHaveLength(1)
    await runtime.send({idOrName:start.task_id,message:"must not retry",deliverAs:"steer"})
    expect(state.calls.filter(call=>call.startsWith("input:"))).toHaveLength(1)
    await runtime.end(start.task_id)
    expect(state.calls.filter(call=>call==="remove")).toHaveLength(1)
    expect(runtime.manager.concurrency?.leaseState(start.task_id,record.notification.run_epoch)).toBeUndefined()
  })
})

test("actual terminal before continuation ACK waits for its checkpoint instead of losing outcome custody",async()=>{
  await fixture(async(runtime,state)=>{
    const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
    state.holdInputAck();let settled=false
    const waiting=runtime.wait(start.task_id,AbortSignal.timeout(2000)).then(record=>{settled=true;return record})
    const sending=runtime.send({idOrName:start.task_id,message:"held ACK",deliverAs:"steer"})
    await state.inputEntered;state.finishFrame(defined(defined(runtime.get(start.task_id)).child_session_id));await state.drainEvents()
    expect(settled).toBe(false);expect(runtime.get(start.task_id)?.status).toBe("running")
    state.releaseInputAck();expect((await sending).kind).toBe("steered")
    expect((await waiting).final_response).toBe("after managed inputs");await runtime.end(start.task_id)
  })
})

test.each(["abort","dispose","terminate"] as const)("direct Native handle %s stops a queued continuation before its dispatch",async control=>{
  await fixture(async(runtime,state)=>{
    const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
    const handle=defined(runtime.manager.getResidentHandle(start.task_id))
    const sending=handle.steer("queued direct input").catch(error=>error)
    await defined(handle[control])();const result=await sending
    expect(result).toBeInstanceOf(Error);expect(state.calls.filter(call=>call.startsWith("input:"))).toEqual([])
    if(control==="abort")await runtime.end(start.task_id)
  })
})

test.each(["abort","terminate"] as const)("direct Native handle %s aborts and joins an actual pending continuation",async control=>{
  await fixture(async(runtime,state)=>{
    const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
    state.holdInputAck();const handle=defined(runtime.manager.getResidentHandle(start.task_id))
    const sending=handle.steer("held direct input").catch(error=>error);await state.inputEntered
    await defined(handle[control])();expect(await sending).toBeInstanceOf(Error)
    expect(state.calls).toContain("input-abort-joined")
    if(control==="abort")await runtime.end(start.task_id)
  })
})

test("current invocation abort joins pending input transport but leaves independent END authority live",async()=>{
  await fixture(async(runtime,state)=>{
    const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
    state.holdInputAck();const caller=new AbortController()
    const sending=runtime.send({idOrName:start.task_id,message:"held caller input",deliverAs:"steer"},{signal:caller.signal})
    await state.inputEntered;caller.abort(new Error("controlled caller interrupted"))
    expect((await sending).kind).toBe("uncertain");expect(state.calls).toContain("input-abort-joined")
    await runtime.end(start.task_id);expect(state.calls.filter(call=>call==="remove")).toHaveLength(1)
  })
})

test("outcome custody loss rejects local waiters without mutating a changed owner record",async()=>{
  await fixture(async(runtime,state)=>{
    const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
    const waiting=runtime.wait(start.task_id).then(()=>"wrong",error=>ChildObservationUncertain.is(error)?"uncertain":"wrong-error")
    const original=structuredClone(defined(runtime.get(start.task_id)))
    const changed={...original,owned_session:{...defined(original.owned_session),journalOwner:"controlled-other-owner"}}
    runtime.store.mutate(start.task_id,()=>changed);state.finishFrame(defined(original.child_session_id))
    expect(await waiting).toBe("uncertain");expect(runtime.store.load(start.task_id)).toEqual(changed)
    runtime.store.mutate(start.task_id,()=>original);await runtime.end(start.task_id)
  })
})

test("category/model/mode refusals create no child and foreign controls have no side effects", async () => {
  await fixture(async (runtime, state) => {
    expect((await runtime.start({ category: "unknown", prompt: "refuse" })).kind).toBe("plan_unresolved")
    expect((await runtime.start({ model: "qa/missing", prompt: "refuse" })).kind).toBe("plan_unresolved")
    expect((await runtime.start({ category: "qa", execution_mode: "process", prompt: "refuse" })).kind).toBe("plan_unresolved")
    expect(state.calls).toEqual([])
    const started = await runtime.start({ category: "qa", prompt: "scope fixture" })
    if (started.kind !== "started") throw Error("No fixture record")
    const record = await runtime.wait(started.task_id, AbortSignal.timeout(2000))
    const { owned_session: _owned, runner_kind: _kind, residency_claim: _claim, ...plain } = record
    runtime.store.save({ ...plain, task_id: "st_00fffffe", name: "foreign-input", parent_session_id: "foreign", root_session_id: "foreign", status: "running" })
    const before = [...state.calls], stored = runtime.store.load("st_00fffffe")
    for (const operation of [runtime.interrupt, runtime.cancel, runtime.end]) await expect(operation("st_00fffffe")).rejects.toThrow("parent scope")
    await expect(runtime.send({idOrName:"st_00fffffe",message:"foreign"})).rejects.toThrow("parent scope")
    await expect(runtime.send({idOrName:"foreign-input",message:"foreign"})).rejects.toThrow("parent scope")
    expect(state.calls).toEqual(before); expect(runtime.store.load("st_00fffffe")).toEqual(stored)
    await runtime.end(started.task_id)
  })
})

test("cancel joins in-flight admission before interrupt/end and repeated end uses confirmed closed receipt", async () => {
  await fixture(async (runtime, state) => {
    const started = await runtime.start({ category: "qa", prompt: "hold-ack" })
    if (started.kind !== "started") throw Error("Controlled task did not stage")
    await state.receiptEntered
    const cancellation = runtime.cancel(started.task_id)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(state.calls.filter(call => call === "interrupt")).toEqual([])
    state.releaseReceipt()
    expect((await cancellation).kind).toBe("cancelled")
    expect(runtime.get(started.task_id)?.status).toBe("cancelled")
    expect(state.calls.filter(call => call === "remove")).toHaveLength(1)
    await runtime.end(started.task_id)
    expect(state.calls.filter(call => call === "remove")).toHaveLength(1)
  })
})

test("terminal waiter may finish before cancel control; immediate end and close join actual control teardown", async () => {
  await fixture(async (runtime, state) => {
    const started = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
    if (started.kind !== "started") throw Error("Controlled task did not start")
    const waiting = runtime.wait(started.task_id, AbortSignal.timeout(2000))
    state.holdRemove()
    let cancelDone = false
    const cancellation = runtime.cancel(started.task_id).finally(() => { cancelDone = true })
    await state.removeEntered
    expect((await waiting).status).toBe("cancelled")
    expect(cancelDone).toBe(false)
    const ending = runtime.end(started.task_id)
    const closing = runtime.close()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(cancelDone).toBe(false)
    expect(state.calls.filter(call => call === "remove")).toHaveLength(1)
    state.releaseRemove()
    expect((await cancellation).kind).toBe("cancelled")
    await ending; await closing
    expect(state.calls.filter(call => call === "remove")).toHaveLength(1)
  })
})

test("lost observation keeps uncertainty and lane, but explicit permanent end still confirms removal", async () => {
  await fixture(async (runtime, state) => {
    const started = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
    if (started.kind !== "started") throw Error("No controlled task")
    const waiting = runtime.wait(started.task_id).then(() => "wrong", error => ChildObservationUncertain.is(error) ? "uncertain" : "wrong-error")
    state.breakObservation()
    expect(await waiting).toBe("uncertain")
    const record = defined(runtime.get(started.task_id))
    expect(record.status).toBe("running")
    expect(record.observation_uncertain).toBeDefined()
    expect(runtime.manager.concurrency?.leaseState(started.task_id, record.notification.run_epoch)).toBe("held")
    await runtime.end(started.task_id)
    expect(state.calls.filter(call => call === "remove")).toHaveLength(1)
    expect(runtime.get(started.task_id)?.observation_uncertain).toBeDefined()
    expect(runtime.manager.concurrency?.leaseState(started.task_id, record.notification.run_epoch)).toBeUndefined()
  })
})

test("lost admission receipt is typed uncertain without retry, and retained control can permanently end", async () => {
  await fixture(async (runtime, state) => {
    const started = await runtime.start({ category: "qa", prompt: "lose-ack" })
    if (started.kind !== "started") throw Error("No controlled task")
    await expect(runtime.wait(started.task_id)).rejects.toBeInstanceOf(ChildObservationUncertain)
    expect(runtime.get(started.task_id)?.status).toBe("running")
    expect(state.calls.filter(call => call === "prompt")).toHaveLength(1)
    await runtime.end(started.task_id)
    expect(state.calls.filter(call => call === "remove")).toHaveLength(1)
  })
})

test("initiating caller abort during real create await admits no first input and still joins cleanup", async () => {
  await fixture(async (runtime, state) => {
    state.holdCreate()
    const starting = runtime.start({ category: "qa", prompt: "must not be sent" })
    await state.createEntered
    state.callerAbort.abort(new Error("initiating invocation aborted")); state.releaseCreate()
    const result = await starting
    if (result.kind === "started") await runtime.manager.whenLaunched?.(result.task_id)
    expect(state.calls.filter(call => call === "prompt")).toEqual([])
    expect(state.calls.filter(call => call === "remove")).toHaveLength(1)
  })
})

test("initiating caller abort after first input does not kill already admitted background work", async () => {
  await fixture(async (runtime, state) => {
    const started = await runtime.start({ category: "qa", prompt: "block-until-interrupt", run_in_background: true })
    if (started.kind !== "started") throw Error("No controlled background task")
    // Flush a read after first input ACK; caller lifetime is not the child lifetime.
    await new Promise(resolve => setTimeout(resolve, 30))
    state.callerAbort.abort(new Error("initiating invocation ended"))
    expect(runtime.get(started.task_id)?.status).toBe("running")
    expect(state.calls.filter(call => call === "interrupt")).toEqual([])
    await runtime.end(started.task_id)
    expect(state.calls.filter(call => call === "remove")).toHaveLength(1)
  })
})

test("torn display log promptly rejects outcome without host terminal then retains lane for end", async () => {
  await fixture(async (runtime, state) => {
    const started = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
    if (started.kind !== "started") throw Error("No controlled task")
    const waiting = runtime.wait(started.task_id).then(() => "wrong", error => ChildObservationUncertain.is(error) ? "uncertain" : "wrong-error")
    appendFileSync(join(runtime.store.stateDir, "logs", `${started.task_id}.jsonl`), "{torn")
    const child = defined(defined(runtime.get(started.task_id)).child_session_id)
    state.emit("session.text.started", child, { assistantMessageID: "assistant", ordinal: 0 })
    state.emit("session.text.ended", child, { assistantMessageID: "assistant", ordinal: 0, text: "partial covered step" })
    state.emit("session.step.ended", child, { assistantMessageID: "assistant", finish: "stop" })
    expect(await Promise.race([waiting, new Promise(resolve => setTimeout(() => resolve("hung"), 150))])).toBe("uncertain")
    const record = defined(runtime.get(started.task_id))
    expect(record.status).toBe("running")
    expect(runtime.manager.concurrency?.leaseState(started.task_id, record.notification.run_epoch)).toBe("held")
    await runtime.end(started.task_id)
  })
})

test("failed real-store close stays failed and retries only retained closer without replaying host work", async () => {
  await fixture(async (runtime, state) => {
    const started = await runtime.start({ category: "qa", prompt: "close retry fixture" })
    if (started.kind !== "started") throw Error("No controlled task")
    await runtime.wait(started.task_id); await runtime.end(started.task_id)
    const close = runtime.store.close.bind(runtime.store)
    let closes = 0
    runtime.store.close = () => { closes++; if (closes === 1) throw Error("controlled real FD closer failed before close"); close() }
    try {
    await expect(runtime.close()).rejects.toThrow("cleanup incomplete")
    expect(runtime.store.residentFigures().openEventLogs).toBe(1)
    const calls = [...state.calls]
    await runtime.close()
    expect(closes).toBe(2)
    expect(runtime.store.residentFigures().openEventLogs).toBe(0)
    expect(state.calls).toEqual(calls)
    } finally { runtime.store.close = close; close() }
  })
})

test("independent cleanup: healthy repeated END retries custody after a transient first child get",async()=>{
  await fixture(async(runtime,state)=>{
    const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
    await runtime.detach(start.task_id)
    state.failChildGetOnce()
    const first=await runtime.end(start.task_id).then(()=>null,error=>String(error))
    const second=await runtime.end(start.task_id).then(()=>null,error=>String(error))
    const witness={first,second,createCount:state.calls.filter(x=>x==="create").length,promptCount:state.calls.filter(x=>x==="prompt").length,removeCount:state.calls.filter(x=>x==="remove").length}
    console.log("MI1_CHILD_GET_RETRY_WITNESS",JSON.stringify(witness))
    await runtime.close()
    expect(first).toContain("controlled transient child lookup")
    expect(second).toBe(null)
    expect(witness.removeCount).toBe(1)
  })
},5000)


test("same Native idle follow-up publishes a new epoch and waits for its own new frame rather than old success",async()=>{
 await fixture(async(runtime,state)=>{
  const start=await runtime.start({category:"qa",prompt:"first completed turn"});if(start.kind!=="started")throw Error("start")
  const first=await runtime.wait(start.task_id);expect(first.final_response).toBe("controlled actual step")
  const sent=await runtime.send({idOrName:start.task_id,message:"new owned turn",deliverAs:"followUp"})
  expect(sent.kind).toBe("revived");expect(runtime.get(start.task_id)?.notification.run_epoch).toBe(1)
  let finished=false;const waiting=runtime.wait(start.task_id).then(result=>{finished=true;return result})
  await state.drainEvents();expect(finished).toBe(false)
  state.finishFrame(defined(first.child_session_id))
  const second=await waiting;expect(second.final_response).toBe("after managed inputs");expect(second.notification.run_epoch).toBe(1)
  expect(second.child_session_id).toBe(first.child_session_id);expect(second.run_stats).toBeUndefined()
  expect(JSON.stringify(await runtime.output({task_id:start.task_id,mode:"full"}))).toContain("after managed inputs")
  await runtime.end(start.task_id)
 })
})

test("proven post-CAS pre-call abort restores prior output and burns epoch before an explicit higher retry",async()=>{
 await fixture(async(runtime,state)=>{
  const start=await runtime.start({category:"qa",prompt:"first completed turn"});if(start.kind!=="started")throw Error("start")
  const first=await runtime.wait(start.task_id),abort=new AbortController(),mutate=runtime.store.mutate.bind(runtime.store)
  let armed=true
  Object.defineProperty(runtime.store,"mutate",{value:(...args:Parameters<typeof mutate>)=>{const next=mutate(...args);if(armed&&next?.notification.run_epoch===1&&next.status==="running"){armed=false;abort.abort(new Error("real invocation stopped before actual host call"))};return next}})
  const refused=await runtime.send({idOrName:start.task_id,message:"must not reach host"},{signal:abort.signal})
  expect(refused.kind).toBe("not_continuable");expect(runtime.get(start.task_id)?.notification.run_epoch).toBe(0)
  expect(runtime.get(start.task_id)?.burnt_epoch).toBe(1);expect(runtime.get(start.task_id)?.final_response).toBe(first.final_response)
  expect(state.calls.filter(x=>x==="prompt")).toHaveLength(1)
  expect((await runtime.send({idOrName:start.task_id,message:"higher explicit retry"})).kind).toBe("revived")
  expect(runtime.get(start.task_id)?.notification.run_epoch).toBe(2)
  state.finishFrame(defined(first.child_session_id));expect((await runtime.wait(start.task_id)).final_response).toBe("after managed inputs")
  await runtime.end(start.task_id)
 })
})

test("journal-restored but Native rollback write failed rejects new waiters and still permits real END",async()=>{
 await fixture(async(runtime,state)=>{
  const start=await runtime.start({category:"qa",prompt:"first completed turn"});if(start.kind!=="started")throw Error("start")
  await runtime.wait(start.task_id)
  const abort=new AbortController(),mutate=runtime.store.mutate.bind(runtime.store);let armed=true,failRollback=true
  Object.defineProperty(runtime.store,"mutate",{value:(id:string,change:Parameters<typeof mutate>[1])=>{
   const next=mutate(id,current=>{const candidate=change(current);if(failRollback&&candidate.burnt_epoch===1&&candidate.notification.run_epoch===0){failRollback=false;throw Error("Native persistence failed AFTER actual journal restore")};return candidate})
   if(armed&&next?.notification.run_epoch===1&&next.status==="running"){armed=false;abort.abort(new Error("proven pre-call cancellation"))};return next
  }})
  const result=await runtime.send({idOrName:start.task_id,message:"never called"},{signal:abort.signal})
  expect(result.kind).toBe("not_continuable")
  await expect(runtime.wait(start.task_id)).rejects.toBeInstanceOf(ChildObservationUncertain)
  expect(runtime.get(start.task_id)?.status).toBe("running");expect(runtime.get(start.task_id)?.notification.run_epoch).toBe(1)
  expect(runtime.get(start.task_id)?.final_response).toBeUndefined();expect(runtime.manager.concurrency?.leaseState(start.task_id,1)).toBe("held")
  expect(state.calls.filter(x=>x==="prompt")).toHaveLength(1)
  await runtime.end(start.task_id)
  expect(state.calls.filter(x=>x==="remove")).toHaveLength(1)
  expect(runtime.manager.concurrency?.leaseState(start.task_id,1)).toBeUndefined()
  await runtime.end(start.task_id);expect(state.calls.filter(x=>x==="remove")).toHaveLength(1)
 })
})

test("a fresh invocation signal survives new input-port publication and old initiating signal is not reused",async()=>{
 await fixture(async(runtime,state)=>{
  const start=await runtime.start({category:"qa",prompt:"first completed turn"});if(start.kind!=="started")throw Error("start")
  await runtime.wait(start.task_id);state.callerAbort.abort(new Error("old invocation ended"))
  const current=new AbortController();state.holdInputAck()
  const sending=runtime.send({idOrName:start.task_id,message:"new independently cancellable turn"},{signal:current.signal})
  await state.inputEntered;current.abort(new Error("current invocation interrupted"));const result=await sending
  expect(result.kind).toBe("uncertain");expect(state.calls).toContain("input-abort-joined")
  await expect(runtime.wait(start.task_id)).rejects.toBeInstanceOf(ChildObservationUncertain)
  expect(runtime.get(start.task_id)?.notification.run_epoch).toBe(1);expect(state.calls.filter(x=>x==="prompt")).toHaveLength(2)
  state.releaseInputAck();await runtime.end(start.task_id)
 })
})


test("cancel during actual observer readiness joins unpublished resources and sends no new input",async()=>{
 await fixture(async(runtime,state)=>{
  const start=await runtime.start({category:"qa",prompt:"initial complete"});if(start.kind!=="started")throw Error("start")
  await runtime.wait(start.task_id);state.holdUpdate()
  const sending=runtime.send({idOrName:start.task_id,message:"must stay unpublished"})
  await state.updateEntered;const cancelling=runtime.cancel(start.task_id)
  expect((await sending).kind).toBe("not_continuable");expect((await cancelling).kind).toBe("released");state.releaseUpdate()
  expect(runtime.get(start.task_id)?.notification.run_epoch).toBe(0);expect(state.calls.filter(x=>x==="prompt")).toHaveLength(1)
  expect(runtime.get(start.task_id)?.residency_state).toBe("persisted_only");expect(state.calls.filter(x=>x==="remove")).toHaveLength(0)
  await runtime.end(start.task_id)
  expect(state.calls.filter(x=>x==="remove")).toHaveLength(1)
 })
})

test.each(["cancel","end","detach","close"] as const)("new-turn %s aborts and joins actual pending admission before dropping policy",async control=>{
 await fixture(async(runtime,state)=>{
  const start=await runtime.start({category:"qa",prompt:"initial complete"});if(start.kind!=="started")throw Error("start")
  await runtime.wait(start.task_id);state.holdInputAck()
  const sending=runtime.send({idOrName:start.task_id,message:"new held input"})
  await state.inputEntered
  const stopping=control==="close"?runtime.close():runtime[control](start.task_id)
  await sending;await stopping;state.releaseInputAck()
  expect(state.calls).toContain("input-abort-joined");expect(state.hostActive()).toBe(false);expect(state.policyActive()).toBe(false)
  expect(state.calls.filter(x=>x==="create")).toHaveLength(1);expect(state.calls.filter(x=>x==="prompt")).toHaveLength(2)
  if(control==="detach"){expect(runtime.get(start.task_id)?.residency_state).toBe("persisted_only");await runtime.end(start.task_id)}
 })
})

test("mismatched recovered turn descriptor refuses before host mutation and explicit END remains available",async()=>{
 await fixture(async(runtime,state)=>{
  const start=await runtime.start({category:"qa",prompt:"initial complete"});if(start.kind!=="started")throw Error("start")
  const first=await runtime.wait(start.task_id)
  expect((await runtime.send({idOrName:start.task_id,message:"second"})).kind).toBe("revived")
  state.finishFrame(defined(first.child_session_id));await runtime.wait(start.task_id);await runtime.detach(start.task_id)
  const ref=defined(defined(runtime.get(start.task_id)).owned_session),db=new Database(join(runtime.store.stateDir,"owned-children.sqlite"))
  const body=JSON.parse((db.query("SELECT body FROM children WHERE key=?").get(ref.journalKey) as {body:string}).body)
  body.turn.nativeEpoch=999;db.query("UPDATE children SET body=? WHERE key=?").run(JSON.stringify(body),ref.journalKey);db.close()
  const before=[...state.calls]
  await expect(runtime.recover(start.task_id)).rejects.toThrow("descriptor")
  expect(state.calls).toEqual(before)
  await runtime.end(start.task_id);expect(state.calls.filter(x=>x==="remove")).toHaveLength(1)
 })
})

test("direct Native input queues behind the new-turn admission and never races its backend exclusive guard",async()=>{
 await fixture(async(runtime,state)=>{
  const start=await runtime.start({category:"qa",prompt:"initial complete"});if(start.kind!=="started")throw Error("start")
  await runtime.wait(start.task_id);state.holdInputAck()
  const sending=runtime.send({idOrName:start.task_id,message:"new held turn"})
  await state.inputEntered
  const handle=defined(runtime.manager.getResidentHandle(start.task_id))
  let settled=false
  const direct=handle.steer("direct queued input").then(()=>{settled=true},error=>{settled=true;throw error})
  await Promise.resolve();expect(settled).toBe(false);expect(state.calls.filter(x=>x==="prompt")).toHaveLength(2)
  state.releaseInputAck();expect((await sending).kind).toBe("revived");await direct
  expect(state.calls.filter(x=>x==="prompt")).toHaveLength(3)
  state.finishFrame(defined(defined(runtime.get(start.task_id)).child_session_id));expect((await runtime.wait(start.task_id)).status).toBe("completed")
  await runtime.end(start.task_id)
 })
})


test("new start C2 uses its own captured authority after initiating C1 has aborted",async()=>{
 await fixture(async(runtime,state)=>{
  const first=await runtime.start({category:"qa",prompt:"C1"});if(first.kind!=="started")throw Error("first start")
  await runtime.wait(first.task_id);state.callerAbort.abort(new Error("completed C1 raw signal aborted"))
  const c2=new AbortController();state.useStartSignal(c2.signal)
  const second=await runtime.start({category:"qa",prompt:"C2"}).catch(error=>({kind:"wrong-creator-signal" as const,reason:String(error)}))
  expect(second.kind).toBe("started")
  if(second.kind!=="started")return
  expect((await runtime.wait(second.task_id)).status).toBe("completed");await runtime.end(second.task_id);await runtime.end(first.task_id)
 })
})

test("an arbitrary persisted epoch edit cannot grant the old handle reattach authority",async()=>{
 await fixture(async(runtime,state)=>{
  const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
  const before=defined(runtime.store.load(start.task_id)),handle=defined(runtime.manager.getResidentHandle(start.task_id))
  const calls=[...state.calls]
  const next=before.notification.run_epoch+1
  runtime.store.replace({...before,notification:{...before.notification,run_epoch:next},owned_session:{...defined(before.owned_session),runEpoch:next}})
  expect(()=>handle.assertOwned?.()).toThrow("epoch or custody")
  expect(state.calls).toEqual(calls)
  // This test's untrusted disk edit is not a canonical Native publication receipt.
  runtime.store.replace(before)
  expect(()=>handle.assertOwned?.()).not.toThrow()
  await runtime.end(start.task_id)
 })
})


test("close joins a concurrent END failure once and retries actual retained cleanup instead of a historical error",async()=>{
 await fixture(async(runtime,state)=>{
  const start=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(start.kind!=="started")throw Error("start")
  state.holdRemove();const ending=runtime.end(start.task_id).catch(error=>error)
  await state.removeEntered
  const closing=runtime.close().then(()=>null,error=>error)
  state.failRemoveOnce();state.releaseRemove()
  expect(await ending).toBeInstanceOf(Error);expect(await closing).toBeInstanceOf(Error)
  const retry=await runtime.close().then(()=>null,error=>String(error))
  expect(retry).toBe(null);expect(state.hostActive()).toBe(false);expect(state.policyActive()).toBe(false)
  expect(state.calls.filter(x=>x==="create")).toHaveLength(1);expect(state.calls.filter(x=>x==="prompt")).toHaveLength(1)
 })
})

test("the SAME Native manager workpool owner is closed and failed release retries before store teardown",async()=>{
 await fixture(async(runtime)=>{
  const started=await runtime.start({category:"qa",prompt:"owned workpool resources"});if(started.kind!=="started")throw Error("start")
  await runtime.wait(started.task_id)
  const original=runtime.manager.workpools.dispose.bind(runtime.manager.workpools);let calls=0
  Object.defineProperty(runtime.manager.workpools,"dispose",{value(){calls++;if(calls===1)throw Error("controlled pool release failure");original()}})
  const first=await runtime.close().then(()=>null,error=>error)
  expect(first).toBeInstanceOf(Error);expect(calls).toBe(1)
  await runtime.close();expect(calls).toBe(2)
 })
})


test("SAME manager rejects forged caller ancestry before any Native host create",async()=>{
 await fixture(async(runtime,state)=>{
  await expect(runtime.manager.start({prompt:"forged parent",category:"qa",parent_session_id:"foreign",root_session_id:"parent",depth:2})).rejects.toThrow("ancestry differs")
  await expect(runtime.manager.start({prompt:"forged root",category:"qa",parent_session_id:"parent",root_session_id:"foreign",depth:1})).rejects.toThrow("ancestry differs")
  await expect(runtime.manager.start({prompt:"forged depth",category:"qa",parent_session_id:"parent",root_session_id:"parent",depth:2})).rejects.toThrow("ancestry differs")
  expect(state.calls.filter(call=>call==="create")).toHaveLength(0)
 })
})

test("completed actual child END retains a durable closed journal receipt and repeated END adds no host removal", async () => {
  await fixture(async (runtime, state) => {
    const started = await runtime.start({ category: "qa", prompt: "complete before explicit retirement" })
    if (started.kind !== "started") throw Error("start failed")
    const record = await runtime.wait(started.task_id)
    const reference = defined(record.owned_session)
    await runtime.end(started.task_id)
    const db = new Database(join(runtime.store.stateDir, "owned-children.sqlite"), { readonly: true })
    try {
      const actual = db.query("SELECT body FROM children WHERE key=?").get(reference.journalKey) as { body: string }
      const row = JSON.parse(actual.body)
      expect(row.phase).toBe("closed"); expect(row.locator.sessionID).toBe(reference.sessionID)
    } finally { db.close() }
    const removed = state.calls.filter(call => call === "remove").length
    await runtime.end(started.task_id)
    expect(state.calls.filter(call => call === "remove")).toHaveLength(removed)
  })
})

test("ancestor cleanup retains its original borrowed binding until descendant removal joins", async () => {
  await fixture(async (runtime, state) => {
    const parent = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
    if (parent.kind !== "started") throw Error("Parent did not start")
    const parentRecord = defined(runtime.get(parent.task_id))
    const binding = await runtime.verifyParent(defined(parentRecord.child_session_id))
    const grandchild = await runtime.withParent(binding, () => runtime.start({ category: "qa", prompt: "block-until-interrupt" }))
    if (grandchild.kind !== "started") throw Error("Grandchild did not start")
    state.holdRemove()
    const ending = runtime.end(parent.task_id)
    let retained = false
    try {
      await state.removeEntered
      try { retained = runtime.parentInfo(binding).lease.sessionID === parentRecord.child_session_id }
      catch { retained = false }
    } finally {
      state.releaseRemove()
      await ending
    }
    expect(retained).toBe(true)
    expect(() => runtime.parentInfo(binding)).toThrow()
    expect(state.calls.filter(call => call === "remove")).toHaveLength(2)
  })
})

test("failed descendant cleanup retains original borrowed custody until the same END retries", async () => {
  await fixture(async (runtime, state) => {
    const parent = await runtime.start({ category: "qa", prompt: "block-until-interrupt" })
    if (parent.kind !== "started") throw Error("Parent did not start")
    const parentRecord = defined(runtime.get(parent.task_id))
    const binding = await runtime.verifyParent(defined(parentRecord.child_session_id))
    const grandchild = await runtime.withParent(binding, () => runtime.start({ category: "qa", prompt: "block-until-interrupt" }))
    if (grandchild.kind !== "started") throw Error("Grandchild did not start")
    state.failRemoveOnce()
    await expect(runtime.end(parent.task_id)).rejects.toThrow()
    expect(runtime.parentInfo(binding).lease.sessionID === parentRecord.child_session_id).toBe(true)
    await runtime.end(parent.task_id)
    expect(() => runtime.parentInfo(binding)).toThrow()
    expect(state.calls.filter(call => call === "remove")).toHaveLength(3)
  })
})

test("recovery cannot turn a foreign stored root into parent custody",async()=>{
 await fixture(async(runtime,state)=>{
  const started=await runtime.start({category:"qa",prompt:"block-until-interrupt"});if(started.kind!=="started")throw Error("start")
  const original=defined(runtime.get(started.task_id)),before=state.calls.length
  runtime.store.replace({...original,root_session_id:"foreign"})
  try{await expect(runtime.recover(started.task_id)).rejects.toThrow("outside parent scope");expect(state.calls.length).toBe(before)}
  finally{runtime.store.replace(original)}
  await runtime.end(started.task_id)
 })
})

// Reuse the SAME controlled manager/backend fixture for runner-integration units.
export { fixture as withOwnedRuntimeUnit }
