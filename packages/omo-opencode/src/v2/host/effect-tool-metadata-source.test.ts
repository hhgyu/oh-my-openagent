import { expect, test } from "bun:test"
import { Effect, Scope, Exit } from "effect"
import type { ToolDomain } from "@opencode/plugin/effect/tool"
import { acquireEffectToolMetadataSource, openOwnedToolMetadataSubscription } from "./effect-tool-metadata-source"

export async function metadataFixture(options = {}) {
 const scope=Scope.makeUnsafe();let callback:((input:unknown)=>Effect.Effect<void>)|undefined,disposed=0
 const tool={hook(name:string,fn:(input:unknown)=>Effect.Effect<void>){expect(name).toBe("execute.after");return Effect.gen(function*(){callback=fn;const dispose=Effect.sync(()=>{disposed++;callback=undefined});yield*Effect.addFinalizer(()=>dispose);return {dispose}})}} as unknown as ToolDomain
 const source=await Effect.runPromise(Effect.provideService(acquireEffectToolMetadataSource(tool,options),Scope.Scope,scope))
 return {source,async emit(value:unknown){if(callback)await Effect.runPromise(callback(value))},async close(){await Effect.runPromise(Scope.close(scope,Exit.succeed(undefined)))},disposed:()=>disposed}
}
const after=(extra={})=>({sessionID:"child",messageID:"assistant",id:"call_actual",tool:"routed_final",status:"completed",input:{secret:"unsafe"},result:{content:"unsafe"},...extra})

test("only scoped factory source can open a bounded pull subscription",async()=>{
 expect(()=>openOwnedToolMetadataSubscription({} as never,"child")).toThrow("source")
 const f=await metadataFixture(),s=openOwnedToolMetadataSubscription(f.source,"child")
 await f.emit(after());expect(s.drain()).toMatchObject({records:[{sessionID:"child",messageID:"assistant",callID:"call_actual",tool:"routed_final",status:"completed"}],closed:false})
 s.close();await f.close();expect(f.disposed()).toBe(1);expect(()=>openOwnedToolMetadataSubscription(f.source,"child")).toThrow("closed")
})
test("after-only projection ignores foreign sessions and never reads raw payloads",async()=>{
 const f=await metadataFixture(),s=openOwnedToolMetadataSubscription(f.source,"child")
 await f.emit(after({sessionID:"foreign"}));expect(s.drain().records).toEqual([])
 const raw=after();for(const field of ["input","result","error"])Object.defineProperty(raw,field,{get(){throw Error("raw accessed")}})
 await f.emit(raw);const rows=s.drain().records;expect(rows[0]?.tool).toBe("routed_final");expect(JSON.stringify(rows)).not.toContain("unsafe")
 await f.emit(after({id:"call_error",status:"error"}));expect(s.drain().records[0]?.status).toBe("error");s.close();await f.close()
})
test("malformed owned identity and bounded overflow are sticky explicit gaps",async()=>{
 for(const bad of [{messageID:"bad\nidentity"},{id:"x".repeat(4097)},{tool:""},{status:"running"}]){
  const f=await metadataFixture(),s=openOwnedToolMetadataSubscription(f.source,"child");await f.emit(after(bad));expect(s.drain().issue).toBe("malformed-tool-metadata");s.close();await f.close()
 }
 const f=await metadataFixture({maxEntries:1}),s=openOwnedToolMetadataSubscription(f.source,"child")
 await f.emit(after());await f.emit(after({id:"second"}));expect(s.drain()).toMatchObject({issue:"tool-metadata-overflow",records:[{callID:"call_actual"}]});expect(s.drain().issue).toBe("tool-metadata-overflow");s.close();await f.close()
})
test("scope close wakes pending pulls; cancellation and subscriber close release all waits",async()=>{
 const f=await metadataFixture(),s=openOwnedToolMetadataSubscription(f.source,"child"),abort=new AbortController()
 const wait=s.wait(abort.signal);abort.abort(Error("cancel"));await expect(wait).rejects.toThrow("cancel")
 const pending=s.wait();await f.close();await pending;expect(s.drain()).toMatchObject({closed:true,issue:"tool-metadata-source-closed"});s.close()
})

test("byte/subscription limits are bounded and subscriptions release capacity on close",async()=>{
 const f=await metadataFixture({maxBytes:1,maxSubscriptions:1}),s=openOwnedToolMetadataSubscription(f.source,"child")
 expect(()=>openOwnedToolMetadataSubscription(f.source,"other")).toThrow("limit");await f.emit(after());expect(s.drain().issue).toBe("tool-metadata-overflow");s.close()
 const next=openOwnedToolMetadataSubscription(f.source,"other");next.close();await f.close()
 for(const options of [{maxEntries:0},{maxBytes:NaN},{maxSubscriptions:-1}])await expect(metadataFixture(options)).rejects.toThrow("limits")
})
test("scope retirement releases queued rows and new root source never adopts earlier history",async()=>{
 const first=await metadataFixture(),s=openOwnedToolMetadataSubscription(first.source,"child");await first.emit(after());await first.close()
 expect(s.drain()).toMatchObject({closed:true,issue:"tool-metadata-source-closed",records:[{callID:"call_actual"}]});s.close()
 const second=await metadataFixture(),fresh=openOwnedToolMetadataSubscription(second.source,"child");expect(fresh.drain().records).toEqual([]);fresh.close();await second.close()
})

test("subscriber close clears retained rows even after root scope already retired it",async()=>{
 const f=await metadataFixture(),s=openOwnedToolMetadataSubscription(f.source,"child");await f.emit(after());await f.close();s.close();expect(s.drain().records).toEqual([])
})

test("a mailbox permits only one outstanding notification pull",async()=>{
 const f=await metadataFixture(),s=openOwnedToolMetadataSubscription(f.source,"child"),pending=s.wait()
 await expect(s.wait()).rejects.toThrow("already pending");s.close();await pending;await f.close()
})
