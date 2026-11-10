import { describe, expect, test } from "bun:test"
import type { RecallCorpus, RecallNudge } from "@oh-my-opencode/memory-core"
import { Error as ToolError, type Info, type Result, type ToolContext } from "@opencode/plugin/promise/tool"
import { z } from "zod"
import type { KibitzerToolBinding } from "./contract"
import { applyNudge } from "./nudge"
import type { KibitzerSidecar } from "./sidecar"
import { createKibitzerTools, wrapMemoryTool, type KibitzerToolsDeps } from "./tools"

const corpus: RecallCorpus = {
  revision: "abc123",
  documents: [
    { path: "reference/rollout.md", description: "Kubernetes rollout goes through staging first", body: "Staging cluster before production rollout." },
    { path: "system/persona.md", description: "persona", body: "hidden" },
  ],
}

function binding(overrides: Partial<KibitzerToolBinding> = {}): KibitzerToolBinding {
  let used = 0
  return {
    parentSessionId: "root", offered: new Set(["reference/rollout.md"]), searched: new Set(), surfaced: new Set(), maxItems: 2, accepted: [],
    charge: () => { used += 1; return used <= 8 }, budgetLimit: 8, ...overrides,
  }
}

function deps(live: Record<string, KibitzerToolBinding>): KibitzerToolsDeps {
  const sidecar = { history: () => [] } as unknown as KibitzerSidecar
  return {
    resolve: sessionID => (live[sessionID] === undefined ? undefined : { sidecar, binding: live[sessionID] }),
    corpus: async () => corpus,
  }
}

const context = (sessionID: string, id = "call-1") =>
  ({ sessionID, agent: "kibitzer", messageID: "m1", id, signal: new AbortController().signal, progress: async () => undefined }) as unknown as ToolContext

function writer(calls: unknown[]): Info<z.ZodObject<{ command: z.ZodEnum<{ create: "create" }>; reason: z.ZodString }>> {
  return {
    name: "memory", description: "writer", input: z.object({ command: z.enum(["create"]), reason: z.string() }), options: { codemode: false },
    execute: async input => { calls.push(input); return { content: "written" } },
  }
}

const run = (tool: Info, input: Record<string, unknown>, ctx: ToolContext): Promise<Result> => Reflect.apply(tool.execute, undefined, [input, ctx])

describe("kibitzer tools", () => {
  test("#given a session that is not a live Kibitzer child #when it calls session_entries, nudge or a read-only memory operation #then each call is refused", async () => {
    // given
    const toolDeps = deps({ "ses_kibitzer_1": binding() })
    const [entries, nudge] = createKibitzerTools(toolDeps)
    const memory = wrapMemoryTool(writer([]), toolDeps)
    // when
    const refusals = [
      run(entries, {}, context("root")),
      run(nudge, { path: "reference/rollout.md", hint: "The note records that rollouts use staging." }, context("ses_other")),
      run(memory, { operation: "search", query: "rollout" }, context("root")),
    ]
    // then
    for (const refusal of refusals) await expect(refusal).rejects.toBeInstanceOf(ToolError)
  })

  test("#given a live Kibitzer child #then memory search feeds the nudge allowed set, read hides system/ and the writer path is refused", async () => {
    // given
    const calls: unknown[] = []
    const live = binding({ offered: new Set() })
    const memory = wrapMemoryTool(writer(calls), deps({ "ses_kibitzer_1": live }))
    // when
    const search = await run(memory, { operation: "search", query: "kubernetes rollout" }, context("ses_kibitzer_1"))
    const read = await run(memory, { operation: "read", path: "reference/rollout.md" }, context("ses_kibitzer_1", "call-2"))
    const hidden = run(memory, { operation: "read", path: "system/persona.md" }, context("ses_kibitzer_1", "call-3"))
    const write = run(memory, { command: "create", reason: "sneaky" }, context("ses_kibitzer_1", "call-4"))
    const parentWrite = await run(memory, { command: "create", reason: "parent" }, context("root"))
    // then
    expect(JSON.parse(String(search.content)).results.map((hit: { path: string }) => hit.path)).toEqual(["reference/rollout.md"])
    expect([...live.searched]).toEqual(["reference/rollout.md"])
    expect(String(read.content)).toContain("Staging cluster")
    await expect(hidden).rejects.toThrow("system_path")
    await expect(write).rejects.toThrow("may only search or read")
    expect(parentWrite.content).toBe("written")
    expect(calls).toEqual([{ command: "create", reason: "parent" }])
  })

  test("#given an exhausted wake budget #then a Kibitzer tool call is rejected as tool_budget_exceeded", async () => {
    // given
    const [entries] = createKibitzerTools(deps({ "ses_kibitzer_1": binding({ charge: () => false }) }))
    // when
    const call = run(entries, {}, context("ses_kibitzer_1"))
    // then
    await expect(call).rejects.toThrow("tool_budget_exceeded")
  })
})

describe("kibitzer nudge validation", () => {
  const input = (accepted: RecallNudge[] = []) => ({
    offered: new Set(["reference/rollout.md", "reference/old.md", "system/persona.md"]), searched: new Set(["reference/found.md"]),
    surfaced: new Set(["reference/old.md"]), maxItems: 1, accepted,
  })

  test("#given invalid nudges #then each is rejected with its reason and nothing is recorded", () => {
    // given
    const accepted: RecallNudge[] = []
    const cases = [
      { path: "reference/fabricated.md", hint: "The note records a fact." },
      { path: "reference/old.md", hint: "The note records a fact." },
      { path: "system/persona.md", hint: "The note records a fact." },
      { path: "reference/rollout.md", hint: "The note records the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG." },
      { path: "reference/rollout.md", hint: "You must deploy to staging first." },
    ]
    // when
    const results = cases.map(params => applyNudge(params, { ...input(), accepted }))
    // then
    expect(results.map(result => result.ok)).toEqual([false, false, false, false, false])
    expect(results.map(result => result.message)).toEqual([
      expect.stringContaining("not one of the offered candidates"),
      expect.stringContaining("already surfaced"),
      expect.stringContaining("system/ path"),
      expect.stringContaining("secret-like material"),
      expect.stringContaining("addresses the agent"),
    ])
    expect(accepted).toEqual([])
  })

  test("#given a valid observation for a searched path #then it is recorded and the maxItems cap ends the run", () => {
    // given
    const accepted: RecallNudge[] = []
    // when
    const first = applyNudge({ path: "reference/found.md", hint: "The note records that rollouts go through staging first." }, { ...input(), accepted })
    const second = applyNudge({ path: "reference/rollout.md", hint: "The note records a second fact." }, { ...input(), accepted })
    // then
    expect(first).toMatchObject({ ok: true, capped: true })
    expect(second.ok).toBe(false)
    expect(accepted).toEqual([{ path: "reference/found.md", hint: "The note records that rollouts go through staging first." }])
  })
})
