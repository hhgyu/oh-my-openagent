// Controlled UNIT host for the memory component tests: an in-memory session table whose `update`
// replaces `metadata` as sent (the host semantics the component must survive), plus captured hooks
// and transformed tools. Never spawns OpenCode.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OmoMemorySettingsSchema, type OmoMemorySettings } from "@oh-my-opencode/omo-config-core"
import type { CommandDefinition } from "@opencode/plugin/promise/command"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { Info, Result, ToolContext } from "@opencode/plugin/promise/tool"
import type { MemoryComponentOptions, MemoryHost } from "./index"

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export interface FakeSession { id: string; parentID?: string; directory: string; metadata?: Record<string, Json>; messages?: unknown[] }
export interface EmittedEvent { rpcID: string; name: string; data: unknown }
export interface SyntheticPost { sessionID: string; id?: string | null; text: string; description?: string | null; metadata?: Record<string, Json>; delivery?: string | null; resume?: boolean | null }
export type Callback = (input: never) => unknown
type SystemParts = SessionContext["system"]

export interface MemoryFixture {
  readonly root: string
  readonly home: string
  readonly project: string
  readonly env: Record<string, string | undefined>
  readonly host: MemoryHost
  readonly sessions: Map<string, FakeSession>
  readonly updates: { sessionID: string; metadata: Record<string, Json> | undefined }[]
  readonly hooks: Map<string, Callback>
  readonly tools: Map<string, Info>
  readonly commands: Map<string, CommandDefinition>
  readonly synthetics: SyntheticPost[]
  /** RPC events the component emitted, in order. */
  readonly events: EmittedEvent[]
  /** `session.synthetic` throws the error this returns for a post, when set. */
  syntheticFailure: ((input: SyntheticPost) => Error | undefined) | undefined
  disposals(): number
  options(overrides?: Partial<MemoryComponentOptions>): MemoryComponentOptions
  addSession(id: string, extra?: Partial<FakeSession>): void
  prompt(sessionID: string, text: string): Promise<void>
  toolBefore(sessionID: string, tool: string, input: unknown, id?: string): Promise<void>
  toolAfter(sessionID: string, tool: string, input: unknown, output: string, id?: string): Promise<void>
  compaction(sessionID: string, messages?: { id?: string }[]): Promise<void>
  /** Runs the `context` hook over these model-request messages and returns them as the hook left them. */
  requestMessages(sessionID: string, messages: { id?: string }[]): Promise<{ id?: string }[]>
  idle(sessionID: string): Promise<void>
  runCommand(name: string, sessionID: string, text?: string): Promise<void>
  context(sessionID: string, system?: SystemParts, extra?: { tools?: Record<string, { description: string; input: Record<string, unknown> }>; messages?: unknown[] }): Promise<SystemParts>
  runTool(name: string, sessionID: string, input: Record<string, unknown>, id?: string): Promise<Result>
  cleanup(): void
}

