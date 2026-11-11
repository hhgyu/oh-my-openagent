import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { FactsFailureStore, FactsQueue, GitMemoryRepo, resolveAutoIdentity, type MemoryIdentityPaths } from "@oh-my-opencode/memory-core"
import { OmoConfigSchema, OmoMemorySettingsSchema } from "@oh-my-opencode/omo-config-core"
import { FACTS_AGENT_ID, FACTS_PERMISSIONS } from "./facts-agent"
import { retireFactsOwner } from "./facts-owners"
import { FACTS_RECORD_TOOL_NAME } from "./facts-record-tool"
import { catalogModel, conversation, createScriptedFactsPorts, filesContaining, until } from "./facts.test-support"
import { registerMemoryComponent } from "./index"
import { createManualTimers } from "./kibitzer/test-support"
import { createMemoryFixture, type MemoryFixture } from "./test-support"

const fixtures: MemoryFixture[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => undefined)
  for (const created of fixtures.splice(0)) created.cleanup()
})

function fixture(settings: Record<string, unknown> = { facts: { debounce_settles: 1 } }) {
  const created = createMemoryFixture(settings)
  fixtures.push(created)
  return created
}

async function register(f: MemoryFixture, ports = createScriptedFactsPorts(), extra: { timers?: ReturnType<typeof createManualTimers> } = {}) {
  const cleanup = await registerMemoryComponent(f.host, f.options({
    // The config is explicit: the run's shared hermetic HOME may hold a user layer another test wrote.
    facts: { createPort: request => ports.createPort(request), catalog: async () => [catalogModel("test", "model")], loadConfig: () => OmoConfigSchema.parse({}), ...(extra.timers === undefined ? {} : { timers: extra.timers }) },
  }))
  cleanups.push(cleanup)
  return { ports, cleanup }
}

function identityPaths(f: MemoryFixture, settings: Record<string, unknown> = {}): MemoryIdentityPaths {
  return resolveAutoIdentity(f.project, { ...f.env }, OmoMemorySettingsSchema.parse(settings).auto_identity).paths
}

async function settle(f: MemoryFixture, sessionID: string, user = "I always use tabs in this project", suffix = "1"): Promise<void> {
  const session = f.sessions.get(sessionID)
  if (session !== undefined) session.messages = [...(session.messages ?? []), ...conversation(user, "Noted, tabs it is.", suffix)]
  await f.prompt(sessionID, user)
  await f.idle(sessionID)
}

function runDirs(paths: MemoryIdentityPaths): string[] {
  const runs = join(paths.facts, "runs")
  return existsSync(runs) ? readdirSync(runs).filter(name => name.startsWith("facts-")).map(name => join(runs, name)) : []
}

async function factsCommits(paths: MemoryIdentityPaths): Promise<number> {
  if (!existsSync(join(paths.repo, ".git"))) return 0
  return (await new GitMemoryRepo({ dir: paths.repo, agentId: "test" }).log({ grep: ["Omo-Facts-Batch"] })).length
}

describe("facts enqueue and debounce", () => {
  test("#given a bound root session #when it settles without and then with real user input #then only the settle after input enqueues", async () => {
    // given
    const f = fixture({ facts: { debounce_settles: 10 } })
    f.addSession("root", { messages: conversation("I prefer tabs", "Noted.") })
    await register(f)
    const queue = new FactsQueue({ identityPaths: identityPaths(f) })
    // when
    await f.idle("root")
    const before = await queue.listPending()
    await settle(f, "root", "I prefer tabs", "2")
    // then
    expect(before).toHaveLength(0)
    expect(await queue.listPending()).toHaveLength(1)
  })

  test("#given debounce_settles 3 #when one session settles twice and then a third time #then the bursts coalesce into one launch", async () => {
    // given
    const f = fixture({ facts: { debounce_settles: 3 } })
    f.addSession("root")
    const { ports } = await register(f)
    // when
    await settle(f, "root", "first fact", "1")
    await settle(f, "root", "second fact", "2")
    const afterTwo = ports.requests.length
    await settle(f, "root", "third fact", "3")
    await ports.started(1)
    // then
    expect(afterTwo).toBe(0)
    expect(ports.requests).toHaveLength(1)
  })
})

