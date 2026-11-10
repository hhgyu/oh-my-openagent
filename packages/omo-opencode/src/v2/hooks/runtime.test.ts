import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import { createMutationRuntime } from "./runtime"
const roots: string[]=[]
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})})
function fixture(foreign=false,denyRead=false) {
 const directory=mkdtempSync(join(tmpdir(),"omo-mutation-runtime-"));roots.push(directory)
 const original:Info={name:"write",description:"unit write",input:z.object({path:z.string(),content:z.string()}),execute:async(input:any)=>{writeFileSync(join(directory,input.path),input.content);return {content:"WRITTEN"}}}
 const base=[{...original,id:"write"}];let tools=base.map(x=>({...x}));const transforms:Array<{callback:(editor:any)=>void}>=[];const grants:any[]=[]
 function rebuild(){tools=base.map(x=>({...x}));const editor={list:()=>tools,get:(id:string)=>tools.find(t=>t.id===id),add:(tool:any)=>tools.push({...tool,id:tool.name}),update:(id:string,update:(t:any)=>void)=>{const tool=tools.find(t=>t.id===id);if(tool)update(tool)},remove:(id:string)=>{tools=tools.filter(t=>t.id!==id)},namespace:()=>{}};for(const t of transforms)t.callback(editor)}
 const host={
  location:{directory},
  session:{get:async({sessionID}:any)=>({id:sessionID,location:{directory:foreign?dirnameForForeign(directory):directory}})},
  permission:{assert:async(value:any)=>{grants.push(value);if(denyRead&&value.action==="read")throw Error("READ_MUST_NOT_RUN")}},
  tool:{transform:async(callback:any)=>{
   const item={callback};transforms.push(item);rebuild()
   return {dispose:async()=>{const i=transforms.indexOf(item);if(i>=0)transforms.splice(i,1);rebuild()}}
  }},
 }
 const caller={sessionID:"unit-session",agent:"build",messageID:"unit-message",id:"unit-call",signal:new AbortController().signal,progress:async()=>{}} as ToolContext
 return {directory,host:host as unknown as Pick<Plugin.Context,"tool"|"permission"|"location"|"session">,caller,tools:()=>tools,grants}
}
function dirnameForForeign(path:string){return join(path,"..")}
test("complete composition exposes exactly six LSP tools and restores base registry on unload",async()=>{
 const f=fixture(),runtime=createMutationRuntime({formatOnMutation:{mode:"off",maxFileBytes:1048576,timeoutMs:3000},diagnosticsEnabled:false})
 const close=await runtime.register(f.host);expect(runtime.snapshot().active).toBe(true)
 expect(f.tools().filter(t=>t.name.startsWith("lsp_")).map(t=>t.name)).toHaveLength(6)
 const callback=f.tools().find(t=>t.name==="write")!.execute
 const output=await callback({path:"a.txt",content:"ACTUAL_BYTES"},f.caller)
 expect(readFileSync(join(f.directory,"a.txt"),"utf8")).toBe("ACTUAL_BYTES");expect(output.metadata?.omoMutation).toMatchObject({committed:true,status:"processed"})
 expect(runtime.snapshot().reports[0]).toMatchObject({sessionID:f.caller.sessionID,callID:f.caller.id,committed:true})
 await close();expect(f.tools().map(t=>t.name)).toEqual(["write"]);expect(runtime.snapshot().active).toBe(false)
 await expect(callback({path:"late.txt",content:"MUST_NOT_WRITE"},f.caller)).rejects.toBeDefined()
 await close()
})
test("another host location cannot enter an original mutation callback",async()=>{
 const f=fixture(true),runtime=createMutationRuntime({formatOnMutation:{mode:"off",maxFileBytes:1048576,timeoutMs:3000},diagnosticsEnabled:false});const close=await runtime.register(f.host)
 try{await expect(f.tools().find(t=>t.name==="write")!.execute({path:"a.txt",content:"DENIED"},f.caller)).rejects.toThrow("another host location")}
 finally{await close()}
})
test("disabled composition has no tool transform or hidden process owner",async()=>{
 const f=fixture(),runtime=createMutationRuntime({enabled:false});const close=await runtime.register(f.host);expect(f.tools().map(t=>t.name)).toEqual(["write"]);await close();expect(runtime.snapshot().active).toBe(false)
})

test("off formatter and diagnostics do not introduce a read into an allowed blind write",async()=>{
 const f=fixture(false,true),runtime=createMutationRuntime({formatOnMutation:{mode:"off",maxFileBytes:1048576,timeoutMs:3000},diagnosticsEnabled:false});const close=await runtime.register(f.host)
 try{await f.tools().find(t=>t.name==="write")!.execute({path:"blind.txt",content:"PRESERVED"},f.caller);expect(readFileSync(join(f.directory,"blind.txt"),"utf8")).toBe("PRESERVED");expect(f.grants).toHaveLength(0)}finally{await close()}
})

test("dispose joins first, second and third pending registration and retires every late handle",async()=>{
 for(const heldStage of [1,2,3]) {
  const f=fixture(),runtime=createMutationRuntime();let release!:()=>void;let entered!:()=>void;let created=0,disposed=0
  const gate=new Promise<void>(yes=>release=yes),seen=new Promise<void>(yes=>entered=yes)
  const host={...f.host,tool:{...f.host.tool,transform:async()=>{const stage=++created;if(stage===heldStage){entered();await gate}return{dispose:async()=>{disposed++}}}}} as unknown as typeof f.host
  const registration=runtime.register(host);const failed=registration.catch(error=>error);await seen
  let disposalFinished=false;const disposal=runtime.dispose().then(()=>{disposalFinished=true})
  await Promise.resolve();expect(disposalFinished).toBe(false);release()
  expect(await failed).toBeInstanceOf(Error);await disposal
  expect(created).toBe(heldStage);expect(disposed).toBe(heldStage);expect(runtime.snapshot().active).toBe(false)
  await runtime.dispose();expect(disposed).toBe(heldStage)
 }
})
