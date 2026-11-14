import { afterAll, describe, expect, test } from "bun:test"
import { Error as ToolError, type Info, type ToolContext } from "@opencode/plugin/promise/tool"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ComputerHost, createComputerComponent } from "./component"

const root = mkdtempSync(join(tmpdir(), "omo-v2-computer-component-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function project(name: string, computer: unknown): string {
  const directory = join(root, name)
  mkdirSync(join(directory, ".omo"), { recursive: true })
  writeFileSync(join(directory, ".omo", "omo.json"), JSON.stringify({ computer }))
  return directory
}

function fakeRuntimeModule() {
  const log: string[] = []
  const created: string[] = []
  const module = {
    createComputerSessionRuntime() {
      let enabled = true
      let running = false
      created.push("runtime")
      const tool = (name: string) => ({
        async execute(id: string, input: Record<string, unknown>) {
          running = true
          log.push(`${name}:${id}:${String(input.action)}`)
          return { content: [{ type: "text", text: `${name} done` }], details: { value: { ok: true } } }
        },
      })
      return {
        handle: {
          get enabled() {
            return enabled
          },
          get active() {
            return running
          },
          get running() {
            return running
          },
          setEnabled(value: boolean) {
            enabled = value
          },
          settings: () => ({ showCursor: true }),
          async activate() {
            running = true
            return { stopPath: "armed", suspended: false }
          },
          async deactivate() {
            running = false
          },
          async close() {
            log.push("close")
            running = false
          },
          stopPathStatus: async () => undefined,
          capabilities: async () => undefined,
          stop: async () => undefined,
          resume: async () => undefined,
          setShowCursor: async () => {},
        },
        service: { engineState: "not started", revokeControl: async () => log.push("revoke") },
        tools: { computer: tool("computer"), computer_actions: tool("computer_actions") },
      }
    },
  }
  return { module: module as unknown as typeof import("./runtime"), log, created }
}

function fakeHost(directory: string, sessions: Record<string, { parentID?: string }> = {}) {
  const tools: (Info & { id: string })[] = []
  const commands: { name: string; execute: (input: never) => Promise<void> }[] = []
  const skills: { id: string; name: string; path: string }[] = []
  const asserts: { action: string; resources: readonly string[]; save?: readonly string[] }[] = []
  const emitted: { name: string; payload: Record<string, string> }[] = []
  const hooks = new Map<string, (value: { sessionID: string }) => Promise<void>>()
  const deleted: string[] = []
  let wake: (() => void) | undefined
  let deny: ((resources: readonly string[]) => boolean) | undefined
  const registration = { dispose: async () => {} }
  const host = {
    location: { directory },
    tool: {
      async transform(callback: (editor: unknown) => void) {
        callback({ list: () => tools, add: (tool: Info) => tools.push({ ...tool, id: `tool_${tools.length}` }) })
        return registration
      },
    },
    command: {
      async transform(callback: (editor: unknown) => void) {
        callback({ add: (definition: (typeof commands)[number]) => commands.push(definition) })
        return registration
      },
    },
    skill: {
      async transform(callback: (editor: unknown) => void) {
        callback({ list: () => skills, add: (skill: (typeof skills)[number]) => skills.push(skill) })
        return registration
      },
    },
    rpc: {
      async register() {
        return {
          ...registration,
          events: {
            emit: async (name: string, payload: Record<string, string>) => {
              emitted.push({ name, payload })
            },
          },
        }
      },
    },
    permission: {
      async assert(input: { action: string; resources: readonly string[]; save?: readonly string[] }) {
        asserts.push({ action: input.action, resources: input.resources, ...(input.save && { save: input.save }) })
        if (deny?.(input.resources)) throw new ToolError({ message: `denied ${input.resources.join(",")}` })
      },
    },
    session: {
      async get(input: { sessionID: string }) {
        return { id: input.sessionID, parentID: sessions[input.sessionID]?.parentID, location: { directory } }
      },
      async hook(name: string, callback: (value: { sessionID: string }) => Promise<void>) {
        hooks.set(name, callback)
        return registration
      },
    },
    event: {
      subscribe(options: { signal?: AbortSignal }) {
        return {
          async *[Symbol.asyncIterator]() {
            while (!options.signal?.aborted) {
              const next = deleted.shift()
              if (next) {
                yield { type: "session.deleted", data: { sessionID: next } }
                continue
              }
              await new Promise<void>((resolve) => {
                wake = resolve
                options.signal?.addEventListener("abort", () => resolve(), { once: true })
              })
            }
          },
        }
      },
    },
  }
  return {
    host: host as unknown as ComputerHost,
    tools,
    commands,
    skills,
    asserts,
    emitted,
    hooks,
    denyWhen: (rule: (resources: readonly string[]) => boolean) => {
      deny = rule
    },
    deleteSession: (id: string) => {
      deleted.push(id)
      wake?.()
    },
  }
}

function caller(sessionID = "ses_root", agent = "build"): ToolContext {
  return {
    sessionID,
    agent,
    messageID: "msg_1",
    id: "call_1",
    signal: new AbortController().signal,
    progress: async () => {},
  } as unknown as ToolContext
}

const engine = { env: {}, home: join(root, "no-native-home"), platform: "win32" }

describe("V2 computer use component", () => {
  test("#given computer use on with the CUA adapter #when registered #then the Code Mode tools, /omo:computer, the skill, the eval host tools and the prelude are all present, and the skill and prelude name /omo:computer", async () => {
    // given
    const fake = fakeHost(project("register", { cua_adapter: true }))
    const runtime = fakeRuntimeModule()
    const component = createComputerComponent(fake.host, {
      platform: "win32",
      engine,
      skillRoot: root,
      loadRuntime: async () => runtime.module,
    })

    // when
    const dispose = await component.register()

    // then
    expect(fake.tools.map((tool) => [tool.name, tool.options])).toEqual([
      ["computer", { codemode: true, permission: "computer" }],
      ["computer_actions", { codemode: true, permission: "computer" }],
    ])
    expect(fake.commands.map((command) => command.name)).toEqual(["omo:computer"])
    expect(fake.skills.map((skill) => skill.name)).toEqual(["computer-use"])
    expect(component.ownedTools.map((tool) => tool.name)).toEqual(["computer", "computer_actions"])
    expect(component.kernelPreludes?.catalog.map((entry) => [entry.name, entry.contribution.exports])).toEqual([
      ["computer", ["computer"]],
    ])
    expect(component.kernelPreludes?.active("ses_root")).toEqual(["computer"])
    const skill = fake.skills[0] as { content?: string } | undefined
    const preludeDocs = component.kernelPreludes?.catalog[0]?.contribution.documentation ?? ""
    for (const text of [skill?.content ?? "", preludeDocs]) {
      expect(text).toContain("/omo:computer resume")
      expect(text).not.toMatch(/(^|[\s(`])\/computer\b/)
    }
    expect(runtime.created).toEqual([])
    await dispose()
  })

  test("#given permission rules #when calls of each tier run #then read and exec are asked separately and a denied exec never reaches the desktop", async () => {
    // given
    const fake = fakeHost(project("tiers", {}))
    const runtime = fakeRuntimeModule()
    const component = createComputerComponent(fake.host, {
      platform: "win32",
      engine,
      skillRoot: root,
      loadRuntime: async () => runtime.module,
    })
    const dispose = await component.register()
    const computer = fake.tools.find((tool) => tool.name === "computer")
    if (!computer) throw Error("computer tool missing")
    fake.denyWhen((resources) => resources.includes("exec"))

    // when
    const read = await computer.execute({ action: "capabilities" }, caller())
    const exec = await computer
      .execute({ action: "run", code: "await desktop.click(1, 1)" }, caller())
      .catch((error: unknown) => error)
    const readOnlyRun = await computer.execute({ action: "run", code: "return 1", read_only: true }, caller())

    // then
    expect(fake.asserts).toEqual([
      { action: "computer", resources: ["read"], save: ["read"] },
      { action: "computer", resources: ["exec"], save: ["exec"] },
      { action: "computer", resources: ["read"], save: ["read"] },
    ])
    expect(read.content).toEqual([{ type: "text", text: "computer done" }])
    expect(readOnlyRun.metadata).toEqual({ computer: { value: { ok: true } } })
    expect((exec as Error).message).toBe("denied exec")
    expect(runtime.log).toEqual(["computer:call_1:capabilities", "computer:call_1:run"])
    await dispose()
  })

  test("#given an eval cell #when it calls tools.computer #then only a live eval call may drive the desktop, under the same tier check", async () => {
    // given
    const fake = fakeHost(project("owned", {}))
    const runtime = fakeRuntimeModule()
    const component = createComputerComponent(fake.host, {
      platform: "win32",
      engine,
      skillRoot: root,
      loadRuntime: async () => runtime.module,
    })
    const dispose = await component.register()
    const owned = component.ownedTools[0]
    if (!owned) throw Error("owned tool missing")

    // when
    const detached = await owned
      .execute({ action: "capabilities" }, { sessionID: "ses_root" })
      .catch((error: unknown) => error)
    const live = await owned.execute(
      { action: "call", chain: [{ method: "screenshot" }] },
      { sessionID: "ses_root", caller: caller() },
    )

    // then
    expect((detached as Error).message).toContain("only inside a running eval cell")
    expect(live).toEqual({ content: [{ type: "text", text: "computer done" }], details: { value: { ok: true } } })
    expect(fake.asserts).toEqual([{ action: "computer", resources: ["read"], save: ["read"] }])
    await dispose()
  })

  test("#given a child session or a read-only role #when it calls computer #then the call is refused before any permission prompt", async () => {
    // given
    const fake = fakeHost(project("roles", {}), { ses_child: { parentID: "ses_root" } })
    const component = createComputerComponent(fake.host, {
      platform: "win32",
      engine,
      skillRoot: root,
      loadRuntime: async () => fakeRuntimeModule().module,
    })
    const dispose = await component.register()
    const computer = fake.tools.find((tool) => tool.name === "computer")
    if (!computer) throw Error("computer tool missing")

    // when
    const child = await computer
      .execute({ action: "capabilities" }, caller("ses_child"))
      .catch((error: unknown) => error)
    const explore = await computer
      .execute({ action: "capabilities" }, caller("ses_root", "explore"))
      .catch((error: unknown) => error)

    // then
    expect((child as Error).message).toContain("only in root sessions")
    expect((explore as Error).message).toContain("read-only roles")
    expect(fake.asserts).toEqual([])
    await dispose()
  })

  test("#given /omo:computer #when status, off, status and an unknown subcommand run #then the output event reports the engine and the prelude, off removes the global, and the usage names /omo:computer", async () => {
    // given
    const fake = fakeHost(project("command", {}))
    const component = createComputerComponent(fake.host, {
      platform: "win32",
      engine,
      skillRoot: root,
      loadRuntime: async () => fakeRuntimeModule().module,
    })
    const dispose = await component.register()
    const command = fake.commands[0]
    if (!command) throw Error("command missing")
    const run = (text: string) => command.execute({ sessionID: "ses_root", prompt: { text } } as never)

    // when
    await run("status")
    await run("off")
    await run("")
    await run("bogus")

    // then
    const texts = fake.emitted.map((event) => event.payload.text ?? "")
    expect(fake.emitted.every((event) => event.name === "command.output")).toBe(true)
    expect(texts[0]).toContain("engine: not started")
    expect(texts[0]).toContain("prelude: active")
    expect(texts[0]).toContain("OS permissions: unknown until first use")
    expect(texts[1]).toBe("Computer use off for this session.")
    expect(texts[2]).toContain("prelude: inactive")
    expect(fake.emitted[3]?.payload).toMatchObject({ level: "warning", command: "omo:computer" })
    expect(texts[3]).toContain("Usage: /omo:computer on|off|status|stop|resume")
    for (const text of texts) expect(text).not.toMatch(/(^|[\s(`])\/computer\b/)
    expect(component.kernelPreludes?.active("ses_root")).toEqual([])
    await dispose()
  })

  test("#given started session runtimes #when a session is deleted, an agent run settles and the plugin is disposed #then control is revoked and every engine session is closed", async () => {
    // given
    const fake = fakeHost(project("lifecycle", {}))
    const runtime = fakeRuntimeModule()
    const component = createComputerComponent(fake.host, {
      platform: "win32",
      engine,
      skillRoot: root,
      loadRuntime: async () => runtime.module,
    })
    const dispose = await component.register()
    const computer = fake.tools.find((tool) => tool.name === "computer")
    if (!computer) throw Error("computer tool missing")
    await computer.execute({ action: "capabilities" }, caller("ses_a"))
    await computer.execute({ action: "capabilities" }, caller("ses_b"))

    // when
    await fake.hooks.get("experimental.idle")?.({ sessionID: "ses_a" })
    fake.deleteSession("ses_a")
    await Bun.sleep(20)
    const afterDelete = runtime.log.filter((entry) => entry === "close").length
    await dispose()
    const after = await computer.execute({ action: "capabilities" }, caller("ses_b")).catch((error: unknown) => error)

    // then
    expect(runtime.log).toContain("revoke")
    expect(afterDelete).toBe(1)
    expect(runtime.log.filter((entry) => entry === "close")).toHaveLength(2)
    expect((after as Error).message).toContain("shutting down")
  })

  test("#given computer.enabled false #when registered #then no tool, host tool or prelude exists and /computer explains how to turn it on", async () => {
    // given
    const fake = fakeHost(project("disabled", { enabled: false }))
    const component = createComputerComponent(fake.host, { platform: "win32", engine })

    // when
    const dispose = await component.register()
    await fake.commands[0]?.execute({ sessionID: "ses_root", prompt: { text: "status" } } as never)

    // then
    expect(fake.tools).toEqual([])
    expect(component.ownedTools).toEqual([])
    expect(component.kernelPreludes).toBeUndefined()
    expect(fake.emitted[0]?.payload).toMatchObject({ level: "warning", command: "omo:computer" })
    expect(fake.emitted[0]?.payload.text).toContain("computer.enabled")
    await dispose()
  })
})