describe("facts extractor child", () => {
  test("#given a launch #then the child is staged as the hidden facts agent with exactly the record_fact tool, the resolved model and the payload prompt", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    const { ports } = await register(f)
    // when
    await settle(f, "root")
    const child = await ports.started(1)
    // then
    expect(child.request.agent).toBe(FACTS_AGENT_ID)
    expect(child.request.toolNames).toEqual([FACTS_RECORD_TOOL_NAME])
    expect(child.request.permissions).toEqual(FACTS_PERMISSIONS.map(rule => ({ ...rule })))
    expect(child.request.parentSessionId).toBe("root")
    expect(child.start.model).toMatchObject({ providerID: "test", id: "model" })
    expect(child.start.prompt).toContain("I always use tabs in this project")
    const childTools = { read: { description: "", input: {} }, [FACTS_RECORD_TOOL_NAME]: { description: "", input: {} } }
    await f.context(child.sessionID, [], { tools: childTools })
    expect(Object.keys(childTools)).toEqual([FACTS_RECORD_TOOL_NAME])
    const rootTools = { read: { description: "", input: {} }, [FACTS_RECORD_TOOL_NAME]: { description: "", input: {} } }
    await f.context("root", [], { tools: rootTools })
    expect(Object.keys(rootTools)).toEqual(["read"])
    await expect(f.runTool(FACTS_RECORD_TOOL_NAME, "root", { scope: "project", text: "x", date: "2026-11-11" })).rejects.toThrow("live facts extractor session")
    child.finish()
  })

  test("#given a live facts child #when the root and the child compact #then the root request loses record_fact and the child keeps only it", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    const { ports } = await register(f)
    await settle(f, "root")
    const child = await ports.started(1)
    const childTools = { read: { description: "", input: {} }, [FACTS_RECORD_TOOL_NAME]: { description: "", input: {} } }
    const rootTools = { read: { description: "", input: {} }, [FACTS_RECORD_TOOL_NAME]: { description: "", input: {} } }
    // when
    await f.compaction(child.sessionID, [], childTools)
    await f.compaction("root", [], rootTools)
    // then
    expect(Object.keys(childTools)).toEqual([FACTS_RECORD_TOOL_NAME])
    expect(Object.keys(rootTools)).toEqual(["read"])
    child.finish()
  })

  test("#given the child records a fact and settles #then the parent applies it to the memory repo and consumes the batch", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    const { ports } = await register(f)
    await settle(f, "root")
    const child = await ports.started(1)
    const paths = child.request.bound.paths
    // when
    const recorded = await f.runTool(FACTS_RECORD_TOOL_NAME, child.sessionID, { scope: "project", text: "The project indents with tabs", date: "2026-11-11" })
    child.finish()
    await until(() => runDirs(paths).some(dir => existsSync(join(dir, "final.json"))))
    // then
    expect(recorded.content).toBe("Fact recorded (1).")
    expect(await factsCommits(paths)).toBe(1)
    expect(filesContaining(paths.repo, "The project indents with tabs").length).toBeGreaterThan(0)
    expect(await new FactsQueue({ identityPaths: paths }).listPending()).toHaveLength(0)
    expect(existsSync(join(runDirs(paths)[0] ?? "", "extraction.jsonl"))).toBe(false)
  })

  test("#given the child turn fails #then nothing is applied, the batch stays queued and its endpoint backs off", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    const { ports } = await register(f)
    await settle(f, "root")
    const child = await ports.started(1)
    const paths = child.request.bound.paths
    await f.runTool(FACTS_RECORD_TOOL_NAME, child.sessionID, { scope: "project", text: "Never applied", date: "2026-11-11" })
    // when
    child.finish({ status: "error", message: "provider 503" })
    await until(() => runDirs(paths).some(dir => existsSync(join(dir, "final.json"))))
    // then
    expect(await factsCommits(paths)).toBe(0)
    expect(await new FactsQueue({ identityPaths: paths }).listPending()).toHaveLength(1)
    const failures = await new FactsFailureStore({ identityPaths: paths }).readFailures()
    expect(failures.entries.map(entry => [entry.state, entry.lastReason])).toEqual([["backoff", "child_exit"]])
  })

  test("#given the child never settles #when the deadline fires #then the turn is interrupted, nothing is applied and the endpoint backs off", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    const timers = createManualTimers()
    const { ports } = await register(f, createScriptedFactsPorts(), { timers })
    await settle(f, "root")
    const child = await ports.started(1)
    const paths = child.request.bound.paths
    await until(() => timers.pending() > 0)
    // when
    timers.fire()
    await until(() => runDirs(paths).some(dir => existsSync(join(dir, "final.json"))))
    // then
    expect(child.aborts).toBe(1)
    expect(child.disposed).toBe(true)
    expect(await factsCommits(paths)).toBe(0)
    const failures = await new FactsFailureStore({ identityPaths: paths }).readFailures()
    expect(failures.entries.map(entry => entry.lastReason)).toEqual(["deadline_exceeded"])
  })
})

