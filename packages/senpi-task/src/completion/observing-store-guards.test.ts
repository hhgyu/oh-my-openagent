import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTaskRecord } from "../state/record"
import { createTaskRecordStore } from "../store/record-store"
import { createCompletionNotifier } from "./notifier"
import { createCompletionObservingStore } from "./observing-store"
import { createConfigGenerationStampingStore } from "./config-generation-store"
import { createMutationNotifyingStore } from "./mutation-store"
import { createTaskTerminalObservers } from "./terminal-observers"

test("owned ready=false does not read unknown state, while liveness and outer ledger survive", () => {
  const dir = mkdtempSync(join(tmpdir(), "omo-C2G-")), backing = createTaskRecordStore({ project_dir: dir })
  try {
    const row = { ...createTaskRecord({ parent_session_id: "parent", root_session_id: "parent", depth: 0, execution_mode: "in-process", model: "unit", notify_on_terminal: true, task_seq: 0 }), status: "running" as const }
    backing.save(row)
    let state = 0, live = 0, mutations = 0, edges = 0, enqueues = 0
    const notifier = createCompletionNotifier({ store: backing, notifier: { enqueue() { enqueues++ } } })
    const deps = { notifier, parentState() { state++; throw Error("controlled unknown parent state") }, wasBackground: () => true,
      currentSessionId: () => "parent", onTerminal() { live++ }, ownsTerminal: () => true, notificationReady: () => false }
    const observed = createCompletionObservingStore(backing, deps), stamped = createConfigGenerationStampingStore(observed, () => undefined)
    const ledger = createTaskTerminalObservers(); ledger.subscribe(() => edges++)
    const store = createMutationNotifyingStore(stamped, () => mutations++, ledger)
    let failure: unknown
    try { store.mutate(row.task_id, current => ({ ...current, status: "completed", final_response: "unit" })) } catch (error) { failure = error }
    expect(state).toBe(0); expect(failure).toBeUndefined()
    expect([live, mutations, edges, enqueues]).toEqual([1, 1, 1, 0])
    expect(present(backing.load(row.task_id)).notification.notified_epoch).toBe(-1)
  } finally { backing.close(); rmSync(dir, { recursive: true, force: true }) }
})

