import { expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { BUILD_NODES } from "./build-nodes"

test("published roots preserve host SDK identity and load V1 without the optional V2 runtime", async () => {
  const root = resolve(import.meta.dir, "..")
  async function run(command: string, args: string[]) {
    const child = Bun.spawn([command, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { status, stdout, stderr }
  }
  const evidence = join(root, ".omo/evidence/20261107-v2-native-foundation")
  mkdirSync(evidence, { recursive: true })
  const output = mkdtempSync(join(evidence, "runtime-"))
  for (const id of ["index", "v2-index"]) {
    const node = BUILD_NODES.find((entry) => entry.id === id)!
    const args = [...node.args]
    args[args.indexOf("--outdir") + 1] = id === "index" ? output : join(output, "v2")
    const build = await run(process.execPath, args)
    expect(build.status, build.stdout + build.stderr).toBe(0)
  }
  const shim = await run(process.execPath, ["script/patch-node-require-shim.ts", output])
  expect(shim.status, shim.stdout + shim.stderr).toBe(0)
  const patchedFiles = [output, join(output, "v2")].flatMap((directory) => readdirSync(directory).filter((name) => name.endsWith(".js")).map((name) => join(directory, name)))
  const patchedBodies = patchedFiles.map((path) => readFileSync(path, "utf8"))
  for (const body of patchedBodies) expect(body.includes("var __require = import.meta.require;")).toBe(false)
  const repeat = await run(process.execPath, ["script/patch-node-require-shim.ts", output])
  expect(repeat.status, repeat.stderr).toBe(0)
  expect(patchedFiles.map((path) => readFileSync(path, "utf8"))).toEqual(patchedBodies)
  const explicit = readFileSync(join(output, "v2/index.js"), "utf8")
  expect(/from ["']@opencode\/plugin/.test(explicit)).toBe(true)
  expect(explicit.includes("node_modules/effect/")).toBe(false)
  cpSync(join(root, "packages/shared-skills/skills"), join(output, "skills"), { recursive: true })
  for (const directory of [output, join(output, "v2")]) {
    for (const file of readdirSync(directory).filter((name) => name.endsWith(".js"))) {
      const body = readFileSync(join(directory, file), "utf8")
      expect(/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?effect\//.test(body)).toBe(false)
    }
  }
  const loader = join(output, "deny-v2.mjs")
  writeFileSync(loader, `export function resolve(specifier, context, next) {
    if (specifier === "effect" || specifier.startsWith("effect/") || specifier.startsWith("@opencode/plugin")) throw new Error("V2 SDK intentionally unavailable");
    return next(specifier, context);
  }`)
  const entry = pathToFileURL(join(output, "index.js")).href
  const check = await run("node", ["--experimental-loader", pathToFileURL(loader).href, "--input-type=module", "-e", `
    const {default: plugin, omoPlugin} = await import(${JSON.stringify(entry)});
    if (plugin.server !== omoPlugin || typeof omoPlugin !== "function" || typeof plugin.setup !== "function") throw new Error("Root export contract changed");
    console.log("V1 root imports without V2 SDK");
  `])
  expect(check.status, check.stdout + check.stderr).toBe(0)
  const trace = join(output, "trace-sdk.mjs")
  writeFileSync(trace, `export async function resolve(specifier, context, next) {
    const resolved = await next(specifier, context);
    if (specifier !== "@opencode/plugin/promise/plugin") return resolved;
    const source = 'export * from ' + JSON.stringify(resolved.url) + '; import {define as hostDefine} from ' + JSON.stringify(resolved.url) + '; export function define(plugin) { globalThis.__hostDefines = (globalThis.__hostDefines ?? 0) + 1; return hostDefine(plugin); }';
    return {url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit:true};
  }`)
  const v2 = await run("node", ["--experimental-loader", pathToFileURL(trace).href, "--input-type=module", "-e", `
    const {default: plugin} = await import(${JSON.stringify(pathToFileURL(join(output, "v2/index.js")).href)});
    if (globalThis.__hostDefines !== 1) throw new Error("V2 did not use host SDK define");
    let active = 0;
    const cleanup = await plugin.setup({options:{"omo-senpi-lsp-tools-enabled":false,"omo-senpi-git-master-attribution-disabled":true,"omo-senpi-ultrawork-disabled":true,"omo-senpi-todo-fanout-reminder-disabled":true,"omo-senpi-question-gates-disabled":true,"omo-senpi-comment-checker-disabled":true,"omo-memory-enabled":false},location:{directory:process.cwd()}, agent:{transform:async()=>{active++;return {dispose:async()=>{active--}}}}, rpc:{register:async()=>{active++;return {dispose:async()=>{active--}}}}});
    if(active!==2) throw new Error("V2 setup did not register");
    await cleanup(); await cleanup();
    if(active!==0) throw new Error("V2 cleanup leaked");
    const {default: rootPlugin} = await import(${JSON.stringify(entry)});
    const rootCleanup = await rootPlugin.setup({options:{"omo-senpi-lsp-tools-enabled":false,"omo-senpi-git-master-attribution-disabled":true,"omo-senpi-ultrawork-disabled":true,"omo-senpi-todo-fanout-reminder-disabled":true,"omo-senpi-question-gates-disabled":true,"omo-senpi-comment-checker-disabled":true,"omo-memory-enabled":false},location:{directory:process.cwd()}, agent:{transform:async()=>{active++;return {dispose:async()=>{active--}}}}, rpc:{register:async()=>{active++;return {dispose:async()=>{active--}}}}});
    if(active!==2 || globalThis.__hostDefines!==2) throw new Error("Normal root did not load lazy host SDK graph");
    await rootCleanup(); await rootCleanup();
    if(active!==0) throw new Error("Root V2 cleanup leaked");
    console.log("Both V2 routes use external SDK and dispose registrations");
  `])
  expect(v2.status, v2.stdout + v2.stderr).toBe(0)
}, 120_000)
