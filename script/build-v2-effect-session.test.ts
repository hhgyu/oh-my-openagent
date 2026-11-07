import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { BUILD_NODES } from "./build-nodes"

test("Effect session bridge bundles public protocol codecs and keeps host Effect external", async () => {
  const root = resolve(import.meta.dir, "..")
  const evidence = join(root, ".omo/evidence/20261108-v2-owned-child-controls")
  mkdirSync(evidence, { recursive: true })
  const output = mkdtempSync(join(evidence, "effect-session-build-"))
  const entry = join(output, "session-api.mjs")
  const node = BUILD_NODES.find(value => value.id === "v2-index")!
  const external = node.args.flatMap((argument, index) => argument === "--external" ? ["--external", node.args[index + 1]!] : [])
  async function run(command: string, args: string[]) {
    const child = Bun.spawn([command, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" })
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    return { exitCode, stdout, stderr }
  }
  const build = await run(process.execPath, ["build", "packages/omo-opencode/src/v2/host/effect-session-backend-api.ts", "--target", "bun", "--format", "esm", "--outfile", entry, ...external])
  writeFileSync(join(output, "build-result.json"), JSON.stringify(build, null, 2))
  expect(build.exitCode, build.stderr).toBe(0)
  const body = readFileSync(entry, "utf8")
  expect(/from ["']effect(?:\/[^"']*)?["']/.test(body)).toBe(true)
  expect(/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?effect\//.test(body)).toBe(false)
  expect(/(?:from|import\()\s*["']@opencode\/(?:protocol|schema)(?:\/[^"']*)?["']/.test(body)).toBe(false)
  const loader = join(output, "deny-sdk-and-codecs.mjs")
  writeFileSync(loader, `export function resolve(specifier, context, next) {
    if (/^@opencode\\/(?:plugin|protocol|schema)(?:\\/|$)/.test(specifier)) throw new Error("Unexpected unbundled SDK codec dependency");
    return next(specifier, context);
  }`)
  const imported = await run("node", ["--experimental-loader", pathToFileURL(loader).href, "--input-type=module", "-e", `
    const module = await import(${JSON.stringify(pathToFileURL(entry).href)});
    if (typeof module.createEffectSessionBackendApi !== "function") throw new Error("Missing real session bridge");
    console.log("Public codecs bundled; host Effect external");
  `])
  writeFileSync(join(output, "node-result.json"), JSON.stringify(imported, null, 2))
  expect(imported.exitCode, imported.stderr).toBe(0)
}, 60_000)
