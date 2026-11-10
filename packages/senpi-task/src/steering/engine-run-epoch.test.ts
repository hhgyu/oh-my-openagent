import { readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import type { TaskRecordStore } from "../store"
import { cleanupSteering, makeFakeHandle, makeHarness, type SteeringHarness } from "./__fixtures__/steering-fakes"
import type { TaskRecord } from "../state"
import { fenceRun, nextRunEpoch } from "../state"
import { createTaskRecordStore } from "../store"

afterEach(cleanupSteering)

test("prepared known no-dispatch restores terminal fields, burns issued epoch across reload and preserves fresh queue/effects",async()=>{
 const h=makeHarness(),r=h.seedRecord();toCompleted(h,r)
 h.store.mutate(r.task_id,f=>({...f,host_pid:100,prior_runs_cost_usd:2,run_stats:{runtime_ms:1,turns:1,tool_calls:0,cost_usd:3,cost_status:"reported"},pending_steering:[{id:"prior",message:"prior queued",deliver_as:"followUp"}]}))
 const fake=makeFakeHandle(r.task_id,"in-process"),calls:string[]=[],sent:string[]=[]
 Object.assign(fake.handle,{prepareFollowUp:async()=>({
  stamp:(next:TaskRecord)=>{calls.push("stamp");return next},
  dispatch:async(text:string)=>{calls.push("dispatch");sent.push(text);h.store.mutate(r.task_id,f=>({...f,effect_seq:9,last_effect_id:"fresh-effect",pending_steering:[...f.pending_steering!,{id:"fresh",message:"fresh queued",deliver_as:"steer"}]}));return {kind:"not-dispatched" as const,reason:"proven before host call"}},
  restoreOwnedReference:(prior:TaskRecord)=>prior.owned_session,
  retainFailure:()=>{calls.push("retained")},release:async()=>{calls.push("release")},
 })})
 h.setLive(r.task_id,fake.handle)
 const answer=await h.engine.sendToTask({idOrName:r.task_id,message:"new turn"})
 expect(answer.kind).toBe("not_continuable");expect(fake.followUpCalls).toEqual([])
 const restored=createTaskRecordStore({project_dir:"/unused",task:{state_dir:h.store.stateDir}}).load(r.task_id)!
 expect(restored.status).toBe("completed");expect(restored.final_response).toBe("first pass")
 expect(restored.notification.run_epoch).toBe(0);expect(restored.burnt_epoch).toBe(1);expect(nextRunEpoch(restored)).toBe(2)
 expect(fenceRun(restored,1)).toBe("unknown");expect(restored.effect_seq).toBe(9);expect(restored.last_effect_id).toBe("fresh-effect")
 expect(restored.pending_steering?.map(x=>x.id)).toEqual(["prior","fresh"]);expect(restored.prior_runs_cost_usd).toBe(2)
 expect(restored.run_stats?.cost_usd).toBe(3)
 expect(sent).toEqual(["prior queued\n\nnew turn"]);expect(calls).toEqual(["stamp","dispatch","release"]);expect(h.reviveCalls).toEqual([])
 delete (fake.handle as Partial<typeof fake.handle>&{prepareFollowUp?:unknown}).prepareFollowUp
 const next=await h.engine.sendToTask({idOrName:r.task_id,message:"retry explicitly"})
 expect(next.kind).toBe("revived");expect(h.store.load(r.task_id)?.notification.run_epoch).toBe(2)
 expect(h.store.load(r.task_id)?.prior_runs_cost_usd).toBe(5)
 expect(fenceRun(h.store.load(r.task_id)!,1)).toBe("superseded")
 const before=fake.followUpCalls.length
 expect((await h.engine.sendToTask({idOrName:r.task_id,message:"stale",expectedRunEpoch:1})).kind).toBe("stale")
 expect(fake.followUpCalls).toHaveLength(before)
})

test.each(["cancel","owner","epoch","claim","handle"] as const)("prepared no-dispatch rollback never overwrites a newer %s",async race=>{
 const h=makeHarness(),r=h.seedRecord();toCompleted(h,r);const fake=makeFakeHandle(r.task_id,"in-process");let releases=0,restores=0
 fake.handle.prepareFollowUp=async()=>({stamp:next=>next,dispatch:async()=>{
  if(race==="handle")h.setLive(r.task_id,makeFakeHandle(r.task_id,"in-process").handle)
  else h.store.mutate(r.task_id,f=>({...f,...(race==="cancel"?{status:"cancelled" as const}:race==="owner"?{host_pid:999}:race==="claim"?{residency_claim:"new-owner"}:{notification:{...f.notification,run_epoch:2},run_start_epoch:2})}))
  return {kind:"not-dispatched",reason:"private no-call witness"}
 },restoreOwnedReference:()=>{restores++;return undefined},retainFailure:()=>{throw Error("foreign state must not be retained locally")},release:async()=>{releases++}})
 h.setLive(r.task_id,fake.handle);const answer=await h.engine.sendToTask({idOrName:r.task_id,message:"new"})
 expect(answer.kind).toBe("not_continuable");expect(h.store.load(r.task_id)?.notification.run_epoch).toBe(race==="epoch"?2:1)
 expect(h.store.load(r.task_id)?.burnt_epoch).toBeUndefined();expect(restores).toBe(0);expect(releases).toBe(1);expect(h.reviveCalls).toEqual([])
})

test.each(["restore-custody","restore-write","generic-dispatch"] as const)("prepared %s failure retains the issued run instead of borrowing prior completion",async failure=>{
 const h=makeHarness(),r=h.seedRecord();toCompleted(h,r);const fake=makeFakeHandle(r.task_id,"in-process");let releases=0;const retained:string[]=[]
 const mutate=h.store.mutate.bind(h.store);let mutations=0
 if(failure==="restore-write")Object.defineProperty(h.store,"mutate",{value:(...args:Parameters<TaskRecordStore["mutate"]>)=>{if(++mutations===2)throw Error("actual rollback store unavailable");return mutate(...args)}})
 fake.handle.prepareFollowUp=async()=>({stamp:next=>next,dispatch:async()=>{if(failure==="generic-dispatch")throw Error("unknown adapter contract failure");return {kind:"not-dispatched",reason:"private no-call witness"}},
  restoreOwnedReference:()=>{if(failure==="restore-custody")throw Error("journal custody unproven");return undefined},retainFailure:reason=>{retained.push(reason)},release:async()=>{releases++}})
 h.setLive(r.task_id,fake.handle);const answer=await h.engine.sendToTask({idOrName:r.task_id,message:"new"})
 expect(answer.kind).toBe("not_continuable");expect(h.store.load(r.task_id)?.status).toBe("running");expect(h.store.load(r.task_id)?.notification.run_epoch).toBe(1)
 expect(h.store.load(r.task_id)?.final_response).toBeUndefined();expect(h.store.load(r.task_id)?.burnt_epoch).toBeUndefined()
 expect(retained).toHaveLength(1);expect(releases).toBe(0);expect(h.reviveCalls).toEqual([r.task_id])
 if(failure==="generic-dispatch")expect(retained[0]).toContain("without a proven no-dispatch result")
})

test("store failure after admitted write still restores only actual fenced current and burns it",async()=>{
 const h=makeHarness(),r=h.seedRecord();toCompleted(h,r);const fake=makeFakeHandle(r.task_id,"in-process");let dispatches=0
 const mutate=h.store.mutate.bind(h.store);let first=true
 Object.defineProperty(h.store,"mutate",{value:(...args:Parameters<TaskRecordStore["mutate"]>)=>{const next=mutate(...args);if(first){first=false;throw Error("actual post-write failure")};return next}})
 fake.handle.prepareFollowUp=async()=>({stamp:next=>next,dispatch:async()=>{dispatches++;return {kind:"accepted"}},restoreOwnedReference:()=>undefined,retainFailure:()=>{},release:async()=>{}})
 h.setLive(r.task_id,fake.handle);expect((await h.engine.sendToTask({idOrName:r.task_id,message:"new"})).kind).toBe("not_continuable")
 expect(dispatches).toBe(0);expect(h.store.load(r.task_id)?.status).toBe("completed");expect(h.store.load(r.task_id)?.notification.run_epoch).toBe(0);expect(h.store.load(r.task_id)?.burnt_epoch).toBe(1)
})

test("rollback restores the prior owned run with its refreshed actual ticket revision in one valid record write",async()=>{
 const h=makeHarness(),r=h.seedRecord();toCompleted(h,r)
 const reference={format:1 as const,backendID:"contract-fixture",location:h.store.stateDir,hostVersion:"2.2.6",parentID:"parent-1",sessionID:"fixture-child",generation:1,journalKey:"owned-run",journalOwner:"actual-ticket-fixture-owner",journalRevision:1,runEpoch:0,residencyClaim:"claim"}
 h.store.mutate(r.task_id,f=>({...f,runner_kind:"owned-session",child_session_id:reference.sessionID,residency_claim:reference.residencyClaim,owned_session:reference}))
 const fake=makeFakeHandle(r.task_id,"in-process")
 fake.handle.prepareFollowUp=async()=>({stamp:next=>({...next,owned_session:{...reference,runEpoch:next.notification.run_epoch,journalRevision:2}}),
  dispatch:async()=>({kind:"not-dispatched",reason:"private no-call fixture witness"}),restoreOwnedReference:prior=>({...prior.owned_session!,journalRevision:3}),retainFailure:()=>{},release:async()=>{}})
 h.setLive(r.task_id,fake.handle);expect((await h.engine.sendToTask({idOrName:r.task_id,message:"new"})).kind).toBe("not_continuable")
 const restored=createTaskRecordStore({project_dir:"/unused",task:{state_dir:h.store.stateDir}}).load(r.task_id)!
 expect(restored.notification.run_epoch).toBe(0);expect(restored.owned_session?.runEpoch).toBe(0);expect(restored.owned_session?.journalRevision).toBe(3);expect(restored.burnt_epoch).toBe(1)
})

function toRunning(harness: SteeringHarness, record: TaskRecord): void {
  harness.store.transition(record.task_id, { type: "start", timestamp: new Date().toISOString() })
}

function toCompleted(harness: SteeringHarness, record: TaskRecord): void {
  toRunning(harness, record)
  harness.store.transition(record.task_id, { type: "complete", timestamp: new Date().toISOString(), final_response: "first pass" })
}

type LoggedEvent = { readonly type: string; readonly payload?: Record<string, unknown> }

function readEventLog(store: TaskRecordStore, taskId: string): readonly LoggedEvent[] {
  const raw = readFileSync(join(store.stateDir, "logs", `${taskId}.jsonl`), "utf8")
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LoggedEvent)
}