describe("facts reload recovery", () => {
  async function strandedRun(f: MemoryFixture) {
    const first = await register(f)
    await settle(f, "root")
    const child = await first.ports.started(1)
    await f.runTool(FACTS_RECORD_TOOL_NAME, child.sessionID, { scope: "project", text: "Recovered after reload", date: "2026-11-11" })
    const paths = child.request.bound.paths
    const [runDir] = runDirs(paths)
    if (runDir === undefined) throw new Error("no run dir")
    const ledger = JSON.parse(await Bun.file(join(runDir, "ledger.json")).text()) as { owner: string }
    // The launching instance is gone without cleanup: its owner token is no longer live.
    retireFactsOwner(ledger.owner)
    return { paths, runDir }
  }

  test("#given a run whose child settled before a crash #when the session binds again #then the next instance applies the pending run", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    const { paths, runDir } = await strandedRun(f)
    writeFileSync(join(runDir, "outcome.json"), JSON.stringify({ version: 1, runId: "x", status: "completed", finishedAt: new Date().toISOString() }))
    // when
    await register(f)
    await f.idle("root")
    await until(() => existsSync(join(runDir, "final.json")))
    // then
    expect(await factsCommits(paths)).toBe(1)
    expect(filesContaining(paths.repo, "Recovered after reload").length).toBeGreaterThan(0)
    expect(await new FactsQueue({ identityPaths: paths }).listPending()).toHaveLength(0)
  })

  test("#given a run whose child never settled before a crash #when the session binds again #then the run is abandoned with a backoff and its batch stays queued", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    const { paths, runDir } = await strandedRun(f)
    // when
    await register(f)
    await f.idle("root")
    await until(() => existsSync(join(runDir, "abandoned.json")))
    // then
    expect(await factsCommits(paths)).toBe(0)
    expect(await new FactsQueue({ identityPaths: paths }).listPending()).toHaveLength(1)
    const failures = await new FactsFailureStore({ identityPaths: paths }).readFailures()
    expect(failures.entries.map(entry => entry.lastReason)).toEqual(["unknown_liveness"])
  })
})

describe("facts skips", () => {
  test("#given a subagent child session and a facts child session #when they settle after input #then nothing is enqueued", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    f.addSession("child", { parentID: "root", messages: conversation("child prompt", "child answer") })
    const { ports } = await register(f)
    await settle(f, "root")
    const factsChild = await ports.started(1)
    const queue = new FactsQueue({ identityPaths: factsChild.request.bound.paths })
    // when
    await f.prompt("child", "child prompt")
    await f.idle("child")
    await f.prompt(factsChild.sessionID, "extract")
    await f.idle(factsChild.sessionID)
    // then
    expect((await queue.listPending()).map(entry => entry.conversationId)).toEqual(["root"])
    expect(ports.requests).toHaveLength(1)
    factsChild.finish()
  })

  test("#given memory.facts.enabled false #when a root session settles after input #then nothing is enqueued and no child is staged", async () => {
    // given
    const f = fixture({ facts: { enabled: false, debounce_settles: 1 } })
    f.addSession("root")
    const { ports } = await register(f)
    // when
    await settle(f, "root")
    // then
    expect(await new FactsQueue({ identityPaths: identityPaths(f) }).listPending()).toHaveLength(0)
    expect(ports.requests).toHaveLength(0)
  })
})

describe("facts and agreements commands", () => {
  test("#given a bound root session #when /facts and /agreements run #then each output is shown through the omo-memory event", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    await register(f)
    await f.runCommand("memfs", "root", "init")
    // when
    await f.runCommand("facts", "root")
    await f.runCommand("agreements", "root")
    // then
    const outputs = f.events.slice(1).map(event => event.data as { command: string; level: string; text: string })
    expect(outputs.map(output => [output.command, output.level])).toEqual([["facts", "info"], ["agreements", "info"]])
    expect(outputs[0]?.text).toContain("queued: 0 pending")
    expect(outputs[1]?.text).toContain("no agreements yet")
  })
})
