import { afterEach, expect, test } from "bun:test"
import { Effect, Schema, SchemaAST, Scope } from "effect"
import { ClientApi } from "@opencode/protocol/client"
import type * as EffectPlugin from "@opencode/plugin/effect/plugin"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import rootPlugin from "../index"
import omoV2Plugin, { setupV2EffectHost, setupV2Host } from "./index"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

type FixtureTool = {
  id: string
  name: string
  execute: (input: unknown, caller: unknown) => Effect.Effect<unknown, unknown>
}
function fixture(options: { version?: string; failRpc?: boolean; mutation?: boolean; pendingGet?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "omo-effect-root-"))
  directories.push(directory)
  mkdirSync(join(directory, ".omo"))
  writeFileSync(join(directory, ".omo", "omo.jsonc"), JSON.stringify({ formatOnMutation: { mode: "off" } }))
  const order: string[] = []
  let getCalls = 0
  let getEntered!: () => void
  const entered = new Promise<void>((resolve) => {
    getEntered = resolve
  })
  // Only a controlled host fixture. Every invoked domain method returns a real Effect;
  // an unexpected call fails instead of inventing a successful host response.
  const unused: object = new Proxy(() => Effect.die(new Error("Unexpected fixture host call")), { get: () => unused })
  const registration = (name: string) =>
    Effect.gen(function* () {
      order.push(`register:${name}`)
      let closed = false
      const dispose = Effect.sync(() => {
        if (!closed) {
          closed = true
          order.push(`dispose:${name}`)
        }
      })
      yield* Effect.addFinalizer(() => dispose)
      return { dispose, events: { emit: () => Effect.void } }
    })
  const success = defined([...ClientApi.groups["server.session"].endpoints["session.get"].success][0])
  const ast = Schema.toType(success).ast
  const field = SchemaAST.isObjects(success.ast)
    ? success.ast.propertySignatures.find((item) => item.name === "data")
    : undefined
  const codec = Schema.make<Schema.Codec<unknown, unknown>>(
    SchemaAST.isObjects(ast) && ast.propertySignatures.length === 1 && field ? field.type : success.ast,
  )
  const sessionValue = Schema.decodeUnknownSync(codec)({
    id: "ses_effect_root",
    projectID: "fixture",
    location: { directory },
    time: { created: 1234, updated: 1234 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    title: "Fixture",
  })
  const get = () =>
    Effect.gen(function* () {
      yield* Scope.Scope
      getCalls++
      order.push("get:entered")
      getEntered()
      if (options.pendingGet)
        return yield* Effect.never.pipe(
          Effect.onInterrupt(() =>
            Effect.promise(async () => {
              order.push("get:finalizer-start")
              await Promise.resolve()
              order.push("get:finalizer-joined")
            }),
          ),
        )
      return sessionValue
    })
  const tools = new Map<string, FixtureTool>([
    ["write", { id: "write", name: "write", execute: () => Effect.succeed({ content: "FIXTURE_WRITE" }) }],
  ])
  const editor = {
    list: () => [...tools.values()],
    get: (id: string) => tools.get(id),
    namespace: () => {},
    add: (tool: FixtureTool) => tools.set(tool.name, { ...tool, id: tool.name }),
    update: (id: string, update: (tool: FixtureTool) => void) => {
      const tool = tools.get(id)
      if (tool) update(tool)
    },
    remove: (id: string) => tools.delete(id),
  }
  const rpc = Object.assign(
    () => {
      throw new Error("Unexpected fixture RPC client")
    },
    {
      register: () => (options.failRpc ? Effect.die(new Error("Fixture RPC failed")) : registration("rpc")),
    },
  )
  const host = {
    app: { version: options.version ?? "2.2.6" },
    location: { directory },
    // This fixture does not model the tool/permission domains the Native task component acquires.
    options: {
      "omo-senpi-lsp-tools-enabled": options.mutation === true,
      "omo-senpi-lsp-post-edit-diagnostics-enabled": false,
      "omo-native-task-enabled": false,
      "omo-senpi-ultrawork-disabled": true,
      "omo-senpi-todo-fanout-reminder-disabled": true,
      "omo-senpi-question-gates-disabled": true,
      "omo-senpi-comment-checker-disabled": true,
      "omo-memory-enabled": false,
      "omo-native-eval-enabled": false,
      "omo-goal-enabled": false,
      "omo-ulw-execute-enabled": false,
      "omo-computer-use-enabled": false,
    },
    agent: { get: unused, list: unused, reload: unused, transform: () => registration("agents") },
    session: new Proxy(unused, { get: (_target, key) => (key === "get" ? get : unused) }),
    tool: new Proxy(unused, {
      get: (_target, key) =>
        key === "transform"
          ? (callback: (value: typeof editor) => void) =>
              Effect.gen(function* () {
                callback(editor)
                return yield* registration("tools")
              })
          : key === "hook"
            ? () => registration("tool-hook")
            : unused,
    }),
    rpc,
    aisdk: unused,
    command: unused,
    credential: unused,
    event: unused,
    experimental: unused,
    generate: unused,
    integration: unused,
    mcp: unused,
    model: unused,
    permission: unused,
    plugin: unused,
    provider: unused,
    reference: unused,
    shell: unused,
    skill: unused,
    storage: unused,
    vcs: unused,
    websearch: unused,
    worktree: unused,
  } as unknown as EffectPlugin.Context
  return { host, order, tools, entered, getCalls: () => getCalls }
}

