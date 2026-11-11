import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { join } from "node:path"
import { createScriptedFactsPorts } from "./facts.test-support"
import { createManualTimers, flush } from "./kibitzer/test-support"
import { REFLECTION_AGENT_ID, REFLECTION_PERMISSIONS } from "./reflection-agent"
import { createReflectionChildHosting, reflectionChildJournalPath, type ReflectionChildLaunch } from "./reflection-child"
import { REFLECTION_FOREIGN_SESSION_MESSAGE, REFLECTION_MEMORY_TOOL_NAME, REFLECTION_TOOL_NAMES } from "./reflection-tools"
import { createReflectionFixture, refusal, runTool, toolContext, type ReflectionFixture } from "./reflection.test-support"

setDefaultTimeout(process.platform === "win32" ? 30_000 : 10_000)

const fixtures: ReflectionFixture[] = []
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup() })

async function setup() {
  const fixture = await createReflectionFixture()
  fixtures.push(fixture)
  // The reflection port request carries the same fields as the facts one, so the facts doubles serve it.
  const ports = createScriptedFactsPorts()
  const timers = createManualTimers()
  const warnings: string[] = []
  const hosting = createReflectionChildHosting({ host: { session: {} }, createPort: request => ports.createPort(request), timers, warn: message => { warnings.push(message) } })
  const launch = (extra: Partial<ReflectionChildLaunch> = {}) => hosting.launch(fixture.bound, {
    runId: "run-1", parentSessionId: "ses_root", worktreeDir: fixture.worktree.dir, transcriptPath: fixture.transcriptPath,
    request: { trigger: "manual", focus: "indentation" }, deadlineMs: 60_000, ...extra,
  })
  return { fixture, ports, timers, warnings, hosting, launch }
}

const createInput = { command: "create", reason: "feat(reflection): tabs", file_path: "reference/tabs.md", description: "Indentation preference", file_text: "Tabs.\n" }

describe("reflection child launcher", () => {
  test("#given a prepared run #when the child is launched #then the hidden agent is staged with the four tools, the task prompt and the identity journal", async () => {
    // given
    const { fixture, ports, launch } = await setup()

    // when
    const running = launch({ model: "test/model" })
    const child = await ports.started(1)
    child.finish()
    const result = await running

    // then
    const request = ports.requests[0]
    expect(request?.agent).toBe(REFLECTION_AGENT_ID)
    expect(request?.permissions).toEqual(REFLECTION_PERMISSIONS.map(rule => ({ ...rule })))
    expect(request?.toolNames).toEqual([...REFLECTION_TOOL_NAMES])
    expect(request?.journalPath).toBe(join(fixture.bound.paths.reflection, "children.sqlite"))
    expect(request?.journalPath).toBe(reflectionChildJournalPath(fixture.bound))
    expect(child.start.prompt).toContain("Trigger: manual")
    expect(child.start.model).toEqual({ providerID: "test", id: "model" })
    expect(result.status).toBe("completed")
    expect(child.disposed).toBe(true)
  })

  test("#given a live child #when it and another session call the tools #then only the child reaches its run, and its commits are reported", async () => {
    // given
    const { hosting, ports, launch } = await setup()
    const memory = hosting.tools().find(tool => tool.name === REFLECTION_MEMORY_TOOL_NAME)
    if (memory === undefined) throw new Error("reflection_memory missing")
    const running = launch()
    const child = await ports.started(1)

    // when
    const foreign = await refusal(runTool(memory, createInput, toolContext("ses_root")))
    const edited = await runTool(memory, createInput, toolContext(child.sessionID))
    child.finish()
    const result = await running
    const afterRun = await refusal(runTool(memory, { ...createInput, file_path: "reference/late.md" }, toolContext(child.sessionID)))

    // then
    expect(foreign).toBe(`${REFLECTION_MEMORY_TOOL_NAME}: ${REFLECTION_FOREIGN_SESSION_MESSAGE}`)
    expect(result.commits).toHaveLength(1)
    expect(edited.metadata).toMatchObject({ commit: result.commits[0] })
    expect(afterRun).toBe(`${REFLECTION_MEMORY_TOOL_NAME}: ${REFLECTION_FOREIGN_SESSION_MESSAGE}`)
    expect(hosting.isReflectionSession(child.sessionID)).toBe(false)
  })

  test("#given model requests #when the context hook runs #then the child sees only its four tools and other sessions never see them", async () => {
    // given
    const { hosting, ports, launch } = await setup()
    const running = launch()
    const child = await ports.started(1)
    const all = () => Object.fromEntries(["bash", "read", ...REFLECTION_TOOL_NAMES].map(name => [name, {}]))
    const childRequest = { sessionID: child.sessionID, tools: all() }
    const rootRequest = { sessionID: "ses_root", tools: all() }

    // when
    const childOwned = hosting.onContext(childRequest)
    const rootOwned = hosting.onContext(rootRequest)
    child.finish()
    await running

    // then
    expect(childOwned).toBe(true)
    expect(Object.keys(childRequest.tools).toSorted()).toEqual([...REFLECTION_TOOL_NAMES].toSorted())
    expect(rootOwned).toBe(false)
    expect(Object.keys(rootRequest.tools)).toEqual(["bash", "read"])
  })

  test("#given a child that never settles #when the deadline fires #then it is aborted, disposed and reported as deadline", async () => {
    // given
    const { ports, timers, launch } = await setup()
    const running = launch({ deadlineMs: 1_000 })
    const child = await ports.started(1)
    await flush()

    // when
    timers.fire(1_000)
    const result = await running

    // then
    expect(result.status).toBe("deadline")
    expect(child.aborts).toBe(1)
    expect(child.disposed).toBe(true)
  })

  test("#given a running child #when the parent cancels #then the port closes and the run reports cancelled", async () => {
    // given
    const { ports, launch } = await setup()
    let cancel: () => void = () => undefined
    const running = launch({ onCancel: registered => { cancel = registered } })
    const child = await ports.started(1)

    // when
    cancel()
    const result = await running

    // then
    expect(result).toEqual({ status: "cancelled", commits: [] })
    expect(child.disposed).toBe(true)
  })

  test("#given a closed hosting #when a launch is requested #then nothing is started", async () => {
    // given
    const { hosting, ports, launch } = await setup()
    hosting.close()

    // when
    const result = await launch()

    // then
    expect(result).toEqual({ status: "cancelled", commits: [] })
    expect(ports.requests).toHaveLength(0)
  })
})
