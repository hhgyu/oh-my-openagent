import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ReflectionRequest } from "@oh-my-opencode/memory-core"
import { createScriptedFactsPorts } from "./facts.test-support"
import { createManualTimers, flush } from "./kibitzer/test-support"
import { createReflectionChildHosting } from "./reflection-child"
import { reflectionRunDir, reflectionStore } from "./reflection-run-store"
import type { ReflectionModelResolution } from "./reflection-model"
import { createReflectionRunner } from "./reflection-runner"
import { REFLECTION_MEMORY_TOOL_NAME, REFLECTION_READ_TOOL_NAME } from "./reflection-tools"
import { createBoundIdentity, runTool, toolContext } from "./reflection.test-support"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

function setup(options: { readonly deadlineMs?: number; readonly model?: ReflectionModelResolution } = {}) {
  const identity = createBoundIdentity()
  cleanups.push(identity.cleanup)
  const ports = createScriptedFactsPorts()
  const timers = createManualTimers()
  const warnings: string[] = []
  const warn = (message: string): void => {
    warnings.push(message)
  }
  const hosting = createReflectionChildHosting({
    host: { session: {} },
    createPort: (request) => ports.createPort(request),
    timers,
    warn,
  })
  const resolution = options.model
  const runner = createReflectionRunner({
    launch: hosting.launch,
    warn,
    createRunId: () => "run-a",
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(resolution === undefined ? {} : { resolveModel: async () => resolution }),
  })
  const tool = (name: string) => {
    const found = hosting.tools().find((entry) => entry.name === name)
    if (found === undefined) throw new Error(`${name} missing`)
    return found
  }
  const run = (request: Partial<ReflectionRequest> = {}) =>
    runner.runReflection(identity.bound, {
      parentSessionId: "ses_root",
      request: { trigger: "manual", conversationIds: [], snapshots: [], focus: "tabs", ...request },
    })
  const prelaunch = (): { worktreeDir: string; worktreeBranch: string } =>
    JSON.parse(readFileSync(join(reflectionRunDir(identity.bound, "run-a"), "prelaunch.json"), "utf8"))
  return { bound: identity.bound, ports, timers, warnings, tool, run, prelaunch }
}

const createInput = {
  command: "create",
  reason: "feat(reflection): tabs",
  file_path: "reference/tabs.md",
  description: "Indentation preference",
  file_text: "Tabs.\n",
}

