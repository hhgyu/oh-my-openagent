import { expect, test } from "bun:test"
import { createTaskRecord } from "@oh-my-opencode/senpi-task"
import type { TaskRecord } from "@oh-my-opencode/senpi-task/manager-kernel"
import { createSessionScopes, type SessionLease } from "../../host/session-state"
import { createOwnedAncestry, ownedAncestorPath } from "./ancestry"
const sid = (id:string) => id as SessionLease["sessionID"]
function record(id:string,parent:string,depth:number):TaskRecord {
 const base=createTaskRecord({parent_session_id:parent,root_session_id:"root",depth,execution_mode:"in-process",model:"qa/model",notify_on_terminal:false})
 const claim="claim:"+id
 return {...base,status:"running",child_session_id:id,residency_claim:claim,owned_session:{format:1,backendID:"omo-native-task-opencode",location:"/project",hostVersion:"2.2.6",parentID:parent,sessionID:id,generation:1,journalKey:id,journalOwner:"owner",journalRevision:1,runEpoch:base.notification.run_epoch,residencyClaim:claim}}
}
test("owned ancestry preserves arbitrary finite allowed depth and verifies every actual host link",async()=>{
 const scopes=createSessionScopes(),root=scopes.open(sid("root"),{tools:[],authorize(){}})
 const rows=Array.from({length:160},(_,i)=>record("child:"+i,i===0?"root":"child:"+(i-1),i+1)),lookups:string[]=[]
 const tree=createOwnedAncestry({root,directory:"/project",hostVersion:"2.2.6",records:()=>rows,assertRoot:()=>scopes.assert(root),assertControl(){},async get(id){lookups.push(id);const row=rows.find(x=>x.child_session_id===id);return{id,parentID:row?.parent_session_id,location:{directory:"/project"}}}})
 const result=await tree.verify("child:159")
 expect(result.depth).toBe(160);expect(result.rootSessionId).toBe(sid("root"));expect(lookups).toHaveLength(161);scopes.dispose()
})
test("unknown/ambiguous/cyclic/mismatched owned ancestry is never a new root",()=>{
 const a=record("a","root",1),b=record("b","a",2)
 expect(ownedAncestorPath("root",[a,b],"b").map(x=>x.child_session_id)).toEqual(["b","a"])
 expect(()=>ownedAncestorPath("root",[a,b],"unknown")).toThrow("missing")
 expect(()=>ownedAncestorPath("root",[a,a],"a")).toThrow("ambiguous")
 expect(()=>ownedAncestorPath("root",[{...a,parent_session_id:"b",owned_session:{...defined(a.owned_session),parentID:"b"}},b],"a")).toThrow("cycle")
 expect(()=>ownedAncestorPath("root",[a,{...b,depth:3}],"b")).toThrow("depth")
 expect(()=>ownedAncestorPath("root",[{...a,root_session_id:"foreign"}],"a")).toThrow("identity")
})
test("host parent/location mismatch and custody movement during await refuse verification",async()=>{
 const scopes=createSessionScopes(),root=scopes.open(sid("root"),{tools:[],authorize(){}})
 let rows=[record("a","root",1)],wrong=true,move=false
 const tree=createOwnedAncestry({root,directory:"/project",hostVersion:"2.2.6",records:()=>rows,assertRoot:()=>scopes.assert(root),assertControl(){},async get(id){if(move)rows=[{...rows[0],residency_claim:"new"}];return{id,parentID:id==="root"?undefined:wrong?"foreign":"root",location:{directory:"/project"}}}})
 await expect(tree.verify("a")).rejects.toThrow("host ancestry")
 wrong=false;move=true;await expect(tree.verify("a")).rejects.toThrow("changed")
 scopes.dispose()
})

