import { expect, test } from "bun:test"
import { withJoinedSessionCancellation } from "./session-cancellation"
import { createOwnedChildObserver } from "./owned-child-observer"
import type { OwnedChildObservationStore, ObservationRecord, ObservationSnapshot } from "./owned-child-observation-types"
import type { ChildHandle } from "./session-backend"
function fixture(emitBarrier = true) {
 const lifetime=new AbortController();let live=true,sequence=0,ended=false,hookDisposed=0,streamClosed=0
 const hooks=new Map<string,(input:any)=>unknown>();const queue:any[]=[];let wake:((value:IteratorResult<any>)=>void)|undefined
 const child={locator:{format:1,backendID:"test",location:"/project",hostVersion:"2.2.6",parentID:"parent",sessionID:"child",generation:1},lease:{sessionID:"child",generation:2,signal:lifetime.signal}} as ChildHandle
 const binding={key:"task",token:"binding",locator:child.locator};const records:ObservationRecord[]=[];const uncertainty:string[]=[]
 const guard=()=>{if(!live||lifetime.signal.aborted)throw Error("custody lost")}
 const store:OwnedChildObservationStore={bind(input){input.guard();return {binding,append(record){input.guard();records.push(structuredClone(record))},snapshot():ObservationSnapshot{input.guard();return {binding,records:structuredClone(records),uncertainty:[...uncertainty]}},invalidate(reason){uncertainty.push(reason)}}},close(){}}
 function end(){ended=true;if(wake){wake({done:true,value:undefined});wake=undefined}}
 function emit(type:string,data:Record<string,unknown>={}){const value={id:`evt_${sequence}`,type,created:sequence,durable:{aggregateID:"child",seq:sequence++,version:1},data:{sessionID:"child",...data}};if(wake){const yes=wake;wake=undefined;yes({done:false,value})}else queue.push(value)}
 const ctx:any={event:{subscribe({signal}:any){signal.addEventListener("abort",end,{once:true});return {[Symbol.asyncIterator](){return {async next(){if(queue.length)return {done:false,value:queue.shift()};if(ended)return {done:true,value:undefined};return new Promise<IteratorResult<any>>(yes=>wake=yes)},async return(){streamClosed++;end();return {done:true,value:undefined}}}}}}},session:{async hook(name:string,callback:any){hooks.set(name,callback);return {dispose(){hookDisposed++;hooks.delete(name)}}},async update({title}:any){if(emitBarrier)emit("session.title.updated",{title})}}}
 withJoinedSessionCancellation(ctx.session,"controlled-test")
 const options={key:"task",child,guard,store,title:"Actual task title",timeoutMs:1000}
 async function finish(text="final"){
  await hooks.get("model.request")?.({sessionID:"child",kind:"primary",model:{providerID:"actual",id:"observed"}})
  emit("session.execution.started");emit("session.inbox.delivered",{inboxID:"own"});emit("session.step.started",{assistantMessageID:"assistant",agent:"build",model:{providerID:"actual",id:"observed"}})
  emit("session.text.started",{assistantMessageID:"assistant",ordinal:0});emit("session.text.ended",{assistantMessageID:"assistant",ordinal:0,text});emit("session.step.ended",{assistantMessageID:"assistant",finish:"stop",tokens:{input:1,output:2},cost:0});emit("session.execution.succeeded")
 }
 return {ctx,options,emit,finish,records,uncertainty,hooks,lifetime,end,lose(){live=false},metrics:()=>({hookDisposed,streamClosed,ended})}
}

test("actual observed owned title event establishes readiness; wait follows received terminal",async()=>{
 const f=fixture(),observer=await createOwnedChildObserver(f.ctx,f.options)
 expect(f.records.some(row=>row.kind==="host"&&row.event.type==="session.title.updated")).toBe(true)
 await expect(observer.waitForOutcome()).rejects.toThrow("expected")
 observer.expectInput("own");const result=observer.waitForOutcome();await f.finish("final response")
 expect(await result).toMatchObject({status:"completed",text:"final response",model:{providerID:"actual",id:"observed"},consumption:"unconfirmed"})
 await observer.dispose();expect(f.metrics().hookDisposed).toBe(1);expect(f.metrics().ended).toBe(true)
 expect(observer.outcome().status).toBe("uncertain");expect(()=>observer.expectInput("late")).toThrow()
})

test("missing readiness event fails closed and disposes registration and stream",async()=>{
 const f=fixture(false)
 await expect(createOwnedChildObserver(f.ctx,{...f.options,timeoutMs:10})).rejects.toThrow("readiness-timeout")
 expect(f.metrics().hookDisposed).toBe(1);expect(f.metrics().ended).toBe(true);expect(f.records).toEqual([])
})

test("guard loss makes waiting result uncertain and ends observation",async()=>{
 const f=fixture(),observer=await createOwnedChildObserver(f.ctx,f.options);observer.expectInput("own");const waiting=observer.waitForOutcome()
 f.lose();f.emit("session.execution.started")
 expect((await waiting).status).toBe("uncertain");expect(f.uncertainty.length).toBeGreaterThan(0)
 await observer.dispose()
})

test("stream closure cannot fabricate a result and a caller wait abort leaves observer alive",async()=>{
 const f=fixture(),observer=await createOwnedChildObserver(f.ctx,f.options);observer.expectInput("own")
 const stop=new AbortController();const abandoned=observer.waitForOutcome(stop.signal);stop.abort(Error("caller cancelled"));await expect(abandoned).rejects.toThrow("caller cancelled")
 const waiting=observer.waitForOutcome();f.end();expect((await waiting).status).toBe("uncertain");await observer.dispose()
})

test("late registration after lifetime abort is disposed and never activates observer",async()=>{
 const f=fixture();let release!:()=>void;const hold=new Promise<void>(yes=>release=yes);const hook=f.ctx.session.hook
 f.ctx.session.hook=async(...args:any[])=>{const handle=await hook(...args);await hold;return handle}
 const creation=createOwnedChildObserver(f.ctx,f.options);f.lifetime.abort();release()
 await expect(creation).rejects.toThrow();expect(f.metrics().hookDisposed).toBe(1);expect(f.records).toEqual([])
})


test("readiness timeout also aborts a pending public title request",async()=>{
 const f=fixture(false);let aborted=false
 f.ctx.session.update=async(_input:any,{signal}:any)=>new Promise((_yes,no)=>{const stop=()=>{aborted=true;no(signal.reason)};if(signal.aborted)stop();else signal.addEventListener("abort",stop,{once:true})})
 await expect(createOwnedChildObserver(f.ctx,{...f.options,timeoutMs:10})).rejects.toThrow("readiness-timeout")
 expect(aborted).toBe(true);expect(f.metrics().hookDisposed).toBe(1);expect(f.metrics().ended).toBe(true)
})


test("bare Promise session cannot claim title-request cancellation through a truthy config flag",async()=>{
 const f=fixture();let updateCalled=false
 const bare={hook:f.ctx.session.hook,async update(){updateCalled=true},joinedCancellation:true}
 await expect(createOwnedChildObserver({...f.ctx,session:bare},f.options)).rejects.toThrow("joined session cancellation")
 expect(updateCalled).toBe(false);expect(f.records).toEqual([]);expect(f.hooks.size).toBe(0)
})
