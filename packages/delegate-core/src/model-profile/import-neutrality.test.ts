import { expect, it } from "bun:test"

it("loads and executes the private Core selector in a fresh process without harness or IO imports", async () => {
  const forbidden = /(?:@code-yeongyu\/senpi|@earendil-works\/pi|(?:^|[\/\\])(?:omo-senpi|senpi-task|omo-opencode|omo-codex)(?:[\/\\]|$)|^(?:node:)?(?:fs|child_process|net|http|https)(?:\/|$))/
  const denied: string[] = []
  const built = await Bun.build({
    entrypoints: [import.meta.dir + "/resolve.ts"], target: "node", metafile: true,
    plugins: [{ name: "forbid-harness-and-io", setup(build) {
      build.onResolve({ filter: forbidden }, (args) => { denied.push(args.path); throw new Error("Forbidden Core dependency: " + args.path) })
    } }],
  })
  expect(denied).toEqual([])
  expect(built.success).toBe(true)
  for (const path of Object.keys(built.metafile!.inputs)) expect(path).not.toMatch(forbidden)
  const script = `
    const Module = await import("node:module");
    const blockedPattern = new RegExp(${JSON.stringify(forbidden.source)});
    let blockedLoads = 0;
    Module.registerHooks({ resolve(specifier, context, nextResolve) {
      if (blockedPattern.test(specifier)) { blockedLoads++; throw new Error("BLOCKED_HARNESS_IMPORT") }
      return nextResolve(specifier, context);
    }});
    ` + await built.outputs[0].text() + `
    const result = resolveModelProfile({ active: "daily-normal", availableModels: ["anthropic/claude-opus-5-5"] });
    const productionBlockedLoads = blockedLoads;
    let blockerCanary = false;
    try { await import("@code-yeongyu/senpi") } catch (error) { blockerCanary = error.message === "BLOCKED_HARNESS_IMPORT" }
    console.log(JSON.stringify({ result, productionBlockedLoads, blockerCanary, blockedLoads }));`
  const child = Bun.spawn(["node", "--input-type=module", "--eval", script], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  expect(JSON.parse(stdout)).toMatchObject({
    result: { kind: "resolved", provider: "anthropic", modelId: "claude-opus-5-5", reasoning: "medium" },
    productionBlockedLoads: 0, blockerCanary: true, blockedLoads: 1,
  })
})
