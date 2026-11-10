import { afterEach, expect, test } from "bun:test"
import { createTaskManagerImplementation } from "./manager-implementation"
import { ChildObservationUncertain } from "./observation-uncertain"
import { createTaskRecordStore } from "../store"
import { baseSpec, categoryPlanner, cleanupProjects, makeHandle, settings, tempProject } from "./__fixtures__/manager-fakes"
import type { ManagedRunner } from "./types"
import { AdmissionBarrier } from "../pause/admission-barrier"
import type { ManagedChildHandle } from "./child-handle"
afterEach(cleanupProjects)

test.each(["partial","complete"] as const)("revival rearms %s coverage without inventing missing Native stats",async coverage=>{
 const cwd=tempProject(),store=createTaskRecordStore({project_dir:cwd});let fake:ReturnType<typeof makeHandle>|undefined
 const runner:ManagedRunner={async start(spec){fake=makeHandle(spec.taskId);return {...fake.handle,observationCoverage:coverage}}}
 const manager=createTaskManagerImplementation({cwd,store,config:settings(),planner:categoryPlanner(),runners:{"in-process":runner,process:runner}},
  {preparePlanning:async()=>{},createRecoveryRuntime:()=>({respawn:async()=>{throw Error("unused")},settleTeardowns:async()=>{}})})
 const started=await manager.start(baseSpec());if(started.kind!=="started"||!fake)throw Error("start")
 fake.settle({status:"completed",finalResponse:"first"});await manager.waitFor(started.task_id)
 expect((await manager.sendToTask({idOrName:started.task_id,message:"second"})).kind).toBe("revived")
 expect(manager.runStatsSnapshot?.(started.task_id)===undefined).toBe(coverage==="partial")
 const waiting=manager.waitFor(started.task_id);fake.settle({status:"completed",finalResponse:"second"});const finished=await waiting
 expect(finished.final_response).toBe("second");expect(finished.run_stats===undefined).toBe(coverage==="partial")
 manager.forget(started.task_id,{path:"end"});store.remove(started.task_id);store.close()
})

test("retained prepared rollback failure rejects real no-signal manager waiters and keeps its new lane",async()=>{
 const cwd=tempProject(),store=createTaskRecordStore({project_dir:cwd});let fake:ReturnType<typeof makeHandle>|undefined,handle:ManagedChildHandle|undefined
 const runner:ManagedRunner={async start(spec){fake=makeHandle(spec.taskId);handle={...fake.handle,observationCoverage:"partial"};return handle}}
 const manager=createTaskManagerImplementation({cwd,store,config:settings({default_concurrency:1}),planner:categoryPlanner(),runners:{"in-process":runner,process:runner}},
  {preparePlanning:async()=>{},createRecoveryRuntime:()=>({respawn:async()=>{throw Error("unused")},settleTeardowns:async()=>{}})})
 const started=await manager.start(baseSpec());if(started.kind!=="started"||!fake||!handle)throw Error("start")
 fake.settle({status:"completed",finalResponse:"old success"});await manager.waitFor(started.task_id)
 const failed=Promise.withResolvers<never>()
 handle.prepareFollowUp=async()=>({stamp:next=>next,dispatch:async()=>({kind:"not-dispatched",reason:"private no-call witness"}),
  restoreOwnedReference:()=>{throw Error("actual journal restore unavailable")},retainFailure:()=>{handle!.waitForOutcome=()=>failed.promise;failed.reject(new ChildObservationUncertain("known-unadmitted-rollback-unconfirmed"))},release:async()=>{throw Error("retained ticket must not release")}})
 expect((await manager.sendToTask({idOrName:started.task_id,message:"new"})).kind).toBe("not_continuable")
 await expect(manager.waitFor(started.task_id)).rejects.toBeInstanceOf(ChildObservationUncertain)
 expect(manager.get(started.task_id)?.notification.run_epoch).toBe(1);expect(manager.get(started.task_id)?.status).toBe("running")
 expect(manager.get(started.task_id)?.final_response).toBeUndefined();expect(manager.runStatsSnapshot?.(started.task_id)).toBeUndefined()
 expect(manager.concurrency?.hasFreeSlot(manager.get(started.task_id)!.model)).toBe(false);expect(manager.waiterKeyCount()).toBe(0)
 manager.forget(started.task_id,{path:"end"});store.remove(started.task_id);store.close()
})