test.each(["root", "depth", "status", "killed", "residency", "host-owner", "parent", "child"] as const)("awaited ancestry rejects an aliased %s relationship/eligibility mutation",async variant=>{
 const scopes=createSessionScopes(),root=scopes.open(sid("root"),{tools:[],authorize(){}}),row=record("a","root",1)
 let moved=false
 const tree=createOwnedAncestry({root,directory:"/project",hostVersion:"2.2.6",records:()=>[row],assertRoot:()=>scopes.assert(root),assertControl(){},async get(id){
  await Promise.resolve()
  if(!moved){moved=true
   if(variant==="root")Object.assign(row,{root_session_id:"other-root"})
   else if(variant==="depth")Object.assign(row,{depth:77})
   else if(variant==="status")Object.assign(row,{status:"cancelled"})
   else if(variant==="killed")Object.assign(row,{killed:true})
   else if(variant==="residency")Object.assign(row,{residency_state:"persisted_only"})
   else if(variant==="host-owner")Object.assign(row,{host_pid:123456})
   else if(variant==="parent")Object.assign(row,{parent_session_id:"other-parent",owned_session:{...defined(row.owned_session),parentID:"other-parent"}})
   else Object.assign(row,{child_session_id:"other-child",owned_session:{...defined(row.owned_session),sessionID:"other-child"}})
  }
  return{id,parentID:id==="root"?undefined:"root",location:{directory:"/project"}}
 }})
 try{await expect(tree.verify("a")).rejects.toThrow()}finally{scopes.dispose()}
})

test.each(["running", "completed", "error"] as const)("ancestry tolerates progress and existing eligible %s status while preserving captured depth",async status=>{
 const scopes=createSessionScopes(),root=scopes.open(sid("root"),{tools:[],authorize(){}}),row=record("a","root",1)
 const tree=createOwnedAncestry({root,directory:"/project",hostVersion:"2.2.6",records:()=>[row],assertRoot:()=>scopes.assert(root),assertControl(){},async get(id){
  Object.assign(row,{updated_at:"2026-11-08T00:00:00.000Z",final_response:"partial progress",status})
  return{id,parentID:id==="root"?undefined:"root",location:{directory:"/project"}}
 }})
 try{expect((await tree.verify("a")).depth).toBe(1)}finally{scopes.dispose()}
})

test("retained ancestry fence snapshots primitives and refuses a later change without mutating captured output",async()=>{
 const scopes=createSessionScopes(),root=scopes.open(sid("root"),{tools:[],authorize(){}}),row=record("a","root",1)
 const tree=createOwnedAncestry({root,directory:"/project",hostVersion:"2.2.6",records:()=>[row],assertRoot:()=>scopes.assert(root),assertControl(){},async get(id){return{id,parentID:id==="root"?undefined:"root",location:{directory:"/project"}}}})
 try{
  const verified=await tree.verify("a")
  Object.assign(row,{updated_at:"2026-11-08T00:00:00.000Z",status:"completed"});expect(()=>verified.assertCurrent()).not.toThrow()
  Object.assign(row,{depth:77})
  expect(verified.rows[0].depth).toBe(1);expect(verified.depth).toBe(1)
  expect(()=>verified.assertCurrent()).toThrow("changed")
  Object.assign(row,{depth:1,killed:true});expect(()=>verified.assertCurrent()).toThrow("changed")
 }finally{scopes.dispose()}
})

test("only corroborated monotonic owned revisions may advance a retained admission fence",async()=>{
 const scopes=createSessionScopes(),root=scopes.open(sid("root"),{tools:[],authorize(){}}),row=record("a","root",1)
 let actualControlRevision=1
 const tree=createOwnedAncestry({root,directory:"/project",hostVersion:"2.2.6",records:()=>[row],assertRoot:()=>scopes.assert(root),assertControl(current){if(current.owned_session?.journalRevision!==actualControlRevision)throw Error("private control/journal revision differs")},async get(id){return{id,parentID:id==="root"?undefined:"root",location:{directory:"/project"}}}})
 try{
  const verified=await tree.verify("a")
  actualControlRevision=3;Object.assign(row,{owned_session:{...defined(row.owned_session),journalRevision:3}})
  expect(()=>verified.assertCurrent()).not.toThrow()
  Object.assign(row,{owned_session:{...defined(row.owned_session),journalRevision:5}})
  expect(()=>verified.assertCurrent()).toThrow("private control")
  actualControlRevision=2;Object.assign(row,{owned_session:{...defined(row.owned_session),journalRevision:2}})
  expect(()=>verified.assertCurrent()).toThrow("changed")
 }finally{scopes.dispose()}
})
function defined<T>(value: T | null | undefined): T { if (value === undefined || value === null) throw new Error("expected a defined value"); return value }
