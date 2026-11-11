import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ReflectionRequest } from "@oh-my-opencode/memory-core"
import { OmoMemorySettingsSchema } from "@oh-my-opencode/omo-config-core"
import type { BoundMemorySession } from "./binding"
import { underSystemTokenPressure } from "./dream-budget"
import { createScriptedFactsPorts } from "./facts.test-support"
import { createManualTimers } from "./kibitzer/test-support"
import { DREAM_AGENT_ID } from "./reflection-agent"
import { createReflectionChildHosting } from "./reflection-child"
import { reflectionRunDir } from "./reflection-run-store"
import { createReflectionRunner } from "./reflection-runner"
import { REFLECTION_MEMORY_TOOL_NAME } from "./reflection-tools"
import { createBoundIdentity, runTool, toolContext } from "./reflection.test-support"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function setup(compileWarnTokens = 30_000) {
  const identity = createBoundIdentity()
  cleanups.push(identity.cleanup)
  const bound: BoundMemorySession = { ...identity.bound, settings: OmoMemorySettingsSchema.parse({ compile_warn_tokens: compileWarnTokens }) }
  const ports = createScriptedFactsPorts()
  const hosting = createReflectionChildHosting({ host: { session: {} }, createPort: request => ports.createPort(request), timers: createManualTimers(), warn: () => undefined })
  const runner = createReflectionRunner({ launch: hosting.launch, warn: () => undefined, createRunId: () => "dream-a" })
  const edit = hosting.tools().find(entry => entry.name === REFLECTION_MEMORY_TOOL_NAME)
  if (edit === undefined) throw new Error("reflection_memory missing")
  const run = (request: Partial<ReflectionRequest>) => runner.runReflection(bound, {
    parentSessionId: bound.sessionID, request: { trigger: "dream", origin: "manual", conversationIds: [], snapshots: [], ...request },
  })
  const create = (sessionID: string, path: string) => runTool(edit, {
    command: "create", reason: "chore(dream): note", file_path: path, description: "A note", file_text: "Note.\n",
  }, toolContext(sessionID))
  const final = (): Record<string, unknown> => JSON.parse(readFileSync(join(reflectionRunDir(bound, "dream-a"), "final.json"), "utf8"))
  return { bound, ports, run, create, final }
}

describe("dream runs", () => {
  test("#given a dream with a target document #when the child edits only the target #then the omo-dream agent ran with the dream inputs and the edit merged", async () => {
    // given
    const { bound, ports, run, create } = setup()
    const running = run({ targetDoc: "reference/build.md", focus: "build" })
    const child = await ports.started(1)
    // when
    await create(child.sessionID, "reference/build.md")
    child.finish()
    const report = await running
    // then
    expect(ports.requests[0]?.agent).toBe(DREAM_AGENT_ID)
    expect(child.start.prompt).toContain("Document maintenance target: reference/build.md")
    expect(child.start.prompt).toContain("System token budget: 30000")
    expect(child.start.prompt).toContain("System token target: 24000")
    expect(child.start.prompt).toContain("## People policy")
    expect(report.status === "finished" ? report.runs[0]?.outcome : undefined).toBe("merged")
    expect(existsSync(join(bound.paths.repo, "reference", "build.md"))).toBe(true)
  })

  test("#given a dream with a target document #when the child edits another document #then the run fails invalid_target and nothing merges", async () => {
    // given
    const { bound, ports, run, create } = setup()
    const running = run({ targetDoc: "reference/build.md" })
    const child = await ports.started(1)
    // when
    await create(child.sessionID, "reference/other.md")
    child.finish()
    const report = await running
    // then
    expect(report.status === "finished" ? report.runs[0] : undefined).toMatchObject({ outcome: "failed", reason: "invalid_target" })
    expect(existsSync(join(bound.paths.repo, "reference", "other.md"))).toBe(false)
  })

  test("#given a committed system tree over the soft target #when a pressure dream merges without trimming it #then it stays merged and records budget_not_met", async () => {
    // given
    const { ports, run, create, final } = setup(10)
    const running = run({ origin: "pressure" })
    const child = await ports.started(1)
    // when
    await create(child.sessionID, "reference/build.md")
    child.finish()
    await running
    // then
    expect(final()).toMatchObject({ outcome: "merged", reason: "budget_not_met" })
  })

  test("#given the same tree #when an idle dream merges #then the budget check only records the estimate", async () => {
    // given
    const { ports, run, create, final } = setup(10)
    const running = run({ origin: "idle" })
    const child = await ports.started(1)
    // when
    await create(child.sessionID, "reference/build.md")
    child.finish()
    await running
    // then
    expect(final()).toMatchObject({ outcome: "merged" })
    expect(final().reason).toBeUndefined()
  })

  test("#given a memory repo #when the bind-time pressure probe runs #then it reports pressure only at or above the soft target", async () => {
    // given
    const small = setup(10)
    const large = setup(1_000_000)
    const missing = await underSystemTokenPressure(small.bound)
    for (const fixture of [small, large]) {
      const running = fixture.run({})
      const child = await fixture.ports.started(1)
      child.finish()
      await running
    }
    // when
    const results = [await underSystemTokenPressure(small.bound), await underSystemTokenPressure(large.bound)]
    // then
    expect(missing).toBe(false)
    expect(results).toEqual([true, false])
  })
})
