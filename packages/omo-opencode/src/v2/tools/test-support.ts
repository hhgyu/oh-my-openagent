// Test wiring for the eval worker: the real client and the real worker runtime joined by a MessageChannel
// (so every payload is structured-cloned exactly as across a worker thread), with codemode faked; plus the
// fake OpenCode host and backend the `eval` tool tests drive.

import type { Info } from "@opencode/plugin/promise/tool"
import type { CodemodeModules } from "./codemode-loader"
import type { EvalRuntimeInput, EvalSessionRuntime, EvalToolDefinition } from "./codemode-session"
import type { ProcessEvents } from "./codemode-session-registry"
import type { OwnedEvalHostTool } from "./codemode-host-tools"
import { createCodemodeWorkerBackend, type CodemodeWorkerPort } from "./codemode-worker-client"
import { attachCodemodeWorker } from "./codemode-worker-runtime"
import type { EvalBackend, EvalDefinition, EvalSessionHandle } from "./codemode-worker-protocol"
import type { NativeEvalHost } from "./native-eval"

type Listener = (event: { readonly data?: unknown; readonly message?: string }) => void

function fakeProcessEvents() {
  const listeners = new Map<string, Set<() => void>>()
  const events: ProcessEvents = {
    on(event, listener) { let set = listeners.get(event); if (!set) listeners.set(event, set = new Set()); set.add(listener) },
    off(event, listener) { listeners.get(event)?.delete(listener) },
  }
  return { events, emit: (event: string) => { for (const listener of [...listeners.get(event) ?? []]) listener() }, count: (event: string) => listeners.get(event)?.size ?? 0 }
}

export interface FakeWorkerSetup {
  readonly kernels?: () => readonly unknown[]
  readonly execute?: (input: EvalRuntimeInput, ...args: Parameters<EvalToolDefinition["execute"]>) => Promise<unknown>
  readonly ownedTools?: readonly OwnedEvalHostTool[]
}

export function connectFakeWorker(setup: FakeWorkerSetup = {}) {
  const state = { spawned: 0, terminated: 0, created: [] as string[], disposed: [] as string[], killed: [] as (readonly number[])[], channels: [] as MessageChannel[] }
  const errorListeners: Listener[] = []
  const modules = { kernelRegistry: { list: () => setup.kernels?.() ?? [] } } as unknown as CodemodeModules
  const runtime = (input: EvalRuntimeInput): EvalSessionRuntime => ({
    tool: { name: "eval", description: "d", parameters: {}, execute: (...args) => setup.execute ? setup.execute(input, ...args) : Promise.resolve({ content: [{ type: "text", text: "42" }] }) },
    bridgeEndpoint: () => undefined,
    exclusive: (signal, work) => { signal.throwIfAborted(); return work() },
    dispose: async () => { state.disposed.push(input.sessionID) },
    abandon: () => {},
  })
  const spawn = (): CodemodeWorkerPort => {
    state.spawned++
    const channel = new MessageChannel()
    state.channels.push(channel)
    attachCodemodeWorker({ postMessage: message => channel.port2.postMessage(message), addEventListener: (_type, listener) => { channel.port2.addEventListener("message", listener); channel.port2.start() } }, {
      loader: { load: async () => modules, loaded: () => modules },
      createRuntime: async (_modules, input) => { state.created.push(input.sessionID); return runtime(input) },
      buildDefinition: async () => ({ description: "codemode description", parameters: { type: "object" } }),
    })
    return {
      postMessage: message => channel.port1.postMessage(message),
      addEventListener: (type, listener) => {
        if (type === "message") { channel.port1.addEventListener("message", listener); channel.port1.start() } else errorListeners.push(listener)
      },
      terminate: () => { state.terminated++; channel.port1.close(); channel.port2.close() },
    }
  }
  const proc = fakeProcessEvents()
  const backend = createCodemodeWorkerBackend({
    cwd: "/project", sandbox: true, ownedTools: setup.ownedTools ?? [], stateDir: id => `/state/${id}`,
    processEvents: proc.events, spawn, killKernels: pids => { state.killed.push(pids) },
  })
  const close = () => { for (const channel of state.channels) { channel.port1.close(); channel.port2.close() } }
  return { backend, state, proc, crash: (message: string) => { for (const listener of errorListeners.splice(0)) listener({ message }) }, close }
}

type Hook = (input: { sessionID: string; agent: string; tools: Record<string, { description: string; input: unknown }> }) => Promise<void> | void

export interface FakeEvalHost {
  readonly host: NativeEvalHost
  readonly tools: (Info & { id: string })[]
  readonly hooks: Hook[]
  deleteSession(id: string): void
}

export function fakeEvalHost(sessions: Record<string, { parentID?: string; directory?: string }> = {}): FakeEvalHost {
  const tools: (Info & { id: string })[] = []
  const hooks: Hook[] = []
  const deleted: string[] = []
  let wake: (() => void) | undefined
  const host = {
    location: { directory: "/project" },
    options: {},
    tool: {
      async transform(callback: (editor: unknown) => void) {
        callback({ list: () => tools, add: (tool: Info) => { tools.push({ ...tool, id: `tool_${tools.length}` }) } })
        return { dispose: async () => { tools.length = 0 } }
      },
      async list() { return tools },
    },
    session: {
      async hook(_name: string, callback: Hook) { hooks.push(callback); return { dispose: async () => { hooks.length = 0 } } },
      async get(input: { sessionID: string }) {
        const info = sessions[input.sessionID] ?? {}
        return { id: input.sessionID, parentID: info.parentID, location: { directory: info.directory ?? "/project" } }
      },
    },
    event: {
      subscribe(options: { signal?: AbortSignal }) {
        return { async *[Symbol.asyncIterator]() {
          while (!options.signal?.aborted) {
            const next = deleted.shift()
            if (next) { yield { type: "session.deleted", data: { sessionID: next } }; continue }
            await new Promise<void>(resolve => { wake = resolve; options.signal?.addEventListener("abort", () => resolve(), { once: true }) })
          }
        } }
      },
    },
  }
  return { host: host as unknown as NativeEvalHost, tools, hooks, deleteSession: (id: string) => { deleted.push(id); wake?.() } }
}

export const NO_PROCESS_EVENTS: ProcessEvents = { on() {}, off() {} }

export function fakeEvalBackend(run: EvalSessionHandle["run"] = async () => ({ content: [] }), options: { load?: () => Promise<void>; definition?: EvalDefinition } = {}) {
  const state = { acquired: 0, released: [] as string[], disposed: 0 }
  const backend: EvalBackend = {
    load: options.load ?? (async () => {}),
    definition: () => options.definition,
    acquire: async () => { state.acquired++; return { run } },
    release: async sessionID => { state.released.push(sessionID) },
    dispose: async () => { state.disposed++ },
  }
  return { backend, state }
}
