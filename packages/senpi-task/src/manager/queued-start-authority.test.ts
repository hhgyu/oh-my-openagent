import { afterEach, expect, test } from "bun:test"
import { AdmissionBarrier } from "../pause/admission-barrier"
import type { PauseParticipant } from "../pause/registry"
import { createTaskRecord } from "../state"
import { createTaskRecordStore } from "../store"
import { TaskConcurrency } from "./concurrency"
import { HeldAdmissions } from "./held-admissions"
import { enterStartAdmission, type HostStartAuthority } from "./start-admission"
import type { LaunchContext } from "./launch-task"
import { cleanupProjects, tempProject } from "./__fixtures__/manager-fakes"

afterEach(cleanupProjects)
function authority():HostStartAuthority {const c=new AbortController();return {admissionSignal:c.signal,lifetimeSignal:c.signal,assertAdmission(){c.signal.throwIfAborted()},assertLifetime(){c.signal.throwIfAborted()}}}
function fixture(){
 const cwd=tempProject(),store=createTaskRecordStore({project_dir:cwd}),barrier=new AdmissionBarrier(),concurrency=new TaskConcurrency({default_concurrency:1})
 const record=createTaskRecord({parent_session_id:"parent",root_session_id:"parent",depth:1,execution_mode:"in-process",model:"qa/model",notify_on_terminal:false})
 const saved={...record,host_pid:6000,spawn_spec:{version:1 as const,cwd,prompt:"queued"}};store.save(saved)
 const participant:PauseParticipant={key:record.task_id,taskId:record.task_id,runEpoch:0,runRef:{kind:"task",id:record.task_id},kind:"held_admission",state:"held",at:new Date(0).toISOString(),admission:{model:record.model,laneKey:concurrency.getKey(record.model),sequence:1,phase:"pre_grant"}}
 return {cwd,store,barrier,concurrency,record:saved,participant}
}

test("held resume with configured host capture but no fresh authority refuses before record or barrier mutation",()=>{
 const f=fixture(),launched:LaunchContext[]=[],capture=(()=>undefined) as unknown as ()=>HostStartAuthority
 f.barrier.close("parent",1);const credential=f.barrier.resume("parent",1,"resume")
 const held=new HeldAdmissions({store:f.store,barrier:f.barrier,concurrency:f.concurrency,hostPid:6000,captureStartAuthority:capture,
  resolveRunner:()=>({start:async()=>{throw Error("No runner expected")}}),launch:context=>{launched.push(context)}})
 const before=f.store.load(f.record.task_id)
 expect(()=>held.resume(f.participant,credential)).toThrow("Missing host authority")
 expect(f.store.load(f.record.task_id)).toEqual(before);expect(f.barrier.inFlight("parent")).toEqual([]);expect(launched).toEqual([]);f.store.close()
})

test("warm held resume replaces the old guard with fresh B and queued grant never captures later C",()=>{
 const f=fixture(),a=authority(),b=authority(),c=authority(),launched:LaunchContext[]=[]
 let current=a
 const held=new HeldAdmissions({store:f.store,barrier:f.barrier,concurrency:f.concurrency,hostPid:6000,captureStartAuthority:()=>current,
  resolveRunner:()=>({start:async()=>{throw Error("No actual runner expected")}}),launch:context=>{launched.push(context)}})
 const entered=enterStartAdmission({barrier:f.barrier,spec:{prompt:"queued",parent_session_id:"parent",depth:1},taskId:f.record.task_id,hostAuthority:a})
 if(entered.kind!=="entered")throw Error("held")
 expect(f.concurrency.tryAcquire(f.record.model,"foreign",0)).toBe(true)
 held.enqueue({record:f.record,model:f.record.model,runner:{start:async()=>{throw Error("No actual runner expected")}},managedSpec:{admission:entered.scope,taskId:f.record.task_id,cwd:f.cwd,stateDir:f.store.stateDir,prompt:"queued",depth:1,parentSessionId:"parent",rootSessionId:"parent"}})
 held.withdraw([f.record.task_id]);f.barrier.close("parent",1);const credential=f.barrier.resume("parent",1,"resume")
 current=b;expect(held.resume(f.participant,credential).kind).toBe("resumed");current=c
 expect(launched).toEqual([]);f.concurrency.releaseTask("foreign")
 expect(launched).toHaveLength(1);expect(launched[0]!.managedSpec.admission?.hostAuthority).toBe(b)
 expect(launched[0]!.managedSpec.admission?.hostAuthority).not.toBe(a);expect(launched[0]!.managedSpec.admission?.hostAuthority).not.toBe(c)
 launched[0]!.managedSpec.admission?.leave();f.concurrency.releaseTask(f.record.task_id);f.store.close()
})
