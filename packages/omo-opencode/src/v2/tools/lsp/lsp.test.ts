import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import type { ToolContext, Info } from "@opencode/plugin/promise/tool"
import { createLspComponent } from "./index"
import { createLspRuntime, RequestOnlyLspClient, normalizeWorkspaceEditUris } from "./runtime"
import { lspSchemas, LSP_TOOL_NAMES } from "./schemas"
import type { WorkspaceEdit, ResolvedServer } from "@oh-my-opencode/lsp-core"

const server: ResolvedServer = { id: "fixture", command: ["fixture"], extensions: [".ts"], priority: 0 }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "v2-lsp-unit-"))
  const a=join(root,"a.ts"), b=join(root,"b.ts")
  writeFileSync(a,"const original = 1\n");writeFileSync(b,"original\n")
  let starts=0, stops=0, requests=0
  const events: unknown[]=[];const permissions: { action: string; resources: readonly string[] }[]=[]
  let reject: unknown;let authorizationReject: unknown
  let edit: WorkspaceEdit = { changes: { [pathToFileURL(a).href]: [{ range:{start:{line:0,character:6},end:{line:0,character:14}},newText:"renamed"}], [pathToFileURL(b).href]: [{range:{start:{line:0,character:0},end:{line:0,character:8}},newText:"renamed"}] } }
  class Client extends RequestOnlyLspClient {
    override async start(){starts++} override async initialize(){} override isAlive(){return true} override async stop(){stops++}
    override async openFile(){} override getOpenDocumentVersion(){return undefined}
    override async requestRename(){requests++;return edit}
    override async definition(){requests++;return {uri:pathToFileURL(b).href,range:{start:{line:0,character:0},end:{line:0,character:8}}}}
    override async references(){return []}
    override async documentSymbols(){return []}
    override async prepareRename(){return {start:{line:0,character:6},end:{line:0,character:14}}}
    override async diagnostics(){return {items:[]}}
  }
  const controller=new AbortController()
  const caller={sessionID:"real-caller",agent:"readonly-or-writer",messageID:"message",id:"call",signal:controller.signal,progress:async()=>{}} as unknown as ToolContext
  const options={directory:root,homeDirectory:root,permission:{assert:async(input:any)=>{permissions.push(input);if(reject)throw reject}},authorize:async()=>{if(authorizationReject)throw authorizationReject},onMutation:async(event:unknown)=>{events.push(event)},resolveServer:()=>server,clientFactory:(r:string,s:ResolvedServer)=>new Client(r,s)}
  const runtime=createLspRuntime(options)
  return {root,a,b,runtime,caller,options,controller,events,permissions,setEdit:(e:WorkspaceEdit)=>{edit=e},deny:(e:unknown)=>{reject=e},denyCaller:(e:unknown)=>{authorizationReject=e},counts:()=>({starts,stops,requests}),cleanup:async()=>{await runtime.dispose();rmSync(root,{recursive:true,force:true})}}
}
describe("Native six-tool LSP OpenCode adapter",()=>{
 test("exact six portable schemas preserve Native indexing/defaults and reject forged fields",()=>{
  expect(LSP_TOOL_NAMES).toHaveLength(6)
  expect(lspSchemas.lsp_find_references.parse({filePath:"a.ts",line:1,character:0}).includeDeclaration).toBe(true)
  expect(lspSchemas.lsp_diagnostics.parse({filePath:"."}).severity).toBe("all")
  expect(lspSchemas.lsp_symbols.parse({filePath:"a.ts",scope:"document",limit:900}).limit).toBe(200)
  expect(()=>lspSchemas.lsp_symbols.parse({filePath:"a.ts",scope:"workspace"})).toThrow()
  for(const line of [0,-1,1.5])expect(()=>lspSchemas.lsp_goto_definition.parse({filePath:"a.ts",line,character:0})).toThrow()
  expect(()=>lspSchemas.lsp_rename.parse({filePath:"a.ts",line:1,character:0,newName:"x",sessionID:"forged"})).toThrow()
 })
 test("disabled is genuinely unregistered; enabled factory registers all six and unregisters",async()=>{
  const f=fixture();let transforms=0;let dispose=0;const tools:Info[]=[]
  const host={location:{directory:f.root},permission:f.options.permission,tool:{transform:async(fn:any)=>{transforms++;fn({add:(t:Info)=>tools.push(t)});return{dispose:async()=>{dispose++}}}}} as any
  try{
   const off=await createLspComponent({...f.options,enabled:false}).register(host);expect(transforms).toBe(0);await off()
   const close=await createLspComponent(f.options).register(host);expect(tools.map(t=>t.name)).toEqual([...LSP_TOOL_NAMES]);expect(f.counts().starts).toBe(0);await close();expect(dispose).toBe(1)
  }finally{await f.cleanup()}
 })
 test("denied input read preserves plain rejection and starts no server",async()=>{
  const f=fixture();const rejection={reason:"user rejected"};f.deny(rejection)
  try{try{await f.runtime.execute("lsp_goto_definition",{filePath:"a.ts",line:1,character:6},f.caller);throw Error("unexpected success")}catch(e){expect(e).toBe(rejection)}expect(f.counts().starts).toBe(0)}finally{await f.cleanup()}
 })
 test("all rename edit resources approved before any write; exact mutation fact and caller",async()=>{
  const f=fixture();try{
   const result=await f.runtime.execute("lsp_rename",{filePath:"a.ts",line:1,character:6,newName:"renamed"},f.caller)
   expect(readFileSync(f.a,"utf8")).toContain("renamed");expect(readFileSync(f.b,"utf8")).toContain("renamed")
   expect(f.permissions.filter(p=>p.action==="edit").flatMap(p=>p.resources).sort()).toEqual([f.a,f.b].sort())
   expect(f.events).toHaveLength(1);expect((f.events[0] as any).changedFiles.sort()).toEqual([f.a,f.b].sort());expect((f.events[0] as any).context).toBe(f.caller)
   expect(result.metadata?.isError).toBe(false)
  }finally{await f.cleanup()}
 })
 test("readonly caller cannot request rename even with allowed host permissions",async()=>{
  const f=fixture();const reason=Error("readonly");f.denyCaller(reason)
  try{await expect(f.runtime.execute("lsp_rename",{filePath:"a.ts",line:1,character:6,newName:"x"},f.caller)).rejects.toBe(reason);expect(f.counts().requests).toBe(0);expect(readFileSync(f.a,"utf8")).toContain("original")}finally{await f.cleanup()}
 })
 test("second resource denial leaves every file unchanged and emits no mutation",async()=>{
  const f=fixture();const reason=Error("deny second edit");f.options.permission.assert=async(input:any)=>{f.permissions.push(input);if(input.action==="edit"&&input.resources.includes(f.b))throw reason}
  try{await expect(f.runtime.execute("lsp_rename",{filePath:"a.ts",line:1,character:6,newName:"x"},f.caller)).rejects.toBe(reason);expect(readFileSync(f.a,"utf8")).toContain("original");expect(readFileSync(f.b,"utf8")).toBe("original\n");expect(f.events).toHaveLength(0)}finally{await f.cleanup()}
 })
 test("external edits rejected; symlink escape never writes target",async()=>{
  const f=fixture();const outside=mkdtempSync(join(tmpdir(),"v2-lsp-outside-"));const target=join(outside,"escape.ts");writeFileSync(target,"original\n")
  const bad=(p:string):WorkspaceEdit=>({changes:{[pathToFileURL(p).href]:[{range:{start:{line:0,character:0},end:{line:0,character:8}},newText:"BAD"}]}})
  try{
   f.setEdit(bad(target));await expect(f.runtime.execute("lsp_rename",{filePath:"a.ts",line:1,character:6,newName:"x"},f.caller)).rejects.toThrow("outside workspace")
   symlinkSync(outside,join(f.root,"linked"),process.platform==="win32"?"junction":"dir");f.setEdit(bad(join(f.root,"linked/escape.ts")))
   await expect(f.runtime.execute("lsp_rename",{filePath:"a.ts",line:1,character:6,newName:"x"},f.caller)).rejects.toThrow("outside workspace");expect(readFileSync(target,"utf8")).toBe("original\n")
  }finally{await f.cleanup();rmSync(outside,{recursive:true,force:true})}
 })
 test("cancellation during approval rejects immediately and cannot write on late approval",async()=>{
  const f=fixture();let approved:(()=>void)|undefined;let reached:(()=>void)|undefined;const pending=new Promise<void>(r=>{reached=r})
  f.options.permission.assert=async(input:any)=>{if(input.action==="edit"){reached!();await new Promise<void>(r=>{approved=r})}}
  try{const call=f.runtime.execute("lsp_rename",{filePath:"a.ts",line:1,character:6,newName:"x"},f.caller);await pending;const reason=Error("caller cancelled");f.controller.abort(reason);await expect(call).rejects.toBe(reason);approved!();await new Promise(r=>setTimeout(r,10));expect(readFileSync(f.a,"utf8")).toContain("original");expect(f.events).toHaveLength(0)}finally{await f.cleanup()}
 })
 test("navigation requires grants for returned external locations and disposal is final",async()=>{
  const f=fixture();try{await f.runtime.execute("lsp_goto_definition",{filePath:"a.ts",line:1,character:6},f.caller);expect(f.permissions.flatMap(p=>p.resources)).toContain(f.b);await f.runtime.dispose();expect(f.counts().stops).toBe(1);await expect(f.runtime.execute("lsp_goto_definition",{filePath:"a.ts",line:1,character:6},f.caller)).rejects.toThrow("disposed")}finally{await f.cleanup()}
 })
 test("resource rename requires source, destination and descendant grants before moving",async()=>{
  const f=fixture();const source=join(f.root,"folder"), destination=join(f.root,"moved");mkdirSync(source);writeFileSync(join(source,"child.ts"),"original\n")
  f.setEdit({documentChanges:[{kind:"rename",oldUri:pathToFileURL(source).href,newUri:pathToFileURL(destination).href}]})
  try{await f.runtime.execute("lsp_rename",{filePath:"a.ts",line:1,character:6,newName:"x"},f.caller);const resources=f.permissions.filter(p=>p.action==="edit").flatMap(p=>p.resources);expect(resources).toContain(source);expect(resources).toContain(destination);expect(resources).toContain(join(source,"child.ts"));expect(resources).toContain(join(destination,"child.ts"));expect(readFileSync(join(destination,"child.ts"),"utf8")).toBe("original\n")}finally{await f.cleanup()}
 })
 test("workspace changes while awaiting permissions abort all planned writes",async()=>{
  const f=fixture();f.options.permission.assert=async(input:any)=>{if(input.action==="edit")writeFileSync(f.b,"concurrent change\n")}
  try{await expect(f.runtime.execute("lsp_rename",{filePath:"a.ts",line:1,character:6,newName:"x"},f.caller)).rejects.toThrow("Workspace changed");expect(readFileSync(f.a,"utf8")).toContain("original");expect(f.events).toHaveLength(0)}finally{await f.cleanup()}
 })
 test("failed mutation observer reports committed files rather than pretending no edit",async()=>{
  const f=fixture();f.options.onMutation=async()=>{throw Error("observer offline")}
  try{const result=await f.runtime.execute("lsp_rename",{filePath:"a.ts",line:1,character:6,newName:"x"},f.caller);expect(result.metadata?.isError).toBe(true);expect(result.metadata?.changedFiles).toEqual([f.a,f.b]);expect(readFileSync(f.a,"utf8")).toContain("renamed")}finally{await f.cleanup()}
 })
 test("cancelling one queued caller never cancels another caller or leaks permission identity",async()=>{
  const f=fixture();const stopped=new AbortController();stopped.abort(Error("second stopped"));const other={...f.caller,sessionID:"another-real-caller",id:"other-call",signal:stopped.signal} as ToolContext
  try{const first=f.runtime.execute("lsp_goto_definition",{filePath:"a.ts",line:1,character:6},f.caller);await expect(f.runtime.execute("lsp_goto_definition",{filePath:"a.ts",line:1,character:6},other)).rejects.toThrow("second stopped");await first;expect(f.permissions.every((p:any)=>p.sessionID==="real-caller")).toBe(true);expect(f.counts().requests).toBe(1)}finally{await f.cleanup()}
 })
 test("Windows language-server URI drive casing is normalized before core ancestor walks",async()=>{
  const f=fixture();try{
   const lowerDrive=(path:string)=>process.platform==="win32"?path[0]!.toLowerCase()+path.slice(1):path
   const edit:WorkspaceEdit={changes:{[pathToFileURL(lowerDrive(f.a)).href]:[{range:{start:{line:0,character:6},end:{line:0,character:14}},newText:"safe"}]}}
   const normalized=normalizeWorkspaceEditUris(edit,f.root);expect(Object.keys(normalized.changes!)).toEqual([pathToFileURL(f.a).href]);f.setEdit(edit)
   await f.runtime.execute("lsp_rename",{filePath:"a.ts",line:1,character:6,newName:"safe"},f.caller);expect(readFileSync(f.a,"utf8")).toContain("safe")
  }finally{await f.cleanup()}
 })

 test("normalization preserves suffix casing and rejects non-file URIs without widening external paths",async()=>{
  const f=fixture();try{
   const mixed=join(f.root,"MixedCase.ts");writeFileSync(mixed,"original\n")
   const textEdit={range:{start:{line:0,character:0},end:{line:0,character:8}},newText:"x"}
   const edit=normalizeWorkspaceEditUris({changes:{[pathToFileURL(mixed).href]:[textEdit]}},f.root)
   expect(Object.keys(edit.changes!)).toEqual([pathToFileURL(mixed).href])
   expect(()=>normalizeWorkspaceEditUris({changes:{"https://example.test/a.ts":[textEdit]}},f.root)).toThrow("Unsupported edit URI")
  }finally{await f.cleanup()}
 })

 test("overwriting a directory cannot bypass denial on an existing destination descendant",async()=>{
  const f=fixture();const source=join(f.root,"source"), destination=join(f.root,"destination");mkdirSync(source);mkdirSync(destination);writeFileSync(join(source,"child.ts"),"source\n");const protectedFile=join(destination,"protected.ts");writeFileSync(protectedFile,"protected\n")
  f.setEdit({documentChanges:[{kind:"rename",oldUri:pathToFileURL(source).href,newUri:pathToFileURL(destination).href,options:{overwrite:true}}]})
  const denied=Error("destination descendant denied");f.options.permission.assert=async(input:any)=>{if(input.action==="edit"&&input.resources.includes(protectedFile))throw denied}
  try{await expect(f.runtime.execute("lsp_rename",{filePath:"a.ts",line:1,character:6,newName:"x"},f.caller)).rejects.toBe(denied);expect(readFileSync(protectedFile,"utf8")).toBe("protected\n");expect(readFileSync(join(source,"child.ts"),"utf8")).toBe("source\n");expect(f.events).toHaveLength(0)}finally{await f.cleanup()}
 })
})
