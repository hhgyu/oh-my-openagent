import { afterEach, expect, test } from "bun:test"
import { createTaskManagerImplementation } from "./manager-implementation"
import { createTaskManager } from "./manager"
import { createTaskRecordStore } from "../store"
import { categoryPlanner, cleanupProjects, FakeRunner, makeHandle, baseSpec, settings, tempProject } from "./__fixtures__/manager-fakes"
import { createNativeTaskRecoveryRuntime, type RecoveryWorkerCapabilities, type TaskRecoveryRuntime } from "./recovery-runtime"
import { RpcProcessRunner } from "../runners/rpc-process"
import type { RpcChildHandle, RpcRunnerSpec } from "../runners/types"
import { createTaskRecord, type TaskRecord } from "../state"
import { AdmissionBarrier } from "../pause/admission-barrier"
import type { ManagedRunner } from "./types"
import { join } from "node:path"

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected value to be present")
  return value
}

afterEach(cleanupProjects)
function configuration(){
 const cwd=tempProject(),store=createTaskRecordStore({project_dir:cwd}),runner=new FakeRunner()
 const options:Parameters<typeof createTaskManager>[0]={cwd,store,runners:{"in-process":runner,process:runner},planner:categoryPlanner(),config:settings()}
 return {options,runner,store}
}
test("recovery service factory is required before manager construction side effects",()=>{
 const f=configuration(),events:string[]=[],store={...f.store,list(){events.push("seed");return f.store.list()}}
 expect(()=>createTaskManagerImplementation({...f.options,store},{preparePlanning:async()=>{}} as never)).toThrow("recovery")
 expect(events).toEqual([])
})
test("a malformed recovery factory result cannot silently become an optional no-op service",()=>{
 const f=configuration()
 expect(()=>createTaskManagerImplementation(f.options,{preparePlanning:async()=>{},createRecoveryRuntime:()=>undefined as never})).toThrow("recovery runtime")
 expect(f.runner.startedSpecs).toEqual([])
})
test("required recovery factory runs once at the original post-seeding constructor position",async()=>{
 const f=configuration(),events:string[]=[],store={...f.store,list(){events.push("seed");return f.store.list()}}
 const service={async respawn(){throw Error("not invoked")},async settleTeardowns(){events.push("drain")}}
 const manager=createTaskManagerImplementation({...f.options,store},{preparePlanning:async()=>{},createRecoveryRuntime(options:Parameters<typeof createTaskManager>[0]){events.push("recovery");expect(options.store).toBe(store);expect(options.runners).toBe(f.options.runners);return service}})
 expect(events).toEqual(["seed","recovery"])
 await present(manager.settleLaunchesForShutdown).call(manager, 1000)
 expect(events).toEqual(["seed","recovery","drain","drain"])
})
function record(f:ReturnType<typeof configuration>,mode:"in-process"|"process"="in-process"):TaskRecord {
 const value={...createTaskRecord({parent_session_id:"parent-recovery",root_session_id:"root-recovery",depth:1,execution_mode:mode,model:"test/model",notify_on_terminal:false}),host_pid:process.pid,spawn_spec:{version:1 as const,cwd:f.options.cwd,prompt:"preserved recovery input"}}
 f.store.save(value);return value
}
function rpcHandle(taskId:string):RpcChildHandle {
 return {...makeHandle(taskId).handle,pid:4321,subscribe:()=>()=>undefined,waitForIdle:async()=>undefined,terminate:async()=>undefined,exitOutcome:()=>undefined,waitForExit:async()=>({kind:"clean",facts:{pid:4321,code:0,signal:null,stderrTail:""}}),lastSeen:()=>undefined,switchSession:async()=>({cancelled:false})}
}
const workers:RecoveryWorkerCapabilities={ownsTask:()=>false,yieldResults:()=>{throw Error("No assigned workpool turn in this test")}}
test("real Native default creates one stable recovery runner and explicit override preserves receiver/errors",async()=>{
 const f=configuration(),receivers:RpcProcessRunner[]=[],original=RpcProcessRunner.prototype.settleTeardowns
 RpcProcessRunner.prototype.settleTeardowns=async function(){receivers.push(this);await original.call(this)}
 try{
  const native=createNativeTaskRecoveryRuntime(f.options);await native.settleTeardowns();await native.settleTeardowns()
  expect(receivers).toHaveLength(2);expect(receivers[0]).toBeInstanceOf(RpcProcessRunner);expect(receivers[0]).toBe(receivers[1])
  const refusal=Error("explicit teardown failed"),override={start:async()=>{throw Error("not started")},settleTeardowns:async function(){expect(this).toBe(override);throw refusal}}
  const explicit=createNativeTaskRecoveryRuntime({...f.options,rpcRespawnRunner:override})
  await expect(explicit.settleTeardowns()).rejects.toBe(refusal);expect(receivers).toHaveLength(2)
 }finally{RpcProcessRunner.prototype.settleTeardowns=original}
})
test("Native service delegates real fresh RPC respawn with trusted launch/guard ordering and bound override",async()=>{
 const f=configuration(),saved=record(f,"process"),events:string[]=[],specs:RpcRunnerSpec[]=[]
 const override={start:async function(spec:RpcRunnerSpec){expect(this).toBe(override);events.push("rpc-start");specs.push(spec);return rpcHandle(spec.task_id)}}
 const native=createNativeTaskRecoveryRuntime({...f.options,rpcRespawnRunner:override,trustedRespawnLaunch:async value=>{expect(value).toBe(saved);events.push("trusted-launch");return {extensions:["/trusted/extension.ts"],memberEnv:{FIXTURE_MEMBER:"owned"}}}})
 const result=await native.respawn({record:saved,sessionPath:undefined,beforeLaunch(){events.push("before-launch")}},workers,()=>saved.notification.run_epoch)
 expect(result.ok).toBe(true);expect(events).toEqual(["trusted-launch","before-launch","rpc-start"])
 expect(specs).toHaveLength(1);expect(specs[0]).toMatchObject({task_id:saved.task_id,prompt:"preserved recovery input",extensions:["/trusted/extension.ts"],memberEnv:{FIXTURE_MEMBER:"owned"}})
 if(result.ok)await result.handle.dispose()
})
test("minimal worker capability forwards existing yield tool and paused restore starts no turn",async()=>{
 const f=configuration(),saved={...record(f),status:"completed" as const},child=makeHandle(saved.task_id),seen:string[]=[]
 const runner:ManagedRunner={start:async()=>{throw Error("paused restore must resume")},resume:async function(spec,path){expect(this).toBe(runner);expect(path).toBe("/controlled/resume.jsonl");seen.push(...(spec.memberScopedTools??[]).map(tool=>tool.name));return child.handle}}
 const capability:RecoveryWorkerCapabilities={ownsTask:function(id){expect(this).toBe(capability);expect(id).toBe(saved.task_id);return true},yieldResults:()=>{throw Error("not yielding")}}
 const native=createNativeTaskRecoveryRuntime({...f.options,runners:{"in-process":runner,process:runner}});let guarded=0
 const result=await native.respawn({record:saved,sessionPath:"/controlled/resume.jsonl",paused:true,beforeLaunch(){guarded++}},capability,()=>7)
 expect(result.ok).toBe(true);expect(guarded).toBe(1);expect(seen).toEqual(["workpool"]);expect(child.followUpCalls).toEqual([]);expect(child.steerCalls).toEqual([])
 if(result.ok)await result.handle.dispose()
})
test("manager keeps run admission and real durable launch stamp outside the recovery service",async()=>{
 const f=configuration(),saved=record(f),barrier=new AdmissionBarrier(),child=makeHandle(saved.task_id),observed:TaskRecord[]=[];let calls=0
 const runner:ManagedRunner={start:async()=>{observed.push(present(f.store.load(saved.task_id)));return child.handle}}
 const manager=createTaskManagerImplementation({...f.options,admissionBarrier:barrier,runners:{"in-process":runner,process:runner},now:()=>Date.parse("2026-11-08T00:00:00.000Z")},{preparePlanning:async()=>{},createRecoveryRuntime(options){const native=createNativeTaskRecoveryRuntime(options);const service:TaskRecoveryRuntime={respawn:function(request,workerCaps,epoch){calls++;expect(this).toBe(service);expect(workerCaps).toBe(manager.workpools);expect(epoch()).toBe(saved.notification.run_epoch);return native.respawn(request,workerCaps,epoch)},settleTeardowns:()=>native.settleTeardowns()};return service}})
 barrier.close(present(saved.root_session_id),1);expect(await manager.respawn(saved)).toMatchObject({ok:false,code:"run_paused"});expect(calls).toBe(0)
 const credential=barrier.resume(present(saved.root_session_id),1,"resume")
 const result=await manager.respawn(saved,undefined,credential)
 expect(result.ok).toBe(true);expect(calls).toBe(1);expect(observed[0]).toMatchObject({started_at:"2026-11-08T00:00:00.000Z",status:saved.status,notification:saved.notification})
 if(result.ok)await result.handle.dispose()
})
test("Stop while trusted recovery launch is pending reaches original beforeLaunch and prevents RPC start",async()=>{
 const f=configuration(),saved=record(f,"process"),barrier=new AdmissionBarrier(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let starts=0
 const manager=createTaskManager({...f.options,admissionBarrier:barrier,rpcRespawnRunner:{start:async()=>{starts++;return rpcHandle(saved.task_id)}},trustedRespawnLaunch:async()=>{entered.resolve();await release.promise;return undefined}})
 const starting=manager.respawn(saved);await entered.promise;barrier.close(present(saved.root_session_id),2);release.resolve()
 expect(await starting).toMatchObject({ok:false,code:"run_paused"});expect(starts).toBe(0);expect(f.store.load(saved.task_id)?.started_at).toBeUndefined();expect(barrier.inFlight(present(saved.root_session_id))).toEqual([])
})
test("paused recovery bypasses stopped run only for no-turn restore and preserves status/epoch",async()=>{
 const f=configuration(),saved={...record(f),status:"paused" as const},barrier=new AdmissionBarrier(),child=makeHandle(saved.task_id);f.store.mutate(saved.task_id,()=>saved);let resumes=0
 const runner:ManagedRunner={start:async()=>{throw Error("must resume paused")},resume:async()=>{resumes++;return child.handle}}
 const manager=createTaskManager({...f.options,admissionBarrier:barrier,runners:{"in-process":runner,process:runner}});barrier.close(present(saved.root_session_id),1)
 const result=await manager.respawn(saved,join(f.options.cwd,"paused.jsonl"),undefined,{paused:true})
 expect(result.ok).toBe(true);expect(resumes).toBe(1);expect(child.followUpCalls).toEqual([]);expect(child.steerCalls).toEqual([]);expect(f.store.load(saved.task_id)).toMatchObject({status:"paused",notification:saved.notification})
 if(result.ok)await result.handle.dispose()
})
for(const failure of [false,true])test(`both recovery teardown passes join late launches and preserve ${failure?"failure containment":"healthy ordering"}`,async()=>{
 const f=configuration(),entered=Promise.withResolvers<string>(),release=Promise.withResolvers<void>(),firstDrain=Promise.withResolvers<void>(),events:string[]=[];let drains=0
 let child:ReturnType<typeof makeHandle>|undefined
 const runner:ManagedRunner={start:async spec=>{child=makeHandle(spec.taskId);entered.resolve(spec.taskId);await release.promise;events.push("late-launch");return child.handle}}
 const service:TaskRecoveryRuntime={respawn:async()=>{throw Error("not invoked")},settleTeardowns:async function(){expect(this).toBe(service);events.push(`drain-${++drains}`);if(drains===1)firstDrain.resolve();if(failure)throw Error("controlled recovery teardown failure")}}
 const manager=createTaskManagerImplementation({...f.options,runners:{"in-process":runner,process:runner}},{preparePlanning:async()=>{},createRecoveryRuntime:()=>service})
 const starting=manager.start(baseSpec({execution_mode:"process"}));const taskId=await entered.promise;const shutdown=present(manager.settleLaunchesForShutdown).call(manager, 1000)
 try{await firstDrain.promise;expect(drains).toBe(1);release.resolve();await shutdown;await starting;expect(drains).toBe(2);expect(events.indexOf("drain-2")).toBeGreaterThan(events.indexOf("late-launch"))}
 finally{release.resolve();await shutdown;await starting;manager.forget(taskId,{path:"park"});child?.settle({status:"cancelled"});manager.workpools.dispose()}
})