describe("steering event log run epochs", () => {
  test("#given a steer delivered during run_epoch 2 #when the event is appended #then the payload carries run_epoch 2 and survives redaction", async () => {
    // given: two revives lift the record to run_epoch 2
    const harness = makeHarness()
    const record = harness.seedRecord()
    toCompleted(harness, record)
    const fake = makeFakeHandle(record.task_id, "in-process")
    harness.setLive(record.task_id, fake.handle)
    await harness.engine.sendToTask({ idOrName: record.task_id, message: "again" })
    harness.store.transition(record.task_id, {
      type: "complete",
      timestamp: new Date().toISOString(),
      final_response: "second pass",
    })
    await harness.engine.sendToTask({ idOrName: record.task_id, message: "once more" })
    expect(harness.store.load(record.task_id)?.notification.run_epoch).toBe(2)

    // when
    const outcome = await harness.engine.sendToTask({ idOrName: record.task_id, message: "keep going", deliverAs: "steer" })

    // then
    expect(outcome.kind).toBe("steered")
    const steered = readEventLog(harness.store, record.task_id).filter((event) => event.type === "steered")
    expect(steered).toHaveLength(1)
    expect(steered[0]?.payload).toEqual({ delivered: "steer", run_epoch: 2 })
  })

  test("#given a prelaunch send to a pending child #when queued #then the steer_queued payload carries the current run_epoch", async () => {
    // given
    const harness = makeHarness()
    const record = harness.seedRecord()

    // when
    const outcome = await harness.engine.sendToTask({ idOrName: record.task_id, message: "context first" })

    // then
    expect(outcome.kind).toBe("queued")
    const queued = readEventLog(harness.store, record.task_id).filter((event) => event.type === "steer_queued")
    expect(queued).toHaveLength(1)
    expect(queued[0]?.payload).toEqual({ queue_position: 1, deliverAs: "followUp", run_epoch: 0 })
  })

  test("#given a queued prelaunch message drained at launch #when delivered #then the steered event carries the launching run_epoch", async () => {
    // given
    const harness = makeHarness()
    const record = harness.seedRecord()
    await harness.engine.sendToTask({ idOrName: record.task_id, message: "context first" })
    toRunning(harness, record)
    harness.setLive(record.task_id, makeFakeHandle(record.task_id, "in-process").handle)

    // when
    await harness.engine.notifyStarted(record.task_id)

    // then
    const steered = readEventLog(harness.store, record.task_id).filter((event) => event.type === "steered")
    expect(steered).toHaveLength(1)
    expect(steered[0]?.payload).toEqual({ delivered: "followUp", queued: true, run_epoch: 0 })
  })
})
