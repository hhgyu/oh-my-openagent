import { expect, it } from "bun:test"
import { createPromptPresetPort, type PromptOptions } from "./prompt-preset"

const options: PromptOptions = {
  appName: "OpenCode OmO", cwd: "/current/workspace", selectedTools: ["read", "custom_read"],
  toolSnippets: { custom_read: "CURRENT_TOOL_SNIPPET" }, promptGuidelines: ["CURRENT_GUIDELINE"],
  contextFiles: [{ path: "/current/AGENTS.md", content: "CURRENT_PROJECT_RULE" }, { path: "/user/AGENTS.md", content: "CURRENT_USER_RULE", scope: "user" }],
  skills: [{ name: "current-skill", description: "CURRENT_SKILL_DESCRIPTION", filePath: "/current/skills/current/SKILL.md", baseDir: "/current/skills/current", sourceInfo: { path: "/current/skills/current/SKILL.md", source: "fixture", scope: "project", origin: "top-level" }, disableModelInvocation: false }], surface: "app",
}

it("renders exact public Native per-model presets with current host context and appends", async () => {
  const port = await createPromptPresetPort()
  const native = await import("@code-yeongyu/senpi/prompt-presets")
  const before = JSON.stringify(options)
  const model = { provider: "openai", id: "gpt-5.4" }
  const first = port.render({ model, settings: { promptPreset: "auto" }, options, appendSystemPrompt: "CURRENT_APPEND" })
  expect(first.source).toBe("preset")
  expect(first.preset).toBe("gpt-5.4")
  expect(first.prompt).toBe(native.resolvePreset(model, { promptPreset: "auto" }, options)!.prompt + "\n\nCURRENT_APPEND")
  expect(first.prompt).toContain("CURRENT_PROJECT_RULE")
  expect(first.prompt).toContain("CURRENT_USER_RULE")
  expect(first.prompt).toContain("CURRENT_TOOL_SNIPPET")
  expect(first.prompt).toContain("CURRENT_GUIDELINE")
  expect(first.prompt).toContain("CURRENT_SKILL_DESCRIPTION")
  expect(first.prompt).toContain("<r0>/current/skills</r0>")
  expect(first.prompt).toContain("<location>r0/current/SKILL.md</location>")
  // Current Native sends cwd in its environment context, not in system text.
  expect(port.buildDynamicSystemPrompt({ ...options, cwd: "/other/workspace" })).toBe(port.buildDynamicSystemPrompt(options))
  const second = port.render({ model: { provider: "anthropic", id: "claude-opus-4-6" }, settings: { promptPreset: "auto" }, options: { ...options, selectedTools: [], toolSnippets: {}, promptGuidelines: [] } })
  expect(second.preset).toBe("claude-opus-4-6")
  expect(second.prompt).not.toBe(first.prompt)
  expect(second.prompt).not.toContain("CURRENT_TOOL_SNIPPET")
  expect(JSON.stringify(options)).toBe(before)
  expect(port.resolvePresetName({ providerID: "openai", modelID: "gpt-5.4" })).toBe("gpt-5.4")
  expect(port.buildPreset("gpt-5.4", options).prompt).toBe(native.buildPreset("gpt-5.4", options).prompt)
  expect(port.render({ model: { provider: "custom", id: "unknown", promptPreset: "gpt-5.4" }, settings: { promptPreset: "auto" }, options }).preset).toBe("gpt-5.4")
  expect(port.render({ model, settings: { promptPreset: "claude-opus-4-6" }, options }).preset).toBe("claude-opus-4-6")
  expect(port.render({ model, settings: { promptPreset: "auto" }, options: { ...options, surface: "terminal" } }).prompt).not.toBe(first.prompt.replace(/\n\nCURRENT_APPEND$/, ""))
})

