import { expect, test } from "bun:test"
import { InputUncertainError, type OwnedSessionIdentity, type TaskRecord } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { ChildHandle, ChildRecord, createSessionBackend } from "../../host/session-backend"
import type { OwnedChildObserver } from "../../host/owned-child-observer"
import { createSessionScopes } from "../../host/session-state"
import { createOwnedTurnTicket } from "./owned-turn"

/** Ticket protocol unit only. Real backend and actual host acceptance have separate drivers. */
function fixture(mode: "accepted" | "no-call" | "invoked-unknown") {
  const scopes=createSessionScopes(),policy={tools:[] as string[],authorize(){}}
  const locator={format:1 as const,backendID:"unit",hostVersion:"2.2.6",location:"/unit",parentID:"parent" as never,sessionID:"child" as never,generation:1}
  const child:ChildHandle={locator,lease:scopes.open(locator.sessionID,policy)}
  const reference:OwnedSessionIdentity={...locator,journalKey:"unit-key",journalOwner:"unit-owner",journalRevision:1,runEpoch:0,residencyClaim:"claim"}
  const prior:TaskRecord={task_id:"native",parent_session_id:"parent",root_session_id:"parent",depth:1,execution_mode:"in-process",model:"qa/model",notify_on_terminal:false,status:"completed",residency_state:"resident",created_at:new Date(0).toISOString(),updated_at:new Date(0).toISOString(),notification:{run_epoch:0,notified_epoch:0},owned_session:reference,residency_claim:"claim"}
  let row:ChildRecord={key:"unit-key",owner:"unit-owner",revision:1,locator,phase:"accepted",admission:"accepted",receipts:{initial:"accepted"}}
  const events:string[]=[],ids:string[]=[],work:Promise<unknown>[]=[],admissions:Promise<void>[]=[];let invoked=false
  const backend={
    checkpointTurn(_child:ChildHandle,turn:ChildRecord["turn"]){row={...row,turn,revision:row.revision+1};return row},
    preparePromptContinuation(_child:ChildHandle,input:{id:string},options:{signal:AbortSignal}){
      return {invoked:()=>invoked,async send(){events.push("send");options.signal.throwIfAborted();if(mode==="no-call")throw Error("private no-call refusal");invoked=true;if(mode==="invoked-unknown")throw Error("lost ACK");return {state:"accepted",inboxID:input.id,consumption:"unconfirmed"}},
        restoreTurn(turn:ChildRecord["turn"]){if(invoked)throw Error("invoked");events.push("restore");row={...row,turn,revision:row.revision+1};return row}}
    },
  } as unknown as ReturnType<typeof createSessionBackend>
  const observer={expectInput(id:string){ids.push(id)}} as unknown as OwnedChildObserver
  const controller=new AbortController()
  const ticket=createOwnedTurnTicket({prior,nextEpoch:1,child,backend,observer,observationKey:"fresh",priorDescriptor:undefined,signal:controller.signal,
    assertOwned(){events.push("guard")},identify(){events.push("identify")},publish(actual,next,pending){events.push("publish");admissions.push(pending);return {...reference,runEpoch:next.notification.run_epoch,journalRevision:actual.revision}},
    restoreReference(actual,old){return {...old.owned_session!,journalRevision:actual.revision}},async synchronize(){events.push("synchronize")},async accepted(){events.push("accepted")},failure(){events.push("failure")},async release(){events.push("release")},track(pending){work.push(pending)},serialize:operation=>operation()})
  return {ticket,prior,events,ids,work,admissions,controller,close:()=>scopes.dispose()}
}

test("ticket publishes one fresh owned ID/current before dispatch and keeps genuine ACK separate from outcome",async()=>{
 const f=fixture("accepted")
 try{const next=f.ticket.stamp({...f.prior,status:"running",notification:{...f.prior.notification,run_epoch:1}})
  expect(next.owned_session?.runEpoch).toBe(1);expect(f.ids).toHaveLength(1);expect(f.ids[0]).toMatch(/^msg_omo_/)
  expect(f.events).not.toContain("send");expect(await f.ticket.dispatch("next")).toEqual({kind:"accepted"});await f.admissions[0]
  expect(f.events.indexOf("publish")).toBeLessThan(f.events.indexOf("send"));await f.ticket.release();expect(f.events).not.toContain("release")
 }finally{f.close()}
})

test("ticket known no-call restores only reference and releases without an ACK",async()=>{
 const f=fixture("no-call")
 try{f.ticket.stamp({...f.prior,status:"running",notification:{...f.prior.notification,run_epoch:1}})
  expect((await f.ticket.dispatch("next")).kind).toBe("not-dispatched");expect(f.ticket.restoreOwnedReference(f.prior)?.runEpoch).toBe(0)
  await f.ticket.release();expect(f.events).toContain("restore");expect(f.events).toContain("release");expect(f.events).not.toContain("accepted")
 }finally{f.close()}
})

test("ticket invoked unknown is canonical, cannot restore, and retains a rejected current",async()=>{
 const f=fixture("invoked-unknown")
 try{f.ticket.stamp({...f.prior,status:"running",notification:{...f.prior.notification,run_epoch:1}})
  await expect(f.ticket.dispatch("next")).rejects.toBeInstanceOf(InputUncertainError);expect(()=>f.ticket.restoreOwnedReference(f.prior)).toThrow("cannot be restored")
  expect(f.events).toContain("failure");await f.ticket.release();expect(f.events).not.toContain("release");expect(f.work).toHaveLength(1)
 }finally{f.close()}
})
