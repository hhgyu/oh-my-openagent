import { expect, test } from "bun:test"
import type { SessionLease } from "./session-state"
const sessionID = (value: string) => value as SessionLease["sessionID"]
import { createSessionScopes } from "./session-state"
import { createSessionBackend, type ChildJournal, type ChildRecord, type SessionBackendApi } from "./session-backend"
import { withJoinedSessionCancellation } from "./session-cancellation"

function deferred<T>() { let resolve!: (value:T)=>void; let reject!: (error:Error)=>void; const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no}); return {promise,resolve,reject} }
function fixture() {
 const scopes=createSessionScopes(); const parent=scopes.open(sessionID("parent"),{tools:[],authorize:()=>{}})
 let active=true; const events:string[]=[]; const records=new Map<string,ChildRecord>(); const sessions=new Map<string,{id:SessionLease["sessionID"];parentID?:SessionLease["sessionID"];location:{directory:string}}>()
 sessions.set(parent.sessionID,{id:parent.sessionID,location:{directory:"/project"}})
 const writeSync=(previous:ChildRecord,next:ChildRecord):undefined=>{const old=records.get(previous.key);if(!old||old.revision!==previous.revision||old.owner!==previous.owner)throw Error("stale fence");records.set(next.key,structuredClone(next));return undefined}
 const journal:ChildJournal={
  async claim(key,owner,initial){const old=records.get(key);if(old && old.owner!==owner)throw Error("live owner");if(old && initial)throw Error("already exists");const value=old?{...old,revision:old.revision+1}:initial;if(!value)throw Error("missing");records.set(key,value);return structuredClone(value)},
  async read(key){return records.has(key)?structuredClone(records.get(key)!):undefined},
  writeSync,
  async write(previous,next){writeSync(previous,next)},
 }
 const api:SessionBackendApi={
  async create(input){events.push("create");const value={id:sessionID(input.id!),parentID:parent.sessionID,location:{directory:"/project"}};sessions.set(value.id,value);return value},
  async get({sessionID}){const value=sessions.get(sessionID);if(!value)throw Error("not found");return value},
  async list(){return {data:[...sessions.values()],cursor:{}}},
  async prompt(input){events.push("prompt");return {id:input.id!,sessionID:sessionID(input.sessionID)}},
  async synthetic(input){events.push("synthetic");return {id:input.id!,sessionID:sessionID(input.sessionID)}},
  async interrupt(){events.push("interrupt");return {interrupted:true}},async wait(){events.push("wait")},
  async remove({sessionID}){events.push("remove");sessions.delete(sessionID)},async context(){return []},
  instructions:{entry:{async list(){return []},async put(){},async remove(){}}},
 }
 const options={backendID:"bound-host",owner:"worker-1",parent,scopes,journal,policy:{tools:[],authorize:()=>{}},gate:{assertActive(){if(!active)throw Error("paused")}}}
 // Controlled fake contract only: these methods accept the test-owned request signals.
 withJoinedSessionCancellation(api,"controlled-test")
 const backend=createSessionBackend({app:{name:"opencode",version:"2.2.6",channel:"stable"},location:{directory:"/project"},session:api},options)
 return {backend,options,api,events,records,sessions,scopes,parent,pause(){active=false},stage(){return backend.stage({key:"child-task",sessionID:sessionID("child"),agent:"build"})}}
}