describe("reflection runner", () => {
  test.each(["manual", "dream"] as const)(
    "#given %s model fallback #then variants reach launch and attempted models persist on the final record",
    async (trigger) => {
      const { bound, ports, run } = setup({
        model: {
          kind: "resolved",
          category: "custom",
          model: "test/first",
          variant: "high",
          fallbacks: [{ model: "test/second", variant: "low" }],
        },
      })
      const running = run({ trigger, ...(trigger === "dream" ? { origin: "manual" } : {}) })
      const first = await ports.started(1)
      expect(first.start.model).toMatchObject({ id: "first", variant: "high" })
      first.finish({
        status: "error",
        error: { name: "APIError", data: { statusCode: 429, message: "limit reached" } },
      })
      const second = await ports.started(2)
      expect(first.disposed).toBe(true)
      expect(second.start.model).toMatchObject({ id: "second", variant: "low" })
      second.finish()
      const result = await running
      expect(result.status === "finished" ? result.runs[0] : undefined).toMatchObject({
        outcome: "no_changes",
        detail: "attempted models: test/first -> test/second",
      })
      expect(JSON.parse(readFileSync(join(reflectionRunDir(bound, "run-a"), "final.json"), "utf8"))).toMatchObject({
        outcome: "no_changes",
        detail: "attempted models: test/first -> test/second",
      })
    },
  )
  test("#given a child that edits through reflection_memory #when the run finishes #then the branch is merged into the memory repo, the worktree is removed and the reservation completes", async () => {
    // given
    const { bound, ports, tool, run, prelaunch } = setup()
    const running = run()
    const child = await ports.started(1)
    const { worktreeDir, worktreeBranch } = prelaunch()

    // when
    const transcript = await runTool(
      tool(REFLECTION_READ_TOOL_NAME),
      { target: "transcript" },
      toolContext(child.sessionID),
    )
    await runTool(tool(REFLECTION_MEMORY_TOOL_NAME), createInput, toolContext(child.sessionID))
    child.finish()
    const report = await running

    // then
    expect(String(transcript.content)).toContain('"schemaVersion": 1')
    expect(String(transcript.content)).toContain('"runId": "run-a"')
    expect(report.status).toBe("finished")
    const result = report.status === "finished" ? report.runs[0] : undefined
    expect(result).toMatchObject({ runId: "run-a", outcome: "merged", cleanedUp: true })
    expect(readFileSync(join(bound.paths.repo, "reference", "tabs.md"), "utf8")).toContain("Tabs.")
    expect(git(bound.paths.repo, "log", "-1", "--format=%s")).toBe("merge(reflection): manual run-a")
    expect(git(bound.paths.repo, "rev-parse", "HEAD")).toBe(result?.integrationSha ?? "")
    expect(existsSync(worktreeDir)).toBe(false)
    expect(git(bound.paths.repo, "branch", "--list", worktreeBranch)).toBe("")
    expect((await reflectionStore(bound).readState()).active).toBeUndefined()
    expect(JSON.parse(readFileSync(join(reflectionRunDir(bound, "run-a"), "final.json"), "utf8"))).toMatchObject({
      runId: "run-a",
      outcome: "merged",
    })
  })

  test("#given a child that committed and then failed #when the run finishes #then nothing merges, the worktree is removed and the failure is parked like Senpi's", async () => {
    // given
    const { bound, ports, tool, run, prelaunch } = setup({
      model: { kind: "resolved", category: "custom", model: "test/first", fallbacks: [{ model: "test/second" }] },
    })
    const running = run({ trigger: "step-count" })
    const child = await ports.started(1)
    const { worktreeDir } = prelaunch()
    await runTool(tool(REFLECTION_MEMORY_TOOL_NAME), createInput, toolContext(child.sessionID))

    // when
    child.finish({ status: "error", message: "provider returned 503" })
    const report = await running

    // then
    expect(report.status === "finished" ? report.runs[0] : undefined).toMatchObject({
      outcome: "failed",
      reason: "child_exit",
      cleanedUp: true,
    })
    expect(ports.children).toHaveLength(1)
    expect(existsSync(join(bound.paths.repo, "reference", "tabs.md"))).toBe(false)
    expect(existsSync(worktreeDir)).toBe(false)
    const store = reflectionStore(bound)
    expect((await store.readState()).active).toBeUndefined()
    const park = await store.readPark()
    expect(park.streak).toBe(1)
    expect(park.lastFailure).toMatchObject({ runId: "run-a", reason: "child_exit", retryable: true })
  })

  test("#given a child that never settles #when the deadline fires #then the run times out with no merge and the worktree is removed", async () => {
    // given
    const { bound, ports, timers, tool, run, prelaunch } = setup({ deadlineMs: 1_000 })
    const running = run({ trigger: "step-count" })
    const child = await ports.started(1)
    const { worktreeDir } = prelaunch()
    await runTool(tool(REFLECTION_MEMORY_TOOL_NAME), createInput, toolContext(child.sessionID))
    await flush()

    // when
    timers.fire(1_000)
    const report = await running

    // then
    expect(report.status === "finished" ? report.runs[0] : undefined).toMatchObject({
      outcome: "timed_out",
      reason: "deadline_exceeded",
      cleanedUp: true,
    })
    expect(child.aborts).toBe(1)
    expect(existsSync(join(bound.paths.repo, "reference", "tabs.md"))).toBe(false)
    expect(existsSync(worktreeDir)).toBe(false)
    expect((await reflectionStore(bound).readState()).active).toBeUndefined()
    expect((await reflectionStore(bound).readPark()).lastFailure).toMatchObject({ reason: "deadline_exceeded" })
  })

  test("#given a run already holding the reservation #when another run is requested #then it is queued as pending and nothing launches", async () => {
    // given
    const { bound, ports, run } = setup()
    await reflectionStore(bound, { createRunId: () => "run-held" }).tryReserve({
      trigger: "manual",
      conversationIds: [],
      snapshots: [],
    })

    // when
    const report = await run()

    // then
    expect(report).toEqual({ status: "pending", runId: "run-a" })
    expect(ports.requests).toHaveLength(0)
  })
  test("#given the reflection category resolves to an available model #when the run launches #then that model is passed to the child port", async () => {
    // given
    const { ports, run } = setup({ model: { kind: "resolved", category: "quick", model: "acme/quick-model" } })
    const running = run()

    // when
    const child = await ports.started(1)
    child.finish()
    await running

    // then
    expect(child.start.model).toMatchObject({ providerID: "acme", id: "quick-model" })
  })

  test("#given the reflection category has no usable model #when a run is requested #then no child launches and the run settles failed with category_unavailable like Native", async () => {
    // given
    const { bound, ports, warnings, run } = setup({
      model: { kind: "unavailable", category: "quick", cause: "model_unavailable", missingProviders: ["anthropic"] },
    })

    // when
    const report = await run({ trigger: "step-count" })

    // then
    expect(ports.requests).toHaveLength(0)
    expect(report.status === "finished" ? report.runs[0] : undefined).toMatchObject({
      outcome: "failed",
      reason: "category_unavailable",
      cleanedUp: true,
    })
    expect(warnings).toContain("memory reflection not launched: no usable model for the reflection category")
    const store = reflectionStore(bound)
    expect((await store.readState()).active).toBeUndefined()
    expect((await store.readPark()).lastFailure).toMatchObject({
      reason: "category_unavailable",
      detail:
        'Reflection category "quick" could not resolve a usable model (cause: model_unavailable); missing providers: anthropic',
    })
  })
})
