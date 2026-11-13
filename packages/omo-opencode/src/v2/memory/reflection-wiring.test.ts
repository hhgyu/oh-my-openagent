import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { buildIdentityPaths } from "@oh-my-opencode/memory-core"
import { OmoConfigSchema, OmoMemorySettingsSchema } from "@oh-my-opencode/omo-config-core"
import type { BoundMemorySession } from "./binding"
import { reflectionStore } from "./reflection-run-store"
import { catalogModel, conversation, createScriptedFactsPorts, until } from "./facts.test-support"
import { MEMORY_BINDING_KEY, registerMemoryComponent } from "./index"
import type { FactsPortRequest } from "./facts-child"
import type { ReflectionPortRequest } from "./reflection-child"
import type { MemoryReflectionSeams } from "./reflection-component"
import { createMemoryFixture } from "./test-support"
import { FACTS_RECORD_TOOL_NAME } from "./facts-record-tool"
import { createCountingSlot, createManualTimers, createScriptedPort, type ScriptedPort } from "./kibitzer/test-support"
import { REFLECTION_TOOL_NAMES } from "./reflection-tools"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const fixtures: ReturnType<typeof createMemoryFixture>[] = []
afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup()
})

function setup(seams: Partial<MemoryReflectionSeams> = {}) {
  const f = createMemoryFixture({ reflection: { trigger: { step_count: 1, on_compaction: true } } })
  fixtures.push(f)
  const ports = createScriptedFactsPorts()
  let runs = 0
  // The scripted doubles only read the shared child-port request fields (scopes, tool names, retire hooks).
  const createPort = (request: ReflectionPortRequest) => ports.createPort(request as unknown as FactsPortRequest)
  const options = f.options({ reflection: { createPort, createRunId: () => `run-${++runs}`, ...seams } })
  return { f, ports, options }
}