import type { CompletionBridgeDeps } from "./observing-store"
import type { CompletionRequest, ParentState } from "./types"
import type { TaskRecord } from "../state/types"

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected value to be present")
  return value
}
function withChain(run: (h: ReturnType<typeof chain>) => void): void {
  const h=chain();try{run(h)}finally{h.backing.close();rmSync(h.dir,{recursive:true,force:true})}
}
function chain() {
  const dir=mkdtempSync(join(tmpdir(),"omo-C2G-chain-")),backing=createTaskRecordStore({project_dir:dir})
  const order:string[]=[],notifies:CompletionRequest[]=[],live:TaskRecord[]=[],edges:string[]=[],mutations:string[]=[]
  let seq=0,store!:ReturnType<typeof createMutationNotifyingStore>,deps!:CompletionBridgeDeps
  const state:ParentState={kind:"streaming"}
  const real=createCompletionNotifier({store:backing,notifier:{enqueue(){throw Error("foreground no transport")}}})
  let notifierThis:unknown
  const notifier=new Proxy(real,{get(target,key,receiver){const original=Reflect.get(target,key,receiver);return key==="notifyTerminal"?new Proxy(original,{apply(fn,thisArg,args){order.push("notify");notifies.push(args[0]);notifierThis=thisArg;return Reflect.apply(fn,thisArg,args)}}):original}})
  function make(extra:Partial<CompletionBridgeDeps>={}) {
    deps={notifier,parentState(){order.push("state");return state},wasBackground(){order.push("mode");return false},currentSessionId:()=>"parent",onTerminal(row){order.push("live");live.push(row)},...extra}
    const observing=createCompletionObservingStore(backing,deps),stamping=createConfigGenerationStampingStore(observing,()=>undefined),ledger=createTaskTerminalObservers()
    ledger.subscribe(edge=>{order.push("edge");edges.push(edge.record.task_id)})
    store=createMutationNotifyingStore(stamping,change=>{order.push("mutation");mutations.push(change.taskId)},ledger)
    return store
  }
  function record(save=true):TaskRecord {const row={...createTaskRecord({parent_session_id:"parent",root_session_id:"parent",depth:0,execution_mode:"in-process",model:"unit",notify_on_terminal:false,task_seq:++seq}),status:"running" as const};if(save)backing.save(row);return row}
  make()
  return{dir,backing,make,record,order,notifies,live,edges,mutations,state,get store(){return store},get deps(){return deps},notifier,get notifierThis(){return notifierThis}}
}
const at="2026-11-09T00:00:00.000Z"
test("ABSENT preserves original callback order, argument identities and notifier receiver",()=>withChain(h=>{
  const row=h.record(),returned=present(h.store.mutate(row.task_id,current=>({...current,status:"completed",final_response:"unit"})))
  expect(h.order).toEqual(["state","mode","notify","live","mutation","edge"])
  expect(present(h.notifies[0]).record).toBe(returned);expect(h.live[0]).toBe(returned);expect(present(h.notifies[0]).parentState).toBe(h.state)
  expect(h.notifierThis).toBe(h.notifier)
}))
for(const path of ["transition","mutate"] as const) test(`ownsfalse ${path} skips both channel effects but outer ledger still runs`,()=>withChain(h=>{
  let ready=0,seen:TaskRecord|undefined,receiver:unknown
  h.make({ownsTerminal:function(row){receiver=this;seen=row;return false},notificationReady(){ready++;throw Error("must not evaluate readiness")}})
  const row=h.record();const result=path==="mutate"?present(h.store.mutate(row.task_id,current=>({...current,status:"completed"}))):h.store.transition(row.task_id,{type:"complete",timestamp:at,final_response:"unit"}).record
  expect(seen).toBe(result);expect(receiver).toBe(h.deps);expect(ready).toBe(0)
  expect(h.order).toEqual(["mutation","edge"]);expect(present(h.backing.load(row.task_id)).notification.notified_epoch).toBe(-1)
}))
for(const path of ["transition","mutate"] as const) test(`owned readyfalse ${path} preserves exact liveness/ledger and never samples state/mode`,()=>withChain(h=>{
  h.make({ownsTerminal:()=>true,notificationReady:()=>false,parentState(){throw Error("unknown state must not be sampled")},wasBackground(){throw Error("mode must not be sampled")}})
  const row=h.record();if(path==="mutate")h.store.mutate(row.task_id,current=>({...current,status:"error"}));else h.store.transition(row.task_id,{type:"fail",timestamp:at,error_message:"unit"})
  expect(h.order).toEqual(["live","mutation","edge"]);expect(h.notifies).toHaveLength(0)
}))
test("both true preserves notify then liveness with actual returned record",()=>withChain(h=>{
  h.make({ownsTerminal:()=>true,notificationReady:()=>true});const row=h.record()
  const result=h.store.transition(row.task_id,{type:"complete",timestamp:at,final_response:"unit"})
  expect(h.order).toEqual(["state","mode","notify","live","mutation","edge"]);expect(h.live[0]).toBe(result.record)
}))
test("guard receives actual post-write parent rather than stale input snapshot",()=>withChain(h=>{
  let seen:TaskRecord|undefined
  h.make({currentSessionId:()=>"other",ownsTerminal:row=>{seen=row;return row.parent_session_id==="parent"},notificationReady:()=>true})
  const original=h.record();const result=present(h.store.mutate(original.task_id,row=>({...row,parent_session_id:"other",status:"lost"})))
  expect(original.parent_session_id).toBe("parent");expect(seen).toBe(result);expect(present(seen).parent_session_id).toBe("other")
  expect(h.order).toEqual(["mutation","edge"])
}))
for(const thrown of [undefined,0,null,Error("guard fault")]) test(`predicate exact throw ${String(thrown)} propagates AFTER committed write; outer exception boundary retained`,()=>withChain(h=>{
  h.make({ownsTerminal(){throw thrown}});const row=h.record();let caught=false,value:unknown
  try{h.store.mutate(row.task_id,current=>({...current,status:"completed"}))}catch(error){caught=true;value=error}
  expect(caught).toBe(true);expect(value).toBe(thrown);expect(present(h.backing.load(row.task_id)).status).toBe("completed")
  expect(h.order).toEqual([]);expect(h.live).toHaveLength(0);expect(h.mutations).toHaveLength(0)
}))
for(const invalid of [undefined,null,1,"true",{},Promise.resolve(true)]) test(`nonboolean predicate ${String(invalid)} is not truthiness and retains original invalid result`,()=>withChain(h=>{
  // This resolved promise is owned by the unit caller; no async SDK/IO producer is started.
  h.make({notificationReady:()=>invalid as unknown as boolean});const row=h.record();let value:unknown
  try{h.store.mutate(row.task_id,current=>({...current,status:"completed"}))}catch(error){value=error}
  expect(value).toBeInstanceOf(TypeError);expect((value as Error).cause).toBe(invalid)
  expect(present(h.backing.load(row.task_id)).status).toBe("completed");expect(h.order).toEqual([])
}))
test("readiness revocation of ownership prevents state/notification and later old-owner liveness",()=>withChain(h=>{
  let owned=true
  h.make({ownsTerminal:()=>owned,notificationReady(){owned=false;return true}})
  const row=h.record();h.store.mutate(row.task_id,current=>({...current,status:"completed"}))
  expect(h.order).toEqual(["mutation","edge"])
}))
test("notifier revocation cannot run a later old-owner liveness effect",()=>withChain(h=>{
  let owned=true
  const notifier=createCompletionNotifier({store:h.backing,notifier:{enqueue(){throw Error("foreground")}}})
  const guarded={...notifier,notifyTerminal(request:CompletionRequest){h.order.push("notify");owned=false;return notifier.notifyTerminal(request)}}
  h.make({notifier:guarded,ownsTerminal:()=>owned,notificationReady:()=>true});const row=h.record()
  h.store.mutate(row.task_id,current=>({...current,status:"completed"}))
  expect(h.order).toEqual(["state","mode","notify","mutation","edge"]);expect(h.live).toHaveLength(0)
}))
test("nested different terminal rows keep independent record/routing locals",()=>withChain(h=>{
  const a=h.record(),b=h.record();let nested=false
  h.make({ownsTerminal:()=>true,notificationReady:row=>{if(row.task_id===a.task_id&&!nested){nested=true;h.store.mutate(b.task_id,current=>({...current,status:"completed"}))}return true}})
  h.store.mutate(a.task_id,current=>({...current,status:"completed"}))
  expect(h.notifies.map(item=>item.record.task_id)).toEqual([b.task_id,a.task_id]);expect(h.live.map(row=>row.task_id)).toEqual([b.task_id,a.task_id])
  expect(h.mutations).toEqual([b.task_id,a.task_id]);expect(h.edges).toEqual([b.task_id,a.task_id])
}))
test("same-epoch bookkeeping and unapplied transitions do not invoke guards; next terminal epoch does",()=>withChain(h=>{
  let owns=0;h.make({ownsTerminal:()=>{owns++;return true},notificationReady:()=>false});const row=h.record()
  h.store.mutate(row.task_id,current=>({...current,status:"completed"}));const first=owns;expect(first).toBeGreaterThan(0)
  h.store.mutate(row.task_id,current=>({...current,name:"bookkeeping"}));expect(owns).toBe(first)
  const result=h.store.transition(row.task_id,{type:"complete",timestamp:at,final_response:"ignored"});expect(result.applied).toBe(false);expect(owns).toBe(first)
  h.store.mutate(row.task_id,current=>({...current,notification:{...current.notification,run_epoch:current.notification.run_epoch+1}}));expect(owns).toBeGreaterThan(first)
  expect(h.edges).toHaveLength(1)
}))
test("save/replace and nonterminal writes keep canonical delegation and ledger without guard classification",()=>withChain(h=>{
  h.make({ownsTerminal(){throw Error("must not classify this write")}});const row=h.record(false)
  h.store.save(row);h.store.replace({...row,status:"lost"});h.store.load(row.task_id);h.store.list()
  expect(h.order).toEqual(["mutation","mutation","edge"]);expect(h.notifies).toHaveLength(0)
}))
test("onTerminal metadata recursion does not create another terminal notification",()=>withChain(h=>{
  h.make({ownsTerminal:()=>true,notificationReady:()=>false,onTerminal(row){h.live.push(row);h.store.mutate(row.task_id,current=>({...current,name:"liveness-marker"}))}})
  const row=h.record();h.store.mutate(row.task_id,current=>({...current,status:"completed"}))
  expect(h.live).toHaveLength(1);expect(h.edges).toHaveLength(1);expect(h.mutations).toHaveLength(2)
}))

