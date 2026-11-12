import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { FactsFailureStore, FactsFailuresCorruptError, FactsQueue, GitMemoryRepo, LockContentionError, resolveAutoIdentity, type MemoryIdentityPaths } from "@oh-my-opencode/memory-core"
import { OmoConfigSchema, OmoMemorySettingsSchema } from "@oh-my-opencode/omo-config-core"
import { FACTS_AGENT_ID, FACTS_PERMISSIONS } from "./facts-agent"
import { retireFactsOwner } from "./facts-owners"
import { FACTS_RECORD_TOOL_NAME } from "./facts-record-tool"
import { catalogModel, conversation, createScriptedFactsPorts, filesContaining, until } from "./facts.test-support"
import { registerMemoryComponent } from "./index"
import { createManualTimers } from "./kibitzer/test-support"
import { createMemoryFixture, type MemoryFixture } from "./test-support"
import { createFactsRunner } from "./facts-runner"

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
  test("#given a deleted bound session #when shutdown drains surviving sessions #then its durable queue remains but its final context is not read", async () => {
    const f = fixture({ facts: { debounce_settles: 10 } })
    f.addSession("deleted")
    f.addSession("survivor")
    const { cleanup } = await register(f)
    await settle(f, "deleted")
    await f.prompt("survivor", "last surviving turn")
    await f.context("survivor")
    const survivor = f.sessions.get("survivor")
    if (survivor !== undefined) survivor.messages = conversation("last surviving turn", "Noted.")
    await f.emitEvent("session.deleted", "deleted")
    f.sessions.delete("deleted")
    const read = spyOn(f.host.session, "context")
    try {
      await cleanup()
      expect(read.mock.calls.map(([input]) => input.sessionID)).not.toContain("deleted")
      const pending = await new FactsQueue({ identityPaths: identityPaths(f) }).listPending()
      expect(pending.map(entry => entry.sessionId).sort()).toEqual(["deleted", "survivor"])
    } finally { read.mockRestore() }
  })

  test("#given a prior binding is being resumed #when deletion overtakes its host read #then the late binding cannot restore facts shutdown bookkeeping", async () => {
    const f = fixture({ facts: { debounce_settles: 10 } })
    f.addSession("deleted")
    const first = await register(f)
    await f.prompt("deleted", "persist the binding")
    await first.cleanup()
    const next = await register(f)
    const entered = Promise.withResolvers<undefined>()
    const held = Promise.withResolvers<undefined>()
    const original = f.host.session.get.bind(f.host.session)
    const get = spyOn(f.host.session, "get").mockImplementation(async input => {
      const captured = await original(input)
      entered.resolve(undefined)
      await held.promise
      return captured
    })
    const read = spyOn(f.host.session, "context")
    try {
      const pending = f.context("deleted")
      await entered.promise
      await f.emitEvent("session.deleted", "deleted")
      f.sessions.delete("deleted")
      held.resolve(undefined)
      await pending
      read.mockClear()
      await next.cleanup()
      expect(read.mock.calls.map(([input]) => input.sessionID)).not.toContain("deleted")
    } finally { held.resolve(undefined); get.mockRestore(); read.mockRestore() }
  })

  test("#given a settle awaiting its session model #when the session is deleted #then the late settle cannot launch an extractor", async () => {
    const f = fixture()
    f.addSession("deleted", { messages: conversation("queued fact", "Noted.") })
    const { ports } = await register(f)
    await f.prompt("deleted", "queued fact")
    await f.context("deleted")
    const entered = Promise.withResolvers<undefined>()
    const held = Promise.withResolvers<undefined>()
    const original = f.host.session.context.bind(f.host.session)
    let calls = 0
    const read = spyOn(f.host.session, "context").mockImplementation(async input => {
      if (++calls === 2) { entered.resolve(undefined); await held.promise }
      return original(input)
    })
    try {
      const pending = f.idle("deleted")
      await entered.promise
      await f.emitEvent("session.deleted", "deleted")
      held.resolve(undefined)
      await pending
      expect(await new FactsQueue({ identityPaths: identityPaths(f) }).listPending()).toHaveLength(0)
      expect(ports.requests).toHaveLength(0)
    } finally { held.resolve(undefined); read.mockRestore() }
  })

  test.each(["close", "location.shutdown"] as const)("#given final turns without idle #when %s runs #then every bound root is queued once without extraction", async edge => {
    // given
    const f = fixture({ facts: { debounce_settles: 10 } })
    f.addSession("root")
    f.addSession("other")
    f.addSession("child", { parentID: "root" })
    const { ports, cleanup } = await register(f)
    for (const id of ["root", "other", "child"]) {
      await f.context(id)
      await f.idle(id)
      await f.prompt(id, `Final preference ${id}`)
      const session = f.sessions.get(id)
      if (session !== undefined) session.messages = conversation(`Final preference ${id}`, "Noted.", id)
    }
    const queue = new FactsQueue({ identityPaths: identityPaths(f) })
    expect(await queue.listPending()).toHaveLength(0)
    // when
    if (edge === "location.shutdown") {
      await f.emitEvent(edge, "root")
      await until(async () => (await queue.listPending()).length === 2)
    }
    await cleanup()
    await cleanup()
    // then
    const pending = await queue.listPending()
    expect(pending.map(entry => entry.sessionId).sort()).toEqual(["other", "root"])
    expect(pending.flatMap(entry => entry.entries.flatMap(row => row.kind === "user" ? [row.text] : [])).sort()).toEqual(["Final preference other", "Final preference root"])
    expect(ports.requests).toHaveLength(0)
    // A rebind reconciles locally; the next accepted turn's settle launches the retained batches.
    const next = await register(f)
    await settle(f, "root", "Continue", "next")
    const child = await next.ports.started(1)
    expect(child.start.prompt).toContain("Final preference root")
    expect(child.start.prompt).toContain("Final preference other")
    child.finish()
  })

  test("#given a live extractor and an un-settled final turn #when close runs #then the child is cancelled and the final delta stays queued", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    const { ports, cleanup } = await register(f)
    await settle(f, "root")
    const child = await ports.started(1)
    await f.prompt("root", "Last turn")
    const session = f.sessions.get("root")
    if (session !== undefined) session.messages = [...(session.messages ?? []), ...conversation("Last turn", "Noted.", "last")]
    // when
    await cleanup()
    // then
    expect(child.disposed).toBe(true)
    expect(ports.requests).toHaveLength(1)
    const pending = await new FactsQueue({ identityPaths: identityPaths(f) }).listPending()
    expect(pending.flatMap(entry => entry.entries).some(entry => entry.kind === "user" && entry.text === "Last turn")).toBe(true)
  })

  test("#given a final context read that stalls #when close exhausts its budget #then it warns and the next bind recovers without a late enqueue", async () => {
    // given
    const f = fixture({ facts: { debounce_settles: 10 } })
    f.addSession("root")
    const warnings: string[] = []
    let readAborted: () => void = () => undefined
    const abortedRead = new Promise<void>(resolve => { readAborted = resolve })
    const ports = createScriptedFactsPorts()
    const cleanup = await registerMemoryComponent(f.host, f.options({ logger: { warn: message => {
      warnings.push(message)
      if (message === "memory transcript journal reconcile skipped") readAborted()
    } }, facts: { createPort: request => ports.createPort(request) } }))
    cleanups.push(cleanup)
    await f.context("root")
    await f.idle("root")
    const session = f.sessions.get("root")
    if (session !== undefined) session.messages = conversation("Survives the deadline", "Noted.")
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => { release = resolve })
    const original = f.host.session.context.bind(f.host.session)
    const read = spyOn(f.host.session, "context").mockImplementation(async input => { await held; return original(input) })
    // when
    try { await cleanup() } finally { release(); read.mockRestore() }
    // then
    expect(warnings).toContain("facts shutdown drain hit its budget")
    // Shutdown is bounded, but the test still owns the read it deliberately held past that bound.
    await abortedRead
    const queue = new FactsQueue({ identityPaths: identityPaths(f) })
    expect(await queue.listPending()).toHaveLength(0)
    const next = await register(f)
    await settle(f, "root", "Continue after deadline", "next")
    const recovered = await next.ports.started(1)
    expect((await queue.listPending()).flatMap(entry => entry.entries).some(entry => entry.kind === "user" && entry.text === "Survives the deadline")).toBe(true)
    recovered.finish()
    expect(ports.requests).toHaveLength(0)
  })

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
  test.each([
    [new LockContentionError("facts-queue.lock", null), "facts failure ledger is busy; launch deferred"],
    [new FactsFailuresCorruptError("bad JSON"), "facts failure ledger is unreadable; refusing to launch"],
  ] as const)("#given %s #when launch reads the ledger #then it refuses without consuming and a later attempt can launch", async (error, message) => {
    // given
    const f = fixture()
    const paths = identityPaths(f)
    const warnings: string[] = []
    let launched = 0
    const runner = createFactsRunner({
      identity: "agent", paths, owner: "owner", now: () => new Date(), deadlineMs: 10_000,
      logger: { warn: message => { warnings.push(message) } }, ownerAlive: () => false,
      people: () => ({ enabled: true, maxEntries: 40, maxEntryChars: 200 }),
      resolveModel: async () => ({ kind: "resolved", model: "test/model", fallbacks: [] }),
      launchChild: async () => { launched += 1; return { status: "completed" } },
    })
    await runner.queue.enqueue({ identity: "agent", sessionId: "root", conversationId: "root", entries: [
      { kind: "user", text: "fact", source_message_id: "msg1", source_line_id: "msg1:user", captured_at: new Date().toISOString() },
    ] })
    const before = await runner.queue.listPending()
    const read = spyOn(FactsFailureStore.prototype, "readFailures").mockRejectedValue(error)
    // when / then
    try {
      expect((await runner.launchPending({ parentSessionId: "root" })).status).toBe("skipped")
      expect(warnings).toEqual([message])
      expect(launched).toBe(0)
      expect(runDirs(paths)).toEqual([])
      expect(await runner.queue.listPending()).toEqual(before)
    } finally {
      read.mockRestore()
    }
    expect((await runner.launchPending({ parentSessionId: "root" })).status).toBe("no_facts")
    expect(launched).toBe(1)
    expect(await runner.queue.listPending()).toEqual([])
  })

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
    const { ports, cleanup } = await register(f)
    // when
    await settle(f, "root")
    await cleanup()
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