test("staging creates but never prompts; admission is distinct from consumption",async()=>{const f=fixture();const child=await f.stage();expect(f.events).toEqual(["create"]);const receipt=await f.backend.begin(child,{id:"initial",text:"work"});expect(receipt).toEqual({state:"accepted",inboxID:"initial",consumption:"unconfirmed"});expect(f.records.get("child-task")?.phase).toBe("accepted");await expect(f.backend.begin(child,{id:"again",text:"replay"})).rejects.toThrow();await f.backend.close(child);expect(f.events).toEqual(["create","prompt","interrupt","wait","remove"])})
test("Stop during asynchronous create joins and removes late child without original prompt",async()=>{const f=fixture();const pending=deferred<Awaited<ReturnType<SessionBackendApi["create"]>>>();const original=f.api.create;f.api.create=async input=>{const value=await original(input);await pending.promise;return value};const stage=f.stage();await Bun.sleep(0);f.pause();pending.resolve({id:sessionID("child"),location:{directory:"/project"}});await expect(stage).rejects.toThrow();expect(f.events).toEqual(["create","interrupt","wait","remove"]);expect(f.sessions.has("child")).toBe(false)})
test("Stop during initial admission cleans late acceptance and does not claim consumed",async()=>{const f=fixture();const child=await f.stage();const pending=deferred<Awaited<ReturnType<SessionBackendApi["prompt"]>>>();f.api.prompt=async()=>{f.events.push("prompt");return pending.promise};const begin=f.backend.begin(child,{id:"initial",text:"work"});await Bun.sleep(0);f.pause();pending.resolve({id:"initial",sessionID:sessionID("child")});await expect(begin).rejects.toThrow();expect(f.sessions.has("child")).toBe(false);expect(f.records.get("child-task")?.admission).toBe("accepted")})
test("unknown admission remains durable uncertainty and cannot replay after reload",async()=>{const f=fixture();const child=await f.stage();f.api.prompt=async()=>{throw Error("transport lost")};await expect(f.backend.begin(child,{id:"initial",text:"work"})).rejects.toThrow();expect(f.records.get("child-task")?.admission).toBe("uncertain");const reload=createSessionBackend({app:{name:"opencode",version:"2.2.6",channel:"stable"},location:{directory:"/project"},session:f.api},f.options);const recovered=await reload.recover("child-task");await expect(reload.begin(recovered,{id:"initial",text:"work"})).rejects.toThrow();expect(f.events.filter(x=>x==="prompt")).toEqual([])})
test("forged locator and stale durable owner cannot mutate a host child",async()=>{const f=fixture();const child=await f.stage();await expect(f.backend.close({...child})).rejects.toThrow();f.records.set("child-task",{...f.records.get("child-task")!,owner:"replacement"});await expect(f.backend.close(child)).rejects.toThrow();expect(f.events).toEqual(["create"])})
test("foreign parent/location cannot be adopted or deleted",async()=>{const f=fixture();f.api.create=async()=>({id:sessionID("child"),parentID:sessionID("foreign"),location:{directory:"/other"}});await expect(f.stage()).rejects.toThrow();expect(f.events).not.toContain("remove")})
test("cleanup failure retains uncertain custody and original parent scope stays alive",async()=>{const f=fixture();const child=await f.stage();f.api.remove=async()=>{throw Error("offline")};await expect(f.backend.close(child)).rejects.toThrow();expect(f.records.get("child-task")?.phase).toBe("uncertain");expect(()=>f.scopes.assert(f.parent)).not.toThrow()})
test("dispose joins in-flight creation and is idempotent",async()=>{const f=fixture();const pending=deferred<void>();const original=f.api.create;f.api.create=async input=>{const result=await original(input);await pending.promise;return result};const stage=f.stage();await Bun.sleep(0);const disposed=f.backend.dispose();pending.resolve();await expect(stage).rejects.toThrow();await disposed;await f.backend.dispose();expect(f.events.filter(x=>x==="remove")).toHaveLength(1)})

test("synthetic admission IDs are durable and cannot be reused after later messages",async()=>{const f=fixture();const child=await f.stage();await f.backend.begin(child,{id:"initial",text:"work"});await f.backend.synthetic(child,{id:"s1",text:"next",resume:true});await f.backend.synthetic(child,{id:"s2",text:"next",resume:true});await expect(f.backend.synthetic(child,{id:"s1",text:"replay",resume:true})).rejects.toThrow();expect(f.events.filter(x=>x==="synthetic")).toHaveLength(2)})
test("old backend holder is fenced after recovery renews revision",async()=>{const f=fixture();const old=await f.stage();const reload=createSessionBackend({app:{name:"opencode",version:"2.2.6",channel:"stable"},location:{directory:"/project"},session:f.api},f.options);const recovered=await reload.recover("child-task");await expect(f.backend.close(old)).rejects.toThrow();await reload.close(recovered);expect(f.events.filter(x=>x==="remove")).toHaveLength(1)})
test("full transcript and inbox operations are explicitly unavailable",()=>{const f=fixture();expect(()=>f.backend.unavailable("full-history")).toThrow("explicitly bound public client")})

