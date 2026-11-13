import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { GitMemoryRepo, initMemoryWithSeeds, type ReflectionRequest } from "@oh-my-opencode/memory-core"
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
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function setup(compileWarnTokens = 30_000) {
  const identity = createBoundIdentity()
  cleanups.push(identity.cleanup)
  const bound: BoundMemorySession = {
    ...identity.bound,
    settings: OmoMemorySettingsSchema.parse({ compile_warn_tokens: compileWarnTokens }),
  }
  const ports = createScriptedFactsPorts()
  const hosting = createReflectionChildHosting({
    host: { session: {} },
    createPort: (request) => ports.createPort(request),
    timers: createManualTimers(),
    warn: () => undefined,
  })
  const runner = createReflectionRunner({ launch: hosting.launch, warn: () => undefined, createRunId: () => "dream-a" })
  const edit = hosting.tools().find((entry) => entry.name === REFLECTION_MEMORY_TOOL_NAME)
  if (edit === undefined) throw new Error("reflection_memory missing")
  const run = (request: Partial<ReflectionRequest>) =>
    runner.runReflection(bound, {
      parentSessionId: bound.sessionID,
      request: { trigger: "dream", origin: "manual", conversationIds: [], snapshots: [], ...request },
    })
  const create = (sessionID: string, path: string) =>
    runTool(
      edit,
      {
        command: "create",
        reason: "chore(dream): note",
        file_path: path,
        description: "A note",
        file_text: "Note.\n",
      },
      toolContext(sessionID),
    )
  const final = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(reflectionRunDir(bound, "dream-a"), "final.json"), "utf8"))
  const change = (sessionID: string, input: Record<string, unknown>) => runTool(edit, input, toolContext(sessionID))
  return { bound, ports, run, create, change, final }
}

const note = (description: string, body: string): string => `---\ndescription: ${description}\n---\n\n${body}`

async function seedNotes(bound: BoundMemorySession, files: Record<string, string | Uint8Array>): Promise<void> {
  const repo = new GitMemoryRepo({ dir: bound.paths.repo, agentId: bound.identity })
  await initMemoryWithSeeds(repo, { authorName: bound.identity })
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(bound.paths.repo, path)), { recursive: true })
    writeFileSync(join(bound.paths.repo, path), content)
  }
  execFileSync("git", ["add", "-A"], { cwd: bound.paths.repo })
  execFileSync(
    "git",
    ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "commit", "-q", "--no-verify", "-m", "seed"],
    { cwd: bound.paths.repo },
  )
}

const outcomeOf = (report: Awaited<ReturnType<ReturnType<typeof setup>["run"]>>) =>
  report.status === "finished" ? report.runs[0] : undefined

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
    expect(report.status === "finished" ? report.runs[0] : undefined).toMatchObject({
      outcome: "failed",
      reason: "invalid_target",
    })
    expect(existsSync(join(bound.paths.repo, "reference", "other.md"))).toBe(false)
  })

  test("#given a targeted dream whose target another note links #when the child deletes the target #then it merges with the gate's link repair instead of failing invalid_target", async () => {
    // given
    const { bound, ports, run, change } = setup()
    await seedNotes(bound, {
      "reference/target.md": note("Target", "t\n"),
      "reference/user.md": note("User", "See [[reference/target.md|the target]].\n"),
    })
    const running = run({ targetDoc: "reference/target.md" })
    const child = await ports.started(1)
    // when
    await change(child.sessionID, {
      command: "delete",
      reason: "chore(dream): retire the target",
      file_path: "reference/target.md",
    })
    child.finish()
    const report = await running
    // then
    expect(outcomeOf(report)?.outcome).toBe("merged")
    expect(existsSync(join(bound.paths.repo, "reference", "target.md"))).toBe(false)
    expect(readFileSync(join(bound.paths.repo, "reference", "user.md"), "utf8")).toContain("See the target.\n")
  })

  test("#given a targeted dream #when the child forges the link-repair commit on another note #then the repair is recomputed, not trusted, and the run fails invalid_target", async () => {
    // given
    const { bound, ports, run, change } = setup()
    await seedNotes(bound, {
      "reference/target.md": note("Target", "t\n"),
      "reference/other.md": note("Other", "o\n"),
    })
    const running = run({ targetDoc: "reference/target.md" })
    const child = await ports.started(1)
    // when
    await change(child.sessionID, {
      command: "str_replace",
      reason: "chore(dream): maintain the target",
      file_path: "reference/target.md",
      old_string: "t\n",
      new_string: "t2\n",
    })
    await change(child.sessionID, {
      command: "str_replace",
      reason: "chore(memory): repoint links to removed notes\n\nOmo-Link-Repair: 1",
      file_path: "reference/other.md",
      old_string: "o\n",
      new_string: "rewritten\n",
    })
    child.finish()
    const report = await running
    // then
    expect(outcomeOf(report)).toMatchObject({ outcome: "failed", reason: "invalid_target" })
    expect(readFileSync(join(bound.paths.repo, "reference", "other.md"), "utf8")).toContain("o\n")
  })

  test("#given notes linking a note the dream archives #when the run merges #then UTF-8 links point at ARCHIVE.md and a non-UTF-8 note stays byte-identical", async () => {
    // given
    const { bound, ports, run, change } = setup()
    const latin1 = Buffer.concat([
      Buffer.from(note("Latin", "caf"), "utf8"),
      Buffer.from([0xe9]),
      Buffer.from(" [[reference/old.md]]\n", "utf8"),
    ])
    await seedNotes(bound, {
      "ARCHIVE.md": note("Archive", "Archived notes:\n"),
      "reference/old.md": note("Old", "old\n"),
      "reference/user.md": note("User", "See [[reference/old.md|old notes]].\n"),
      "reference/latin1.md": latin1,
    })
    const running = run({})
    const child = await ports.started(1)
    // when
    await change(child.sessionID, {
      command: "str_replace",
      reason: "chore(dream): archive the old note",
      file_path: "ARCHIVE.md",
      old_string: "Archived notes:\n",
      new_string: "Archived notes:\n- reference/old.md\n",
    })
    await change(child.sessionID, {
      command: "delete",
      reason: "chore(dream): archive the old note",
      file_path: "reference/old.md",
    })
    child.finish()
    const report = await running
    // then
    expect(outcomeOf(report)?.outcome).toBe("merged")
    expect(readFileSync(join(bound.paths.repo, "reference", "user.md"), "utf8")).toContain(
      "See [[ARCHIVE.md|old notes (archived)]].\n",
    )
    expect(readFileSync(join(bound.paths.repo, "reference", "latin1.md")).equals(latin1)).toBe(true)
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
