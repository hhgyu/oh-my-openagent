import { afterEach, expect, test } from "bun:test"
import type * as Plugin from "@opencode/plugin/promise/plugin"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerGitMasterReadHook } from "./git-master"

type ContentPart = { readonly type: string; readonly text?: string; readonly extra?: string; readonly data?: string }
type ReadContent = string | readonly ContentPart[]
type ReadEvent = { tool: string; status: string; input: object; result: { content: ReadContent } }
function parts(content: ReadContent): readonly ContentPart[] {
  if (typeof content === "string") throw new Error("Expected structured read content")
  return content
}
function textContent(content: ReadContent): string {
  if (typeof content !== "string") throw new Error("Expected string read content")
  return content
}

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function fixture(settings: object = {}, options: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "omo-git-master-")); dirs.push(directory)
  mkdirSync(join(directory, ".omo"))
  const config = (value: object) => writeFileSync(join(directory, ".omo", "omo.jsonc"), JSON.stringify({ git_master: value }))
  config(settings)
  let callback: (event: ReadEvent) => void = () => { throw new Error("Hook not registered") }
  let registrations = 0, disposals = 0
  const host = { location: { directory }, options, tool: { hook: async (name: string, hook: typeof callback) => {
    expect(name).toBe("execute.after"); registrations++; callback = hook
    return { dispose: async () => { disposals++ } }
  } } } as unknown as Pick<Plugin.Context, "location" | "options" | "tool">
  const read = (content: ReadContent = "git status", overrides: object = {}) => {
    const event = { tool: "read", status: "completed", input: { path: "C:\\skills\\git-master\\SKILL.md" }, result: { content, title: "KEEP", metadata: { marker: "KEEP" }, custom: 42 }, ...overrides }
    callback(event); return event
  }
  return { host, read, config, counts: () => [registrations, disposals] }
}
test("completed read uses canonical receiving config on every call and preserves host fields", async () => {
  const f = fixture({ commit_footer: "SYNTHETIC_ONE", include_co_authored_by: false, git_env_prefix: "SYNTHETIC=1" })
  const close = await registerGitMasterReadHook(f.host)
  const result = f.read().result
  expect(result.content).toContain("SYNTHETIC_ONE"); expect(result.content).toContain("SYNTHETIC=1 git status")
  expect(result.title).toBe("KEEP"); expect(result.metadata).toEqual({ marker: "KEEP" }); expect(result.custom).toBe(42)
  f.config({ commit_footer: "SYNTHETIC_TWO", include_co_authored_by: false, git_env_prefix: "" })
  expect(f.read().result.content).toContain("SYNTHETIC_TWO")
  await close(); await close(); expect(f.counts()).toEqual([1, 1])
  expect(f.read().result.content).toBe("git status")
})
test("first text only, frontmatter and nontext retained, dedup across all texts", async () => {
  const f = fixture({ git_env_prefix: "PREFIX=1" }); await registerGitMasterReadHook(f.host)
  const image = { type: "image", data: "KEEP" }
  const first = { type: "text", text: "---\nname: git-master\n---\ngit status", extra: "KEEP" }
  const last = { type: "text", text: "<commit_attribution>EXISTING</commit_attribution>\ngit log" }
  const event = f.read([image, first, last])
  expect(event.result.content).toHaveLength(3)
  expect(event.result.content[0]).toBe(image); expect(event.result.content[2]).toBe(last)
  expect(parts(event.result.content)[1]?.extra).toBe("KEEP")
  expect(parts(event.result.content)[1]?.text).toStartWith("---\nname: git-master\n---\n")
  expect(parts(event.result.content)[1]?.text).toContain("PREFIX=1 git status")
})
test("default attribution appends one block, all-off preserves result identity and guards skip", async () => {
  const f = fixture(); await registerGitMasterReadHook(f.host)
  const event = f.read([{ type: "text", text: "git status" }])
  expect(event.result.content).toHaveLength(2)
  expect(parts(event.result.content)[1]?.text).toContain("Co-authored-by:")
  for (const overrides of [{ tool: "bash" }, { status: "error" }, { input: { path: "/other/SKILL.md" } }, { input: { file_path: 4, path: "/git-master/SKILL.md" } }]) {
    expect(f.read("UNCHANGED", overrides).result.content).toBe("UNCHANGED")
  }
  f.config({ commit_footer: false, include_co_authored_by: false, git_env_prefix: "" })
  const original = { content: "UNCHANGED", title: "same" }
  expect(f.read("", { result: original }).result).toBe(original)
})
test("strict disable gates sampled only at registration", async () => {
  const prior = process.env.OMO_SENPI_DISABLED
  try {
    delete process.env.OMO_SENPI_DISABLED
    for (const key of ["omo-senpi-disabled", "omo-senpi-git-master-attribution-disabled"]) {
      const f = fixture({}, { [key]: true }); await registerGitMasterReadHook(f.host); expect(f.counts()).toEqual([0, 0])
      const enabled = fixture({}, { [key]: "true" }); await registerGitMasterReadHook(enabled.host); expect(enabled.counts()[0]).toBe(1)
    }
    process.env.OMO_SENPI_DISABLED = "1"
    const f = fixture(); await registerGitMasterReadHook(f.host); expect(f.counts()[0]).toBe(0)
    process.env.OMO_SENPI_DISABLED = "true"
    const g = fixture(); await registerGitMasterReadHook(g.host); expect(g.counts()[0]).toBe(1)
    process.env.OMO_SENPI_DISABLED = "1"
    expect(g.read().result.content).toContain("<commit_attribution>")
  } finally { if (prior === undefined) delete process.env.OMO_SENPI_DISABLED; else process.env.OMO_SENPI_DISABLED = prior }
})

test("receiving workspaces remain isolated, file_path takes priority, registration rejection propagates", async () => {
  const a = fixture({ commit_footer: "WORKSPACE_A", include_co_authored_by: false, git_env_prefix: "" })
  const b = fixture({ commit_footer: "WORKSPACE_B", include_co_authored_by: false, git_env_prefix: "" })
  const closeA = await registerGitMasterReadHook(a.host); const closeB = await registerGitMasterReadHook(b.host)
  const resultA = a.read("body", { input: { file_path: "/skills/git-master/SKILL.md", path: "/other/SKILL.md" } }).result.content
  const resultB = b.read().result.content
  expect(resultA).toContain("WORKSPACE_A"); expect(resultA).not.toContain("WORKSPACE_B")
  expect(resultB).toContain("WORKSPACE_B"); expect(resultB).not.toContain("WORKSPACE_A")
  await closeA(); await closeB()
  const broken = fixture(); broken.host.tool.hook = async () => { throw new Error("REGISTRATION_FAILED") }
  await expect(registerGitMasterReadHook(broken.host)).rejects.toThrow("REGISTRATION_FAILED")
})

test("attribution-only result remains identical and directive appears once on repeated reads", async () => {
  const f = fixture({ commit_footer: true, git_env_prefix: "" }); const close = await registerGitMasterReadHook(f.host)
  const first = f.read("```bash\ngit status\n```").result
  const second = f.read("", { result: first }).result
  expect(second).toBe(first)
  expect((textContent(second.content).match(/<commit_attribution>/g) ?? []).length).toBe(1)
  await close()
})