export function createMemoryFixture(settings: Record<string, unknown> = {}): MemoryFixture {
  const root = mkdtempSync(join(tmpdir(), "omo-v2-memory-"))
  const home = join(root, "home")
  const project = join(root, "project")
  const env: Record<string, string | undefined> = { OMO_MEMORY_HOME: join(root, "memory-home") }
  const sessions = new Map<string, FakeSession>()
  const updates: { sessionID: string; metadata: Record<string, Json> | undefined }[] = []
  const hooks = new Map<string, Callback>()
  const tools = new Map<string, Info>()
  const commands = new Map<string, CommandDefinition>()
  const synthetics: SyntheticPost[] = []
  const events: EmittedEvent[] = []
  const failures: { synthetic: ((input: SyntheticPost) => Error | undefined) | undefined } = { synthetic: undefined }
  let disposed = 0
  const registration = (key: string) => ({ dispose: async () => { disposed++; hooks.delete(key) } })
  const host = {
    options: {},
    location: { directory: project },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.get(sessionID)
        if (session === undefined) throw new Error(`unknown session ${sessionID}`)
        return { id: session.id, parentID: session.parentID, location: { directory: session.directory }, metadata: structuredClone(session.metadata) }
      },
      update: async ({ sessionID, metadata }: { sessionID: string; metadata?: Record<string, Json> }) => {
        const session = sessions.get(sessionID)
        if (session === undefined) throw new Error(`unknown session ${sessionID}`)
        updates.push({ sessionID, metadata: structuredClone(metadata) })
        if (metadata !== undefined) session.metadata = structuredClone(metadata)
      },
      hook: async (name: string, callback: Callback) => { hooks.set(`session:${name}`, callback); return registration(`session:${name}`) },
      context: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions.get(sessionID)
        if (session === undefined) throw new Error(`unknown session ${sessionID}`)
        return structuredClone(session.messages ?? [])
      },
      synthetic: async (input: SyntheticPost) => {
        const failure = failures.synthetic?.(input)
        if (failure !== undefined) throw failure
        synthetics.push(structuredClone(input))
        return { id: `syn_${synthetics.length}`, sessionID: input.sessionID, type: "synthetic", payload: { text: input.text } }
      },
    },
    rpc: {
      register: async (definition: { id: string }) => ({
        dispose: async () => { disposed++ },
        events: { emit: async (name: string, data: unknown) => { events.push({ rpcID: definition.id, name, data: structuredClone(data) }) } },
      }),
    },
    command: {
      transform: async (callback: (editor: { add(definition: CommandDefinition): void }) => void) => {
        callback({ add: definition => { commands.set(definition.name, definition) } })
        return { dispose: async () => { disposed++; commands.clear() } }
      },
    },
    tool: {
      hook: async (name: string, callback: Callback) => { hooks.set(`tool:${name}`, callback); return registration(`tool:${name}`) },
      transform: async (callback: (editor: { add(tool: Info): void }) => void) => {
        callback({ add: tool => { tools.set(tool.name, tool) } })
        return { dispose: async () => { disposed++; tools.clear() } }
      },
    },
  } as unknown as MemoryHost
  const call = async (key: string, input: unknown) => {
    const callback = hooks.get(key)
    if (callback === undefined) throw new Error(`hook ${key} is not registered`)
    await Reflect.apply(callback, undefined, [input])
  }
  return {
    root, home, project, env, host, sessions, updates, hooks, tools, commands, synthetics, events,
    get syntheticFailure() { return failures.synthetic },
    set syntheticFailure(failure: ((input: SyntheticPost) => Error | undefined) | undefined) { failures.synthetic = failure },
    disposals: () => disposed,
    options: (overrides: Partial<MemoryComponentOptions> = {}): MemoryComponentOptions => ({
      env, home, loadSettings: () => memorySettings(settings), lockRetryDelayMs: 5,
      logger: { warn: () => undefined }, ...overrides,
    }),
    addSession(id: string, extra: Partial<FakeSession> = {}) {
      sessions.set(id, { id, directory: project, ...extra })
    },
    prompt: (sessionID: string, text: string) => call("session:prompt", { sessionID, messageID: "m1", prompt: { text }, delivery: "immediate" }),
    toolBefore: (sessionID: string, tool: string, input: unknown, id = "c1") => call("tool:execute.before", { tool, sessionID, agent: "build", messageID: "m1", id, input }),
    toolAfter: (sessionID: string, tool: string, input: unknown, output: string, id = "c1") =>
      call("tool:execute.after", { tool, sessionID, agent: "build", messageID: "m1", id, input, status: "completed", result: { content: output } }),
    compaction: (sessionID: string, messages: { id?: string }[] = []) => call("session:compaction", { sessionID, system: [], tools: {}, messages }),
    async requestMessages(sessionID: string, messages: { id?: string }[]) {
      await call("session:context", { sessionID, system: [], tools: {}, messages })
      return messages
    },
    idle: (sessionID: string) => call("session:experimental.idle", { sessionID, background: [] }),
    async runCommand(name: string, sessionID: string, text = "") {
      const definition = commands.get(name)
      if (definition === undefined) throw new Error(`command ${name} is not registered`)
      await definition.execute({ sessionID, prompt: { text }, delivery: "steer" } as unknown as Parameters<CommandDefinition["execute"]>[0])
    },
    async context(sessionID: string, system: SystemParts = [], extra = {}) {
      await call("session:context", { sessionID, system, tools: extra.tools ?? {}, messages: extra.messages ?? [] })
      return system
    },
    async runTool(name: string, sessionID: string, input: Record<string, unknown>, id = "c1"): Promise<Result> {
      const tool = tools.get(name)
      if (tool === undefined) throw new Error(`tool ${name} is not registered`)
      const caller = { sessionID, agent: "build", messageID: "m1", id, signal: new AbortController().signal, progress: async () => undefined }
      return Reflect.apply(tool.execute, undefined, [input, caller as unknown as ToolContext])
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

function memorySettings(overrides: Record<string, unknown> = {}): OmoMemorySettings {
  return OmoMemorySettingsSchema.parse(overrides)
}

export function partsWith(system: SystemParts, marker: string): SystemParts {
  return system.filter(part => part.metadata?.[marker] === true)
}
