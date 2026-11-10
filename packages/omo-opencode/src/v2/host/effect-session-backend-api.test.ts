import { afterAll, expect, test } from "bun:test"
import { Context, Effect, Schema, SchemaAST, DateTime, Scope, Exit } from "effect"
import { ClientApi } from "@opencode/protocol/client"
import type * as EffectPlugin from "@opencode/plugin/effect/plugin"
import type * as PromisePlugin from "@opencode/plugin/promise/plugin"
import { acquireEffectSessionBackendApi, createEffectSessionBackendApi, type EffectSessionBackendApi } from "./effect-session-backend-api"
import { hasJoinedSessionCancellation } from "./session-cancellation"

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}

const testScope=Scope.makeUnsafe()
const runtime=Context.make(Scope.Scope,testScope)
afterAll(()=>Effect.runPromise(Scope.close(testScope,Exit.succeed(undefined))))
const endpoints=ClientApi.groups["server.session"].endpoints
// Compile-checked public composition: no raw Context/domain assertion.
export function composePromiseSession(context:PromisePlugin.Context,bridge:EffectSessionBackendApi):PromisePlugin.Context {
 return {...context,session:{...context.session,...bridge}}
}
function output(name:keyof typeof endpoints,wire:unknown):unknown {
 const success=defined([...endpoints[name].success][0])
 const ast=Schema.toType(success).ast
 const field=SchemaAST.isObjects(success.ast)?success.ast.propertySignatures.find(p=>p.name==="data"):undefined
 const codec=SchemaAST.isObjects(ast)&&ast.propertySignatures.length===1&&ast.propertySignatures[0]?.name==="data"&&field?Schema.make<Schema.Codec<unknown,unknown>>(field.type):Schema.make<Schema.Codec<unknown,unknown>>(success.ast)
 return Schema.decodeUnknownSync(codec)(wire)
}
const wireSession={id:"ses_child",parentID:"ses_parent",projectID:"project",location:{directory:process.cwd()},time:{created:1234,updated:1235},cost:0,tokens:{input:0,output:0,reasoning:0,cache:{read:0,write:0}},metadata:{private:{nested:["preserve",42]}},title:"Task"}
function fake(overrides:Record<string,unknown>={}) {
 const calls:{method:string;input:unknown}[]=[]
 const method=(name:string,value:unknown)=>(input:unknown)=>Effect.sync(()=>{calls.push({method:name,input});return value})
 const session={create:method("create",output("session.create",wireSession)),get:method("get",output("session.get",wireSession)),list:method("list",output("session.list",{data:[wireSession],cursor:{}})),prompt:method("prompt",output("session.prompt",{id:"msg_input",sessionID:"ses_child",type:"user",delivery:"steer",payload:{text:"work"},time:{created:1234}})),synthetic:method("msg_synthetic",output("session.synthetic",{id:"msg_synthetic",sessionID:"ses_child",type:"synthetic",delivery:"steer",payload:{text:"next"},time:{created:1234}})),interrupt:method("interrupt",{interrupted:true}),wait:method("wait",undefined),remove:method("remove",undefined),update:method("update",undefined),context:method("context",output("session.context",[])),instructions:{entry:{list:method("instructions.list",[{key:"key",value:{nested:[1,"private"]}}]),put:method("instructions.put",undefined),remove:method("instructions.remove",undefined)}},...overrides} as unknown as EffectPlugin.Context["session"]
 return {calls,api:createEffectSessionBackendApi(session,runtime),session}
}
test("full bridge is nominally cancellable and codecs preserve create/list/get metadata and wire timestamps",async()=>{
 const f=fake();expect(hasJoinedSessionCancellation(f.api)).toBe(true);expect(hasJoinedSessionCancellation({...f.api})).toBe(true)
 const created=await f.api.create({id:"ses_child",parentID:"ses_parent",title:null,metadata:wireSession.metadata,location:{directory:process.cwd()}})
 expect(created as unknown).toEqual(wireSession);expect(await f.api.get({sessionID:"ses_child"}) as unknown).toEqual(wireSession)
 expect(await f.api.list({directory:process.cwd(),parentID:"ses_parent",limit:5}) as unknown).toEqual({data:[wireSession],cursor:{}})
 expect((defined(f.calls[0]).input as {metadata:unknown}).metadata).toEqual(wireSession.metadata)
})
test("attachments, prompt metadata, synthetic and instruction JSON round trip without dropping fields",async()=>{
 const f=fake();const files=[{uri:"data:text/plain;base64,SGk=",name:"fixture.txt",source:{type:"inline" as const}}]
 await f.api.prompt({sessionID:"ses_child",id:"msg_input",text:"work",files,metadata:{private:{flag:true}},resume:true})
 await f.api.synthetic({sessionID:"ses_child",id:"msg_synthetic",text:"next",description:null,metadata:{private:[1,2]},resume:false})
 await f.api.instructions.entry.put({sessionID:"ses_child",key:"key",value:{nested:[1,"private"]}})
 expect(await f.api.instructions.entry.list({sessionID:"ses_child"})).toEqual([{key:"key",value:{nested:[1,"private"]}}])
 await f.api.instructions.entry.remove({sessionID:"ses_child",key:"key"});await f.api.update({sessionID:"ses_child",title:"Updated",metadata:{private:"retained"}})
 expect(defined(f.calls.find(call=>call.method==="prompt")).input).toMatchObject({files,metadata:{private:{flag:true}}})
 expect(defined(f.calls.find(call=>call.method==="msg_synthetic")).input).toMatchObject({metadata:{private:[1,2]},resume:false})
 expect(defined(f.calls.find(call=>call.method==="instructions.put")).input).toMatchObject({value:{nested:[1,"private"]}})
})
test("preaborted signal never enters host and abort joins async finalizers before preserving reason",async()=>{
 const order:string[]=[];const reason={stop:true};const controller=new AbortController()
 const f=fake({wait:()=>Effect.never.pipe(Effect.onInterrupt(()=>Effect.promise(async()=>{await Bun.sleep(10);order.push("joined")})))})
 const pending=f.api.wait({sessionID:"ses_child"},{signal:controller.signal}).catch(error=>{order.push("rejected");throw error})
 await Bun.sleep(0);controller.abort(reason);await expect(pending).rejects.toBe(reason);expect(order).toEqual(["joined","rejected"])
 let entries=0;const g=fake({wait:()=>{entries++;return Effect.void}});await expect(g.api.wait({sessionID:"ses_child"},{signal:controller.signal})).rejects.toBe(reason);expect(entries).toBe(0)
})
test("invalid codec values are opaque and real host failures retain exact identity",async()=>{
 const f=fake();try{await f.api.get({sessionID:42} as never);throw Error("unexpected")}catch(error){expect(String(error)).toBe("SessionCodecError: Invalid session API value");expect((error as Error).cause).toBeUndefined()};expect(f.calls).toEqual([])
 const failure={providerFailure:true};const g=fake({get:()=>Effect.fail(failure)});await expect(g.api.get({sessionID:"ses_child"})).rejects.toBe(failure)
})
test("every remaining method is exercised and nonempty context dates encode back to wire numbers",async()=>{
 const message={id:"msg_observed",type:"idle" as const,outcome:"succeeded" as const,time:{created:5000}}
 const f=fake({context:()=>Effect.succeed(output("session.context",[message]))})
 expect(await f.api.context({sessionID:"ses_child"})).toEqual([message])
 expect(await f.api.interrupt({sessionID:"ses_child",resume:false})).toEqual({interrupted:true})
 expect(await f.api.wait({sessionID:"ses_child"})).toBeUndefined();expect(await f.api.remove({sessionID:"ses_child"})).toBeUndefined()
 expect(f.calls.filter(call=>["interrupt","wait","remove"].includes(call.method)).map(call=>call.method)).toEqual(["interrupt","wait","remove"])
 expect(defined(f.calls.find(call=>call.method==="interrupt")).input).toEqual({sessionID:"ses_child",resume:false})
 const decoded=output("session.create",wireSession) as {time:{created:unknown}}
 expect(DateTime.isDateTime(decoded.time.created)).toBe(true)
})
test("query-as-type supports numeric/bool filters and codec errors redact invalid private input/output",async()=>{
 const f=fake();await f.api.list({limit:3,archived:true,parentID:"ses_parent"})
 expect(defined(f.calls[0]).input).toMatchObject({limit:3,archived:true,parentID:"ses_parent"})
 const secret="synthetic-sensitive-rejected-value"
 try{await f.api.create({id:"ses_child",metadata:{invalid:BigInt(3),secret}} as never);throw Error("unexpected")}
 catch(error){expect(String(error)).toBe("SessionCodecError: Invalid session API value");expect(JSON.stringify(error)).not.toContain(secret)}
 const g=fake({get:()=>Effect.succeed({id:secret})})
 try{await g.api.get({sessionID:"ses_child"});throw Error("unexpected")}
 catch(error){expect(String(error)).toBe("SessionCodecError: Invalid session API value");expect((error as Error).cause).toBeUndefined()}
})
test("scoped host resource finalizers join successful calls too; plain objects cannot claim provenance",async()=>{
 const order:string[]=[]
 const f=fake({wait:()=>Effect.gen(function*(){yield*Effect.addFinalizer(()=>Effect.sync(()=>{order.push("finalized")}));order.push("body")})})
 await f.api.wait({sessionID:"ses_child"});order.push("returned");expect(order).toEqual(["body","finalized","returned"])
 expect(hasJoinedSessionCancellation({cancellable:true,cancellation:"effect-runtime"})).toBe(false)
 expect(hasJoinedSessionCancellation(JSON.parse(JSON.stringify(f.api)))).toBe(false)
})
test("owner scope closes no-caller-signal requests and joins asynchronous finalizers before scope end",async()=>{
 const scope=Scope.makeUnsafe(),order:string[]=[];let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve})
 const f=fake({wait:()=>Effect.gen(function*(){entered();yield*Effect.never}).pipe(Effect.onInterrupt(()=>Effect.promise(async()=>{await Bun.sleep(10);order.push("request-finalizer")})))})
 const api=await Effect.runPromise(Effect.provideService(acquireEffectSessionBackendApi(f.session),Scope.Scope,scope))
 const waiting=api.wait({sessionID:"ses_child"}).catch(error=>{order.push("request-rejected");return error})
 await ready;await Effect.runPromise(Scope.close(scope,Exit.succeed(undefined)));order.push("scope-ended")
 expect(await waiting).toBeInstanceOf(Error);expect(order).toEqual(["request-finalizer","request-rejected","scope-ended"])
 const calls=f.calls.length;await expect(api.get({sessionID:"ses_child"})).rejects.toThrow("closed");expect(f.calls).toHaveLength(calls)
 let decoded=0;const invalid=Object.defineProperty({},"sessionID",{get(){decoded++;throw Error("must not decode after close")}})
 await expect(api.get(invalid as never)).rejects.toThrow("closed");expect(decoded).toBe(0)
})
test("later component cleanup may call the API before owner finalizer closes it",async()=>{
 const scope=Scope.makeUnsafe(),order:string[]=[];const f=fake({remove:()=>Effect.sync(()=>{order.push("host-remove")})})
 let api!:EffectSessionBackendApi
 await Effect.runPromise(Effect.provideService(Effect.gen(function*(){
  api=yield*acquireEffectSessionBackendApi(f.session)
  yield*Effect.addFinalizer(()=>Effect.promise(async()=>{order.push("component-cleanup");await api.remove({sessionID:"ses_child"});order.push("component-cleaned")}))
 }),Scope.Scope,scope))
 await Effect.runPromise(Scope.close(scope,Exit.succeed(undefined)));order.push("scope-ended")
 expect(order).toEqual(["component-cleanup","host-remove","component-cleaned","scope-ended"])
 await expect(api.wait({sessionID:"ses_child"})).rejects.toThrow("closed")
})
test("setup failure closes the owner and joins a request that had no caller signal",async()=>{
 const order:string[]=[];let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve});let waiting:Promise<unknown>|undefined;let api:EffectSessionBackendApi|undefined
 const failure={setupFailed:true};const f=fake({wait:()=>Effect.gen(function*(){entered();yield*Effect.never}).pipe(Effect.onInterrupt(()=>Effect.promise(async()=>{await Bun.sleep(10);order.push("request-finalizer")})))})
 const program=Effect.scoped(Effect.gen(function*(){
  api=yield*acquireEffectSessionBackendApi(f.session)
  waiting=api.wait({sessionID:"ses_child"}).catch(error=>{order.push("request-rejected");return error})
  yield*Effect.promise(()=>ready)
  return yield*Effect.fail(failure)
 }))
 await expect(Effect.runPromise(program)).rejects.toBe(failure);order.push("setup-rejected")
 expect(await waiting).toBeInstanceOf(Error);expect(order).toEqual(["request-finalizer","request-rejected","setup-rejected"])
 await expect(defined(api).remove({sessionID:"ses_child"})).rejects.toThrow("closed")
})
test("owner pretracks before genuine host effect reenters its scope close",async()=>{
 const scope=Scope.makeUnsafe(),order:string[]=[];let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve});let closing:Promise<void>|undefined
 const f=fake({wait:()=>Effect.gen(function*(){
  yield*Effect.addFinalizer(()=>Effect.promise(async()=>{await Bun.sleep(10);order.push("request-finalizer")}))
  yield*Effect.sync(()=>{order.push("host-entry");closing=Effect.runPromise(Scope.close(scope,Exit.succeed(undefined))).then(()=>{order.push("scope-ended")});entered()})
  yield*Effect.never
 })})
 const api=await Effect.runPromise(Effect.provideService(acquireEffectSessionBackendApi(f.session),Scope.Scope,scope))
 const waiting=api.wait({sessionID:"ses_child"}).catch(error=>{order.push("request-rejected");return error})
 await ready;await closing;await waiting
 expect(order).toEqual(["host-entry","request-finalizer","request-rejected","scope-ended"])
})
test("immediate scope close owns queued calls before any host entry",async()=>{
 const scope=Scope.makeUnsafe();let entries=0;const f=fake({wait:()=>{entries++;return Effect.never}})
 const api=await Effect.runPromise(Effect.provideService(acquireEffectSessionBackendApi(f.session),Scope.Scope,scope))
 const waiting=api.wait({sessionID:"ses_child"}).catch(error=>error)
 await Effect.runPromise(Scope.close(scope,Exit.succeed(undefined)))
 expect(await waiting).toBeInstanceOf(Error);expect(entries).toBe(0)
})
test("pre-cancelled caller never enters host and does not close the still-owned API",async()=>{
 const scope=Scope.makeUnsafe();let entries=0;const f=fake({wait:()=>{entries++;return Effect.never}})
 const api=await Effect.runPromise(Effect.provideService(acquireEffectSessionBackendApi(f.session),Scope.Scope,scope))
 try {
  const controller=new AbortController(),reason={callerCancelled:true};controller.abort(reason)
  await expect(api.wait({sessionID:"ses_child"},{signal:controller.signal})).rejects.toBe(reason)
  expect(entries).toBe(0);expect(await api.get({sessionID:"ses_child"}) as unknown).toEqual(wireSession)
 } finally {await Effect.runPromise(Scope.close(scope,Exit.succeed(undefined)))}
})
test("caller cancellation joins only its request while other owner work remains pending",async()=>{
 const scope=Scope.makeUnsafe(),ended:string[]=[];let both!:()=>void;const ready=new Promise<void>(resolve=>{both=resolve});let count=0
 const f=fake({wait:(input:{sessionID:string})=>Effect.gen(function*(){if(++count===2)both();yield*Effect.never}).pipe(Effect.onInterrupt(()=>Effect.promise(async()=>{await Bun.sleep(5);ended.push(input.sessionID)})))})
 const api=await Effect.runPromise(Effect.provideService(acquireEffectSessionBackendApi(f.session),Scope.Scope,scope))
 const controller=new AbortController(),reason={onlyCaller:true};let otherSettled=false
 const one=api.wait({sessionID:"ses_one"},{signal:controller.signal}).catch(error=>error)
 const other=api.wait({sessionID:"ses_other"}).catch(error=>{otherSettled=true;return error})
 await ready;controller.abort(reason);expect(await one).toBe(reason);expect(ended).toEqual(["ses_one"]);expect(otherSettled).toBe(false)
 await Effect.runPromise(Scope.close(scope,Exit.succeed(undefined)));await other;expect(ended).toEqual(["ses_one","ses_other"])
})