it("matches Native custom prompt and append precedence, including empty explicit prompt", async () => {
  const port = await createPromptPresetPort()
  const input = { model: { provider: "openai", id: "gpt-5.4" }, settings: { promptPreset: "auto" as const }, options }
  expect(port.render({ ...input, customPrompt: "CUSTOM", appendSystemPrompt: "APPEND" })).toEqual({ source: "custom", prompt: "CUSTOM\n\nAPPEND" })
  expect(port.render({ ...input, customPrompt: "CUSTOM", appendSystemPrompt: "" }).prompt).toBe("CUSTOM\n\n")
  expect(port.render({ ...input, customPrompt: "" }).source).toBe("preset")
  const unknown = { ...input, model: { provider: "custom", id: "unknown-model" } }
  expect(port.render({ ...unknown, customPrompt: "", appendSystemPrompt: "APPEND" })).toEqual({ source: "custom", prompt: "\n\nAPPEND" })
  expect(port.render({ ...unknown, appendSystemPrompt: "APPEND" })).toEqual({ source: "dynamic", prompt: port.buildDynamicSystemPrompt(options) + "\n\nAPPEND" })
  expect(port.render({ settings: input.settings, options, customPrompt: "CUSTOM" })).toEqual({ source: "custom", prompt: "CUSTOM" })
})

it("preserves runtime fullToolPrompt contributions separately from model-visible diet contributions", async () => {
  const port = await createPromptPresetPort()
  const full: PromptOptions = { ...options, fullToolPrompt: { toolSnippets: { custom_read: "FULL_SHARED_SNIPPET" }, promptGuidelines: ["FULL_SHARED_GUIDELINE"] } }
  const fullPreset = port.buildPreset("claude-opus-4-6", full)
  expect(fullPreset.prompt).toContain("FULL_SHARED_SNIPPET")
  expect(fullPreset.prompt).toContain("FULL_SHARED_GUIDELINE")
  expect(fullPreset.prompt).not.toContain("CURRENT_TOOL_SNIPPET")
  const resolved = port.resolvePreset({ provider: "anthropic", id: "claude-opus-4-6" }, { promptPreset: "auto" }, full)
  expect(resolved?.prompt).toBe(fullPreset.prompt)
  const diet = port.buildDynamicSystemPrompt(full)
  expect(diet).toContain("CURRENT_TOOL_SNIPPET")
  expect(diet).not.toContain("FULL_SHARED_SNIPPET")
})

it("loads only the public preset graph, without warming engine/session/settings runtime", async () => {
  const script = `const Module = await import('node:module');
    let engineRootLoads = 0;
    Module.registerHooks({ resolve(specifier, context, nextResolve) {
      if (specifier === '@code-yeongyu/senpi' || /(?:^|\\/)core\\/(?:agent-session|settings-manager)\\.js$/.test(specifier)) { engineRootLoads++; throw new Error('Forbidden engine load: ' + specifier) }
      return nextResolve(specifier, context);
    }});
    await createPromptPresetPort(); console.log(JSON.stringify({ engineRootLoads }));`
  // Bun does not implement Node module hooks: use a tiny bundled entry with the
  // public preset external so Node observes its actual installed import graph.
  const built = await Bun.build({ entrypoints: [import.meta.dir + "/prompt-preset.ts"], target: "node", external: ["@code-yeongyu/senpi/prompt-presets"] })
  expect(built.success).toBe(true)
  // Inspect the complete Bun graph as a second guard; no execution of a private module.
  const graph = await Bun.build({ entrypoints: [import.meta.dir + "/prompt-preset.ts"], target: "bun", metafile: true })
  expect(graph.success).toBe(true)
  const inputs = Object.keys(graph.metafile!.inputs).join("\n").replaceAll("\\", "/")
  expect(inputs).toContain("prompt-preset/public.js")
  expect(inputs).not.toMatch(/senpi\/dist\/index\.js|core\/agent-session\.js|core\/settings-manager\.js/)
  const process = Bun.spawn(["node", "--input-type=module", "--eval", await built.outputs[0].text() + "\n" + script], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  expect(stderr).toBe("")
  expect(code).toBe(0)
  expect(JSON.parse(stdout)).toEqual({ engineRootLoads: 0 })
})