test("state/mode revocation is rechecked before later notification and liveness",()=>withChain(h=>{
  let owned=true
  h.make({ownsTerminal:()=>owned,notificationReady:()=>true,wasBackground(){h.order.push("mode");owned=false;return false}})
  const row=h.record();h.store.mutate(row.task_id,current=>({...current,status:"completed"}))
  expect(h.order).toEqual(["state","mode","mutation","edge"])
}))
test("readiness becoming unknown before notify holds channel publication but preserves owned liveness",()=>withChain(h=>{
  let ready=true
  h.make({ownsTerminal:()=>true,notificationReady:()=>ready,parentState(){h.order.push("state");ready=false;return h.state}})
  const row=h.record();h.store.mutate(row.task_id,current=>({...current,status:"completed"}))
  expect(h.order).toEqual(["state","mode","live","mutation","edge"])
}))
test("invalid thenable is retained without calling then or pretending it was joined",()=>withChain(h=>{
  let invoked=0;const thenable={then(){invoked++}}
  h.make({ownsTerminal:()=>thenable as unknown as boolean});const row=h.record();let error:unknown
  try{h.store.mutate(row.task_id,current=>({...current,status:"completed"}))}catch(value){error=value}
  expect(error).toBeInstanceOf(TypeError);expect((error as Error).cause).toBe(thenable);expect(invoked).toBe(0)
}))
test("original mutation callback executes once with guards and nested notifications",()=>withChain(h=>{
  h.make({ownsTerminal:()=>true,notificationReady:()=>true});const row=h.record();let calls=0
  h.store.mutate(row.task_id,current=>{calls++;return {...current,status:"completed"}})
  expect(calls).toBe(1);expect(h.notifies).toHaveLength(1);expect(h.edges).toHaveLength(1)
}))
test("fresh process executes canonical hold/default paths with SDK/UI/adapter poison",()=>{
  const observing=new URL("./observing-store.ts",import.meta.url).href,record=new URL("../state/record.ts",import.meta.url).href,base=new URL("../store/record-store.ts",import.meta.url).href
  const mutation=new URL("./mutation-store.ts",import.meta.url).href,terminal=new URL("./terminal-observers.ts",import.meta.url).href,notify=new URL("./notifier.ts",import.meta.url).href
  const script=`let forbidden=0;Bun.plugin({name:"C2G-cold",setup(b){b.onResolve({filter:/^(@code-yeongyu\\/senpi|@earendil-works\\/pi-tui|@oh-my-opencode\\/omo-senpi)(\\/|$)/},a=>{forbidden++;throw Error("FORBIDDEN:"+a.path)});b.onLoad({filter:/[\\\\/]packages[\\\\/]omo-senpi[\\\\/]/},()=>{forbidden++;throw Error("NATIVE_ADAPTER")})}});
const{mkdtempSync,rmSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path"),{createTaskRecord}=await import(${JSON.stringify(record)}),{createTaskRecordStore}=await import(${JSON.stringify(base)}),{createCompletionObservingStore}=await import(${JSON.stringify(observing)}),{createMutationNotifyingStore}=await import(${JSON.stringify(mutation)}),{createTaskTerminalObservers}=await import(${JSON.stringify(terminal)}),{createCompletionNotifier}=await import(${JSON.stringify(notify)});
const dir=mkdtempSync(join(tmpdir(),"C2G-cold-")),backing=createTaskRecordStore({project_dir:dir});let live=0,edges=0,states=0;try{const notifier=createCompletionNotifier({store:backing,notifier:{enqueue(){throw Error("foreground")}}}),ledger=createTaskTerminalObservers();ledger.subscribe(()=>edges++);const held=createMutationNotifyingStore(createCompletionObservingStore(backing,{notifier,parentState(){states++;throw Error("unknown")},wasBackground:()=>true,currentSessionId:()=>"parent",ownsTerminal:()=>true,notificationReady:()=>false,onTerminal(){live++}}),()=>{},ledger);const row={...createTaskRecord({parent_session_id:"parent",root_session_id:"parent",depth:0,execution_mode:"in-process",model:"unit",notify_on_terminal:true,task_seq:0}),status:"running"};backing.save(row);held.mutate(row.task_id,x=>({...x,status:"completed"}));const normal=createCompletionObservingStore(backing,{notifier,parentState:()=>({kind:"idle"}),wasBackground:()=>false,currentSessionId:()=>"parent",onTerminal(){live++}});normal.mutate(row.task_id,x=>({...x,notification:{...x.notification,run_epoch:1}}));if(forbidden||states||live!==2||edges!==1)throw Error("Cold pathfailed");console.log(JSON.stringify({forbidden,states,live,edges}))}finally{backing.close();rmSync(dir,{recursive:true,force:true})}`
  const child=Bun.spawnSync([process.execPath,"--eval",script],{stdout:"pipe",stderr:"pipe",timeout:5000})
  expect(new TextDecoder().decode(child.stderr)).toBe("");expect(child.exitCode).toBe(0)
  expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({forbidden:0,states:0,live:2,edges:1})
})

for(const thrown of [undefined,0,null,Error("ready fault")]) test(`ready predicate exact throw ${String(thrown)} remains a postcommit fault, never unknown-state hold`,()=>withChain(h=>{
  h.make({ownsTerminal:()=>true,notificationReady(){throw thrown}});const row=h.record();let caught=false,error:unknown
  try{h.store.mutate(row.task_id,current=>({...current,status:"completed"}))}catch(value){caught=true;error=value}
  expect(caught).toBe(true);expect(error).toBe(thrown);expect(present(h.backing.load(row.task_id)).status).toBe("completed");expect(h.order).toEqual([])
}))
test("owned held notification preserves original onTerminal throw and outer-ledger exception boundary",()=>withChain(h=>{
  h.make({ownsTerminal:()=>true,notificationReady:()=>false,parentState(){throw Error("must not sample")},onTerminal(){throw 0}})
  const row=h.record();let caught=false,value:unknown
  try{h.store.mutate(row.task_id,current=>({...current,status:"completed"}))}catch(error){caught=true;value=error}
  expect(caught).toBe(true);expect(value).toBe(0);expect(h.order).toEqual([]);expect(present(h.backing.load(row.task_id)).status).toBe("completed")
}))