test("outstanding output wait permits continuation admissions and is cancelled by disposal",async()=>{const f=fixture();const child=await f.stage();await f.backend.begin(child,{id:"initial",text:"work"});f.api.wait=async(_input,options)=>{if(options?.signal)await new Promise<void>((_resolve,reject)=>{const signal=options.signal!;if(signal.aborted)reject(signal.reason);else signal.addEventListener("abort",()=>reject(signal.reason),{once:true})})};const waiting=f.backend.wait(child);await Bun.sleep(0);await f.backend.synthetic(child,{id:"during-wait",text:"next",resume:true});const disposal=f.backend.dispose();await expect(waiting).rejects.toThrow();await disposal;expect(f.sessions.has("child")).toBe(false)})
test("retired child scopes cannot mutate persistent instructions",async()=>{const f=fixture();const child=await f.stage();f.scopes.retire(child.lease);await expect(f.backend.instructions(child).put("key","value")).rejects.toThrow()})

test("verified journal recovery rebinds a retired parent generation without replay",async()=>{const f=fixture();const child=await f.stage();await f.backend.begin(child,{id:"initial",text:"work"});const parent=f.scopes.open(f.parent.sessionID,{tools:[],authorize:()=>{}});const reload=createSessionBackend({app:{name:"opencode",version:"2.2.6",channel:"stable"},location:{directory:"/project"},session:f.api},{...f.options,parent});const recovered=await reload.recover("child-task");expect(recovered.locator.generation).toBe(parent.generation);expect(child.lease.signal.aborted).toBe(true);await expect(reload.begin(recovered,{id:"initial",text:"replay"})).rejects.toThrow();await reload.close(recovered)})


function observationFixture() {
 const f=fixture()
 f.options.journal.assertCurrent=expected=>{
  if(JSON.stringify(f.records.get(expected.key))!==JSON.stringify(expected))throw Error("stale observation fence")
 }
 return f
}

test("observation requires a synchronous custody capability instead of an async-only journal",async()=>{
 const f=fixture(),child=await f.stage()
 expect(()=>f.backend.observationGuard(child)).toThrow("synchronous")
 await f.backend.dispose()
})

test("observation remains possible after Stop but never after child retirement or backend disposal",async()=>{
 const f=observationFixture(),child=await f.stage(),guard=f.backend.observationGuard(child)
 expect(()=>guard()).not.toThrow();f.pause();expect(()=>guard()).not.toThrow()
 f.scopes.retire(child.lease);expect(()=>guard()).toThrow()
 await f.backend.dispose();expect(()=>guard()).toThrow("disposed")
})

test("observation follows this backend's admission revisions but rejects same-owner recovery and forged handles",async()=>{
 const f=observationFixture(),child=await f.stage(),guard=f.backend.observationGuard(child)
 expect(()=>f.backend.observationGuard({...child})).toThrow("Unknown")
 await f.backend.begin(child,{id:"observed-initial",text:"work"});expect(()=>guard()).not.toThrow()
 const reload=createSessionBackend({app:{name:"opencode",version:"2.2.6",channel:"stable"},location:{directory:"/project"},session:f.api},f.options)
 const next=await reload.recover("child-task");expect(()=>guard()).toThrow()
 expect(()=>reload.observationGuard(next)()).not.toThrow()
 await reload.dispose()
})

test("observation rejects a retired parent and completed close",async()=>{
 const f=observationFixture(),child=await f.stage(),guard=f.backend.observationGuard(child)
 await f.backend.close(child);expect(()=>guard()).toThrow()
 const g=observationFixture(),other=await g.stage(),otherGuard=g.backend.observationGuard(other)
 g.scopes.retire(g.parent);expect(()=>otherGuard()).toThrow()
 await g.backend.dispose()
})

