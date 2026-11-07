import { expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { BUILD_NODES } from "./build-nodes"

test("hybrid roots keep both module systems lazy until native Effect activation", async()=>{
  const root=resolve(import.meta.dir,".."),base=join(root,".omo/evidence/20261108-v2-effect-root")
  mkdirSync(base,{recursive:true});const output=mkdtempSync(join(base,"root-build-"))
  async function run(command:string,args:string[]){const child=Bun.spawn([command,...args],{cwd:root,stdout:"pipe",stderr:"pipe"});const [exitCode,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {exitCode,stdout,stderr}}
  for(const id of ["index","v2-index"]){const node=BUILD_NODES.find(value=>value.id===id)!;const args=[...node.args];args[args.indexOf("--outdir")+1]=id==="index"?output:join(output,"v2");const result=await run(process.execPath,args);expect(result.exitCode,result.stderr).toBe(0)}
  const shim=await run(process.execPath,["script/patch-node-require-shim.ts",output]);expect(shim.exitCode,shim.stderr).toBe(0)
  cpSync(join(root,"packages/shared-skills/skills"),join(output,"skills"),{recursive:true})
  const entry=pathToFileURL(join(output,"index.js")).href
  const probe=await run("node",["--input-type=module","-e",`
    import {registerHooks,createRequire} from 'node:module';
    const forbidden=id=>id==='effect'||id.startsWith('effect/')||/^@opencode\\/(?:plugin|protocol|schema|client|ai)(?:\\/|$)/.test(id);
    let rejected=0;registerHooks({resolve(id,context,next){if(forbidden(id)){rejected++;throw Error('V2 runtime intentionally absent')}return next(id,context)}});
    for(const load of [()=>import('effect'),()=>createRequire(import.meta.url)('effect')]){let failed=false;try{await load()}catch(error){failed=String(error).includes('V2 runtime intentionally absent')}if(!failed)throw Error('Absence guard missed a module system')}
    const before=rejected;const module=await import(${JSON.stringify(entry)});const plugin=module.default;
    if(rejected!==before)throw Error('Normal root eagerly tried V2 runtime');
    if(plugin.server!==module.omoPlugin||typeof plugin.server!=='function'||typeof plugin.setup!=='function'||typeof plugin.effect!=='function')throw Error('Hybrid root contract missing');
    let deferred=false;try{plugin.effect({app:{version:'2.2.6'}})}catch(error){deferred=String(error).includes('V2 runtime intentionally absent')}if(!deferred)throw Error('Effect activation did not reach deferred public runtime');
    console.log(JSON.stringify({importedWithoutV2:true,esmAndRequireGuarded:true,effectDeferred:true}));
  `])
  writeFileSync(join(output,"absence-result.json"),JSON.stringify(probe,null,2));expect(probe.exitCode,probe.stderr).toBe(0)
  const body=readFileSync(join(output,"index.js"),"utf8");expect(body.includes("var __require = import.meta.require;")).toBe(false)
},120_000)