describe("memory reflection wiring", () => {
  test.each([
    "request",
    "session.compaction.ended",
    "session.compaction.failed",
    "session.execution.interrupted",
  ] as const)(
    "#given held Kibitzer nudges and step-eligible reflection #when %s occurs #then only acceptance drops nudges and chooses a compaction reservation",
    async (outcome) => {
      // given
      const { f, ports, options } = setup()
      f.addSession("root", { messages: conversation("coffee preference", "noted") })
      const judges: ScriptedPort[] = []
      let delivered: (() => void) | undefined
      const wake = new Promise<void>((resolve) => {
        delivered = resolve
      })
      const cleanup = await registerMemoryComponent(f.host, {
        ...options,
        kibitzer: {
          createPort: (request) => {
            const port = createScriptedPort(request)
            judges.push(port)
            return port
          },
          createWakeSlot: () => createCountingSlot(),
          timers: createManualTimers(),
          onWake: () => delivered?.(),
        },
      })
      try {
        await f.runTool("memory", "root", {
          command: "create",
          reason: "coffee",
          file_path: "reference/coffee.md",
          description: "Coffee preference is oat milk flat white",
          file_text: "The usual coffee is an oat milk flat white.",
        })
        await f.prompt("root", "coffee preference")
        await until(() => judges.length === 1)
        const judge = judges[0]
        if (judge === undefined) throw new Error("no Kibitzer port was created")
        const child = await judge.started(1)
        await new Promise<void>((resolve) => setImmediate(resolve))
        await f.runTool("nudge", child.sessionID, {
          path: "reference/coffee.md",
          hint: "The note records that the usual coffee is an oat milk flat white.",
        })
        child.finish()
        await wake
        const binding = f.sessions.get("root")?.metadata?.[MEMORY_BINDING_KEY] as { identity: string }
        const paths = buildIdentityPaths(f.env.OMO_MEMORY_HOME ?? "", binding.identity)
        const pendingName = readdirSync(paths.recallPending)[0]
        if (pendingName === undefined) throw new Error("no held nudge file was written")
        const pending = join(paths.recallPending, pendingName)
        expect(existsSync(pending)).toBe(true)
        // when
        await f.compaction("root")
        expect(existsSync(pending)).toBe(true)
        if (outcome !== "request") await f.emitEvent(outcome, "root")
        await f.idle("root")
        await until(() => ports.children.length === 1)
        const payload = JSON.parse(
          readFileSync(join(paths.reflection, "runs", "run-1", "transcript-payload.json"), "utf8"),
        ) as { request: { trigger: string } }
        await cleanup()
        // then
        expect(payload.request.trigger).toBe(outcome === "session.compaction.ended" ? "compaction" : "step-count")
        expect(existsSync(pending)).toBe(outcome !== "session.compaction.ended")
        expect(judges).toHaveLength(1)
      } finally {
        await cleanup()
      }
    },
  )

  test("#given a capable reflection host #when the component registers #then /reflect is added beside the core memory commands", async () => {
    // given
    const { f, options } = setup()
    // when
    const cleanup = await registerMemoryComponent(f.host, options)
    // then
    expect(f.commands.get("reflect")?.description).toBe(
      "Request a memory reflection run now, optionally scoped and focused.",
    )
    await cleanup()
  })

  test("#given a root session with user input past the step threshold #when it goes idle #then one reflection child is launched and the idle hook does not wait for it", async () => {
    // given
    const { f, ports, options } = setup()
    f.addSession("root", { messages: conversation("use tabs", "noted, tabs it is") })
    const cleanup = await registerMemoryComponent(f.host, options)
    await f.prompt("root", "use tabs")
    // when
    await f.idle("root")
    await until(() => ports.children.length === 1)
    await f.idle("root")
    await cleanup()
    // then
    expect(ports.children.map((child) => [child.start.prompt.length > 0, child.disposed])).toEqual([[true, true]])
  })

  test("#given a root session without user input this process #when it goes idle #then no reflection child is launched", async () => {
    // given
    const { f, ports, options } = setup()
    f.addSession("root", { messages: conversation("use tabs", "noted, tabs it is") })
    const cleanup = await registerMemoryComponent(f.host, options)
    // when
    await f.idle("root")
    await cleanup()
    // then
    expect(ports.children).toHaveLength(0)
  })
  test("#given a reflection lock whose launcher died after the session bound #when the next turn settles #then the lock is reclaimed and the step-count run launches", async () => {
    // given
    const deadPid = 999_999
    let launcher: "alive" | "dead" = "alive"
    const { f, ports, options } = setup({
      probe: {
        getPidLiveness: (pid) => (pid === deadPid ? launcher : "alive"),
        now: () => Date.now() + 2 * 60_000,
      },
    })
    f.addSession("root", { messages: conversation("use tabs", "noted, tabs it is") })
    const cleanup = await registerMemoryComponent(f.host, options)
    try {
      await f.prompt("root", "use tabs")
      await until(() => f.sessions.get("root")?.metadata?.[MEMORY_BINDING_KEY] !== undefined)
      const binding = f.sessions.get("root")?.metadata?.[MEMORY_BINDING_KEY] as { identity: string }
      const bound: BoundMemorySession = {
        sessionID: "root",
        identity: binding.identity,
        paths: buildIdentityPaths(f.env.OMO_MEMORY_HOME ?? "", binding.identity),
        settings: OmoMemorySettingsSchema.parse({}),
        directory: "",
        metadata: {},
      }
      await reflectionStore(bound, {
        createRunId: () => "run-dead",
        launcherIdentity: async () => ({ pid: deadPid, hostname: hostname(), processStart: null }),
      }).tryReserve({ trigger: "manual", conversationIds: [], snapshots: [] })
      // when
      launcher = "dead"
      await f.idle("root")
      await until(() => ports.children.length === 1)
      // then
      expect(existsSync(join(bound.paths.reflection, "runs", "run-dead", "abandoned.json"))).toBe(true)
      expect(readFileSync(join(bound.paths.reflection, "active.lock"), "utf8")).toContain('"runId": "run-1"')
    } finally {
      await cleanup()
    }
  })

  test("#given memory.reflection.category names a category with an available model #when a reflection launches #then the child runs on that model, not the host default", async () => {
    // given
    const config = OmoConfigSchema.parse({
      memory: { reflection: { category: "writing" } },
      categories: { writing: { model: "acme/writer" } },
    })
    const { f, ports, options } = setup({
      loadConfig: () => config,
      catalog: async () => [catalogModel("acme", "large"), catalogModel("acme", "writer")],
    })
    f.addSession("root", { messages: conversation("use tabs", "noted, tabs it is") })
    const cleanup = await registerMemoryComponent(f.host, options)
    await f.prompt("root", "use tabs")
    // when
    await f.idle("root")
    await until(() => ports.children.length === 1)
    await cleanup()
    // then
    expect(ports.children[0]?.start.model).toMatchObject({ providerID: "acme", id: "writer" })
  })

  test("#given reflection, facts and Kibitzer hostings #when the root and a live reflection child compact #then the root request loses every child-only tool and the child keeps only its own", async () => {
    // given
    const { f, ports, options } = setup()
    const factsPorts = createScriptedFactsPorts()
    f.addSession("root", { messages: conversation("use tabs", "noted, tabs it is") })
    const cleanup = await registerMemoryComponent(f.host, {
      ...options,
      facts: {
        createPort: (request) => factsPorts.createPort(request),
        catalog: async () => [catalogModel("test", "model")],
        loadConfig: () => OmoConfigSchema.parse({}),
      },
      kibitzer: {
        createPort: (request) => createScriptedPort(request),
        createWakeSlot: () => createCountingSlot(),
        timers: createManualTimers(),
      },
    })
    await f.prompt("root", "use tabs")
    await f.idle("root")
    await until(() => ports.children.length === 1)
    const child = ports.children[0]
    if (child === undefined) throw new Error("no reflection child")
    const offered = () =>
      Object.fromEntries(
        ["read", "edit", ...REFLECTION_TOOL_NAMES, FACTS_RECORD_TOOL_NAME, "session_entries", "nudge"].map((name) => [
          name,
          { description: name, input: {} },
        ]),
      )
    const rootTools = offered()
    const childTools = offered()
    // when
    await f.compaction("root", [], rootTools)
    await f.compaction(child.sessionID, [], childTools)
    await cleanup()
    // then
    expect(Object.keys(rootTools).sort()).toEqual(["edit", "read"])
    expect(Object.keys(childTools).sort()).toEqual([...REFLECTION_TOOL_NAMES].sort())
  })
})