test("raw interruption works after admission Stop and returns ACK without retiring custody",async()=>{
 const f=fixture(),child=await f.stage();await f.backend.begin(child,{id:"initial",text:"work"});const record=structuredClone(f.records.get("child-task"))
 let request:unknown;let signal:AbortSignal|undefined
 f.api.interrupt=async(input,opts)=>{request=input;signal=opts?.signal;f.events.push("interrupt");return {interrupted:false}}
 f.pause();expect(await f.backend.interrupt(child)).toEqual({state:"answered",interrupted:false,settlement:"unconfirmed"})
 expect(request).toEqual({sessionID:"child",resume:false});expect(signal).toBeInstanceOf(AbortSignal);expect(signal!.aborted).toBe(false)
 expect(child.lease.signal.aborted).toBe(false);expect(f.records.get("child-task")).toEqual(record);expect(f.sessions.has("child")).toBe(true)
 await f.backend.dispose()
})
test("malformed or lost interruption ACK is typed uncertainty without replay or admission rewrite",async()=>{
 for(const answer of [undefined,{interrupted:"yes"},Error("transport lost")]){
  const f=fixture(),child=await f.stage();await f.backend.begin(child,{id:"initial",text:"work"})
  f.api.interrupt=async()=>{f.events.push("interrupt");if(answer instanceof Error)throw answer;return answer as never}
  await expect(f.backend.interrupt(child)).rejects.toMatchObject({code:"uncertain"})
  expect(f.events.filter(x=>x==="interrupt")).toHaveLength(1);expect(f.records.get("child-task")?.admission).toBe("accepted");expect(f.records.get("child-task")?.receipts).toEqual({initial:"accepted"})
  expect(f.records.get("child-task")?.phase).toBe("uncertain");expect(f.sessions.has("child")).toBe(true)
 }
})
test("detach revokes local control and observer authority without host calls or disposal deletion",async()=>{
 const f=observationFixture(),child=await f.stage();await f.backend.begin(child,{id:"initial",text:"work"});const guard=f.backend.observationGuard(child),before=[...f.events],record=structuredClone(f.records.get("child-task"))
 expect(await f.backend.detach(child)).toEqual({state:"detached",locator:child.locator});expect(f.events).toEqual(before);expect(child.lease.signal.aborted).toBe(true)
 expect(()=>guard()).toThrow();await expect(f.backend.close(child)).rejects.toThrow();await expect(f.backend.interrupt(child)).rejects.toThrow();await expect(f.backend.currentContext(child)).rejects.toThrow()
 await f.backend.dispose();expect(f.sessions.has("child")).toBe(true);expect(f.events).toEqual(before);expect(f.records.get("child-task")).toEqual(record)
 const reload=createSessionBackend({app:{name:"opencode",version:"2.2.6",channel:"stable"},location:{directory:"/project"},session:f.api},f.options);const recovered=await reload.recover("child-task")
 await expect(reload.begin(recovered,{id:"initial",text:"replay"})).rejects.toThrow();await reload.close(recovered)
})
test("detach refuses busy admission and preserves close retry after execution lease retirement",async()=>{
 const f=fixture(),child=await f.stage(),pending=deferred<{id:string;sessionID:string}>();f.api.prompt=async()=>pending.promise
 const begin=f.backend.begin(child,{id:"initial",text:"work"});await Bun.sleep(0)
 await expect(f.backend.detach(child)).rejects.toThrow("flight");pending.resolve({id:"initial",sessionID:"child"});await begin
 const remove=f.api.remove;f.api.remove=async()=>{throw Error("offline")};await expect(f.backend.close(child)).rejects.toThrow();expect(child.lease.signal.aborted).toBe(true)
 f.api.remove=remove;await f.backend.close(child);expect(f.sessions.has("child")).toBe(false)
})
test("interruption rejects forged/stale/foreign host identity before any host control",async()=>{
 const f=fixture(),child=await f.stage();await expect(f.backend.interrupt({...child})).rejects.toMatchObject({code:"foreign"})
 const original=f.api.get;f.api.get=async input=>input.sessionID==="child"?{id:sessionID("child"),parentID:sessionID("wrong-parent"),location:{directory:"/project"}}:original(input)
 await expect(f.backend.interrupt(child)).rejects.toMatchObject({code:"foreign"});expect(f.events).toEqual(["create"])
 f.api.get=original;f.records.set("child-task",{...f.records.get("child-task")!,owner:"other-owner"})
 await expect(f.backend.interrupt(child)).rejects.toMatchObject({code:"conflict"});await expect(f.backend.detach(child)).rejects.toMatchObject({code:"conflict"});expect(f.events).toEqual(["create"])
})
test("late owner after genuine get or host ACK cannot be overwritten or answered as owned",async()=>{
 for(const when of ["get","ack"]){
  const f=fixture(),child=await f.stage();await f.backend.begin(child,{id:"initial",text:"work"});const original=f.api.get
  if(when==="get")f.api.get=async input=>{const value=await original(input);if(input.sessionID==="child")f.records.set("child-task",{...f.records.get("child-task")!,owner:"new-owner"});return value}
  else f.api.interrupt=async()=>{f.events.push("interrupt");f.records.set("child-task",{...f.records.get("child-task")!,owner:"new-owner"});return {interrupted:true}}
  await expect(f.backend.interrupt(child)).rejects.toMatchObject({code:"conflict"})
  expect(f.records.get("child-task")!.owner).toBe("new-owner");expect(f.records.get("child-task")!.phase).toBe("accepted");expect(f.records.get("child-task")!.receipts).toEqual({initial:"accepted"})
  expect(f.events.filter(x=>x==="interrupt")).toHaveLength(when==="get"?0:1)
 }
})
test("raw true ACK remains only an answered request and retired scopes/backend refuse later control",async()=>{
 const f=fixture(),child=await f.stage();expect(await f.backend.interrupt(child)).toEqual({state:"answered",interrupted:true,settlement:"unconfirmed"})
 expect(child.lease.signal.aborted).toBe(false);f.scopes.retire(child.lease);await expect(f.backend.interrupt(child)).rejects.toThrow()
 await f.backend.dispose();await expect(f.backend.interrupt(child)).rejects.toMatchObject({code:"stopped"});expect(f.sessions.has("child")).toBe(false)
})
test("detach aborts outstanding read-only context and wait, then dispose skips preserved host session",async()=>{
 const f=fixture(),child=await f.stage();await f.backend.begin(child,{id:"initial",text:"work"})
 const untilAbort=async(signal?:AbortSignal)=>{if(signal)await new Promise<void>((_,reject)=>{if(signal.aborted)reject(signal.reason);else signal.addEventListener("abort",()=>reject(signal.reason),{once:true})})}
 f.api.wait=async(_input,opts)=>untilAbort(opts?.signal)
 f.api.context=async(_input,opts)=>{await untilAbort(opts?.signal);return []}
 const waiting=f.backend.wait(child),reading=f.backend.currentContext(child);await Bun.sleep(0)
 const outcomes=[waiting.catch(error=>error),reading.catch(error=>error)]
 await f.backend.detach(child);for(const failure of await Promise.all(outcomes))expect(failure).toBeInstanceOf(Error)
 await f.backend.dispose();expect(f.sessions.has("child")).toBe(true);expect(f.events).not.toContain("remove");expect(f.events).not.toContain("interrupt")
})
test("detach refuses an in-flight raw control instead of losing its ACK state",async()=>{
 const f=fixture(),child=await f.stage(),ack=deferred<{interrupted:boolean}>();f.api.interrupt=async()=>ack.promise
 const interrupted=f.backend.interrupt(child);await Bun.sleep(0);await expect(f.backend.detach(child)).rejects.toThrow("flight")
 ack.resolve({interrupted:true});await expect(interrupted).resolves.toEqual({state:"answered",interrupted:true,settlement:"unconfirmed"})
 await f.backend.detach(child);await f.backend.dispose();expect(f.sessions.has("child")).toBe(true)
})
test("disposal racing an ACK rejects late success and still performs permanent cleanup",async()=>{
 const f=fixture(),child=await f.stage(),ack=deferred<{interrupted:boolean}>();const original=f.api.interrupt;let first=true
 f.api.interrupt=async(input,opts)=>{if(first){first=false;return ack.promise}return original(input,opts)}
 const interrupted=f.backend.interrupt(child);await Bun.sleep(0);const disposal=f.backend.dispose();ack.resolve({interrupted:true})
 await expect(interrupted).rejects.toMatchObject({code:"stopped"});await disposal;expect(f.sessions.has("child")).toBe(false)
})
test("disposal racing detach fence cannot return a false preservation receipt",async()=>{
 const f=fixture(),child=await f.stage(),release=deferred<void>(),entered=deferred<void>();const original=f.options.journal.read;let first=true
 f.options.journal.read=async key=>{if(first){first=false;entered.resolve();await release.promise}return original(key)}
 const detach=f.backend.detach(child);await entered.promise;const disposal=f.backend.dispose();release.resolve()
 await expect(detach).rejects.toMatchObject({code:"stopped"});await disposal;expect(f.sessions.has("child")).toBe(false)
})
test("bare Promise port cannot run cancellation-dependent controls or readers",async()=>{
 const f=fixture();const bare=Object.fromEntries(Object.entries(f.api)) as unknown as SessionBackendApi
 const backend=createSessionBackend({app:{name:"opencode",version:"2.2.6",channel:"stable"},location:{directory:"/project"},session:bare},f.options)
 const child=await backend.stage({key:"bare-task",sessionID:sessionID("bare-child"),agent:"build"})
 await expect(backend.interrupt(child)).rejects.toMatchObject({code:"unavailable"});await expect(backend.detach(child)).rejects.toMatchObject({code:"unavailable"})
 await expect(backend.wait(child)).rejects.toMatchObject({code:"unavailable"});await expect(backend.currentContext(child)).rejects.toMatchObject({code:"unavailable"});await expect(backend.instructions(child).list()).rejects.toMatchObject({code:"unavailable"})
 expect(f.events).toEqual(["create"]);await backend.dispose()
})
test("detach receipt waits for asynchronous underlying reader cancellation cleanup",async()=>{
 const f=fixture(),child=await f.stage(),release=deferred<void>(),entered=deferred<void>();const order:string[]=[]
 f.api.wait=async(_input,opts)=>{entered.resolve();await new Promise<void>((_,reject)=>opts!.signal!.addEventListener("abort",()=>{void release.promise.then(()=>{order.push("finalizer");reject(opts!.signal!.reason)})},{once:true}))}
 const waiting=f.backend.wait(child).catch(error=>{order.push("reader-rejected");return error});await entered.promise
 let detached=false;const detach=f.backend.detach(child).then(value=>{detached=true;order.push("detach-returned");return value})
 await Bun.sleep(0);expect(child.lease.signal.aborted).toBe(true);expect(detached).toBe(false)
 release.resolve();await detach;await waiting;await f.backend.dispose();order.push("disposed")
 expect(order).toEqual(["finalizer","reader-rejected","detach-returned","disposed"]);expect(f.sessions.has("child")).toBe(true)
})
test("queued observer after SQLite-like commit cannot see stale in-memory checkpoint revision",async()=>{
 const f=observationFixture(),child=await f.stage(),guard=f.backend.observationGuard(child);const observed:string[]=[]
 const original=f.options.journal.write
 // Both paths commit synchronously and queue the same observer before returning.
 // The async path's await resumes later than that observer; the sync path must not await.
 const sync=(previous:ChildRecord,next:ChildRecord):undefined=>{
  const old=f.records.get(previous.key);if(!old||old.owner!==previous.owner||old.revision!==previous.revision)throw Error("stale fence")
  f.records.set(next.key,structuredClone(next))
  queueMicrotask(()=>{try{guard();observed.push("current")}catch{observed.push("stale")}})
  return undefined
 }
 f.options.journal.writeSync=sync;f.options.journal.write=async(previous,next)=>sync(previous,next)
 await f.backend.begin(child,{id:"observed",text:"work"});await Promise.resolve()
 expect(observed).toEqual(["current","current"])
 f.options.journal.write=original
})
test("an async-only checkpoint journal cannot promise synchronous observation even with assertCurrent",async()=>{
 const f=observationFixture(),child=await f.stage();delete f.options.journal.writeSync
 expect(()=>f.backend.observationGuard(child)).toThrow("synchronous")
 await f.backend.dispose()
})
test("async-only journals retain legacy admission checkpoint semantics without observer guarantees",async()=>{
 const f=fixture();delete f.options.journal.writeSync;const child=await f.stage()
 expect(await f.backend.begin(child,{id:"legacy",text:"work"})).toEqual({state:"accepted",inboxID:"legacy",consumption:"unconfirmed"})
 expect(f.records.get("child-task")?.receipts).toEqual({legacy:"accepted"});await f.backend.dispose()
})
test("dispose aborts and joins parent listing through asynchronous request cleanup",async()=>{
 const f=fixture(),entered=deferred<void>(),release=deferred<void>(),order:string[]=[];let signal:AbortSignal|undefined
 f.api.list=async(_input,opts)=>{signal=opts?.signal;entered.resolve();if(!signal)throw Error("list missing cancellation signal");await new Promise<void>((_,reject)=>signal!.addEventListener("abort",()=>{void release.promise.then(()=>{order.push("list-finalizer");reject(signal!.reason)})},{once:true}));return {data:[],cursor:{}}}
 const listing=f.backend.list().catch(error=>{order.push("list-rejected");return error});await entered.promise
 let disposed=false;const disposal=f.backend.dispose().then(()=>{disposed=true;order.push("disposed")})
 try {await Bun.sleep(0);expect(signal?.aborted).toBe(true);expect(disposed).toBe(false)}finally{release.resolve();await listing;await disposal}
 expect(order).toEqual(["list-finalizer","list-rejected","disposed"])
})
test("parent listing refuses bare cancellation port before any host request and retains gate/filter semantics",async()=>{
 const f=fixture();let gets=0,lists=0;const get=f.api.get;f.api.get=async(...args)=>{gets++;return get(...args)};f.api.list=async input=>{lists++;expect(input).toEqual({directory:"/project",parentID:"parent"});return {data:[],cursor:{}}}
 const bare=Object.fromEntries(Object.entries(f.api)) as unknown as SessionBackendApi
 const backend=createSessionBackend({app:{name:"opencode",version:"2.2.6",channel:"stable"},location:{directory:"/project"},session:bare},f.options)
 await expect(backend.list()).rejects.toMatchObject({code:"unavailable"});expect(gets).toBe(0);expect(lists).toBe(0)
 await f.backend.list();expect(gets).toBe(1);expect(lists).toBe(1);f.pause();await expect(f.backend.list()).rejects.toThrow("paused");expect(lists).toBe(1)
 await backend.dispose();await f.backend.dispose()
})
test("mislabeled async writeSync never admits model work or advances local authoritative checkpoint",async()=>{
 const f=observationFixture(),child=await f.stage(),guard=f.backend.observationGuard(child),release=deferred<void>();let commits=0
 f.options.journal.writeSync=(async(previous:ChildRecord,next:ChildRecord)=>{await release.promise;f.records.set(next.key,structuredClone(next));commits++}) as never
 await expect(f.backend.begin(child,{id:"forbidden",text:"must not admit"})).rejects.toMatchObject({code:"unavailable"})
 expect(f.events).toEqual(["create"]);expect(commits).toBe(0);expect(()=>guard()).not.toThrow()
 release.resolve();await Promise.resolve();await Promise.resolve();expect(commits).toBe(1)
 // A malformed dependency can still commit late; it must never become authority/model admission.
 expect(f.events).toEqual(["create"]);expect(()=>guard()).toThrow()
})
test("async or nonundefined assertCurrent cannot grant observation authority",async()=>{
 for(const make of [()=>Promise.resolve(undefined),()=>Promise.reject(Error("invalid async assertion")),()=>true,()=>0,()=>null]){
  const f=observationFixture(),child=await f.stage();let grants=0
  f.options.journal.assertCurrent=(()=>make()) as never
  try{const guard=f.backend.observationGuard(child);guard();grants++}catch(error){expect(error).toMatchObject({code:"unavailable"})}
  expect(grants).toBe(0)
 }
 await Promise.resolve()
})
test("nonundefined synchronous checkpoint result refuses before prompt and consumes bad thenable rejection",async()=>{
 for(const result of [true,0,null,{then(_resolve:unknown,reject:(reason:Error)=>void){reject(Error("invalid thenable"))}}]){
  const f=fixture(),child=await f.stage();f.options.journal.writeSync=(()=>result) as never
  await expect(f.backend.begin(child,{id:"forbidden",text:"must not admit"})).rejects.toMatchObject({code:"unavailable"})
  expect(f.events).toEqual(["create"]);expect(f.records.get("child-task")?.phase).toBe("staged")
 }
 await Promise.resolve()
})