test("observation gap rejects existing no-signal and future waiters without fallback or releasing lane", async () => {
  const cwd = tempProject(), store = createTaskRecordStore({ project_dir: cwd })
  const outcome = Promise.withResolvers<never>()
  const runner: ManagedRunner = { async start(spec) { return { ...makeHandle(spec.taskId).handle,
    observationCoverage: "partial", waitForOutcome: () => outcome.promise } } }
  const manager = createTaskManagerImplementation({ cwd, store, config: settings(), planner: categoryPlanner(),
    runners: { "in-process": runner, process: runner } }, { preparePlanning: async () => {}, createRecoveryRuntime: () => ({
      respawn: async () => { throw Error("No recovery requested in this unit fixture") }, settleTeardowns: async () => {},
    }) })
  const started = await manager.start(baseSpec())
  if (started.kind !== "started") throw Error("Fixture did not start")
  const waiting = manager.waitFor(started.task_id).then(() => "resolved", error => ChildObservationUncertain.is(error) ? "uncertain" : "wrong-error")
  outcome.reject(new ChildObservationUncertain("insufficient-cursor-coverage"))
  expect(await Promise.race([waiting, new Promise(resolve => setTimeout(() => resolve("hung"), 50))])).toBe("uncertain")
  expect(manager.get(started.task_id)?.status).toBe("running")
  expect(manager.get(started.task_id)?.observation_uncertain?.reason).toBe("insufficient-cursor-coverage")
  await expect(manager.waitFor(started.task_id)).rejects.toBeInstanceOf(ChildObservationUncertain)
  expect(manager.waiterKeyCount()).toBe(0)
  store.remove(started.task_id)
})

test("actual runner capability port refuses unsupported mode before a record or child exists", async () => {
  const cwd = tempProject(), store = createTaskRecordStore({ project_dir: cwd })
  let starts = 0
  const runner: ManagedRunner = { async start(spec) { starts++; return makeHandle(spec.taskId).handle } }
  const manager = createTaskManagerImplementation({ cwd, store, config: settings(), planner: categoryPlanner(),
    runnerPort: { resolve: mode => mode === "in-process" ? runner : undefined, all: () => [runner] } },
    { preparePlanning: async () => {}, createRecoveryRuntime: () => ({ respawn: async () => { throw Error("unused unit recovery") }, settleTeardowns: async () => {} }) })
  expect((await manager.start(baseSpec({ execution_mode: "process" }))).kind).toBe("plan_unresolved")
  expect(starts).toBe(0); expect(store.list().records).toEqual([])
  store.close()
})

test("closed staged activation uses existing branded held custody, sends zero input and no childSeq", async () => {
  const cwd = tempProject(), store = createTaskRecordStore({ project_dir: cwd }), barrier = new AdmissionBarrier()
  const created = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let inputs = 0, ended = 0
  const runner: ManagedRunner = { async start() { throw Error("Unstaged path must never run") } }
  const manager = createTaskManagerImplementation({ cwd, store, config: settings(), planner: categoryPlanner(), runners: { "in-process": runner, process: runner }, admissionBarrier: barrier,
    childCreationPort: { async startPaused(spec) {
      created.resolve(); await release.promise
      return { child: { ...makeHandle(spec.taskId).handle, terminate: async () => { ended++ } }, async activate() {
        spec.admission!.assertOpen(); inputs++; return { turnId: "unit", outcome: Promise.resolve({ status: "completed", finalResponse: "unit" }) }
      } }
    } },
  }, { preparePlanning: async () => {}, createRecoveryRuntime: () => ({ respawn: async () => { throw Error("unused unit recovery") }, settleTeardowns: async () => {} }) })
  const starting = manager.start(baseSpec())
  await created.promise; barrier.close("parent-1", 1); release.resolve()
  const result = await starting
  expect(result.kind).toBe("held"); expect(inputs).toBe(0); expect(ended).toBe(1)
  expect(result).not.toHaveProperty("childSeq")
  for (const record of store.list().records) store.remove(record.task_id)
  store.close()
})

test("lost custody still settles only local uncertainty waiters without foreign writes or lane release", async () => {
  const cwd = tempProject(), store = createTaskRecordStore({ project_dir: cwd }), outcome = Promise.withResolvers<never>()
  let retired = false
  const runner: ManagedRunner = { async start(spec) { return { ...makeHandle(spec.taskId).handle,
    observationCoverage: "partial", assertOwned() { if (retired) throw Error("journal custody retired") }, waitForOutcome: () => outcome.promise } } }
  const manager = createTaskManagerImplementation({ cwd, store, config: settings({ default_concurrency: 1 }), planner: categoryPlanner(), runners: { "in-process": runner, process: runner } },
    { preparePlanning: async () => {}, createRecoveryRuntime: () => ({ respawn: async () => { throw Error("unused unit recovery") }, settleTeardowns: async () => {} }) })
  const started = await manager.start(baseSpec())
  if (started.kind !== "started") throw Error("No fixture task")
  const before = store.load(started.task_id)
  const waiting = manager.waitFor(started.task_id).then(() => "wrong-resolution", error => ChildObservationUncertain.is(error) ? "uncertain" : "wrong-error")
  retired = true; outcome.reject(new ChildObservationUncertain("observation-lifetime-ended"))
  expect(await Promise.race([waiting, new Promise(resolve => setTimeout(() => resolve("hung"), 70))])).toBe("uncertain")
  expect(store.load(started.task_id)).toEqual(before)
  expect(manager.waiterKeyCount()).toBe(0)
  expect(manager.concurrency?.hasFreeSlot(before!.model)).toBe(false)
  await expect(manager.waitFor(started.task_id)).rejects.toBeInstanceOf(ChildObservationUncertain)
  manager.forget(started.task_id, { path: "end" }); store.remove(started.task_id); store.close()
})