test("both roots retain legacy setup and expose the same real Effect producer", () => {
  expect(omoV2Plugin.setup).toBe(setupV2Host)
  expect(omoV2Plugin.effect).toBe(setupV2EffectHost)
  expect(typeof rootPlugin.server).toBe("function")
  expect(typeof rootPlugin.setup).toBe("function")
  expect(Effect.isEffect(rootPlugin.effect(fixture().host))).toBe(true)
})

test("official scoped Effect composition installs once and cleans RPC then agents exactly once", async () => {
  const f = fixture()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* setupV2EffectHost(f.host)
        expect(f.order).toEqual(["register:agents", "register:tool-hook", "register:rpc"])
      }),
    ),
  )
  expect(f.order).toEqual([
    "register:agents",
    "register:tool-hook",
    "register:rpc",
    "dispose:rpc",
    "dispose:tool-hook",
    "dispose:agents",
  ])
})

test("failed public RPC setup cleans prior agent registration on the same real scope", async () => {
  const f = fixture({ failRpc: true })
  await expect(Effect.runPromise(Effect.scoped(setupV2EffectHost(f.host)))).rejects.toThrow("Fixture RPC failed")
  expect(f.order).toEqual(["register:agents", "register:tool-hook", "dispose:tool-hook", "dispose:agents"])
})

test("unverified host versions are refused before any domain registration", async () => {
  for (const version of ["2.2.5", "2.2.7", "unknown"]) {
    const f = fixture({ version })
    await expect(Effect.runPromise(Effect.scoped(setupV2EffectHost(f.host)))).rejects.toThrow("verified OpenCode 2.2.6")
    expect(f.order).toEqual([])
  }
})

test("existing mutation consumer receives the joined native session producer and scope close joins its finalizer", async () => {
  const f = fixture({ mutation: true, pendingGet: true })
  let request: Promise<unknown> | undefined
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* rootPlugin.effect(f.host)
        const caller = {
          sessionID: "ses_effect_root",
          messageID: "msg_fixture",
          id: "call_fixture",
          agent: "build",
          signal: new AbortController().signal,
          progress: () => Effect.void,
        }
        request = Effect.runPromise(
          defined(f.tools.get("write")).execute({ path: "fixture.txt", content: "unused" }, caller),
        ).catch((error) => error)
        yield* Effect.promise(() => f.entered)
        expect(f.getCalls()).toBe(1)
      }),
    ),
  )
  await request
  expect(f.order).toContain("get:finalizer-joined")
  expect(f.order.filter((item) => item === "dispose:rpc")).toHaveLength(1)
  expect(f.order.filter((item) => item === "dispose:agents")).toHaveLength(1)
})

function defined<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("expected a defined value")
  return value
}
