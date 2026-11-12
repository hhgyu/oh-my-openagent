// The codemode side of the eval Worker: loader, per-session registry and definition builder all live
// here, off OpenCode's main thread (opencode.exe's runtime Bun plugin scans every main-thread import
// synchronously, which froze the server 15-30 s on codemode's module graph in the S9c spike).
//
// A cell reaching a plugin-owned tool becomes a `host-tool` call back to the main thread, carrying the
// id of the cell's live kernel-tools capability, which stays here (codemode-capability.ts).

import { join } from "node:path"
import { createCodemodeLoader, type CodemodeLoader, type CodemodeModules } from "./codemode-loader"
import { buildEvalDefinition, createEvalSessionRuntime, type EvalRuntimeInput, type EvalSessionRuntime } from "./codemode-session"
import { createEvalSessionRegistry, type EvalSessionRegistry } from "./codemode-session-registry"
import type { EvalHostToolResult, OwnedEvalHostTool } from "./codemode-host-tools"
import { createKernelCapabilityTable } from "./codemode-capability"
import { createRpcPeer, type RpcPort } from "./codemode-rpc"
import {
  CODEMODE_RPC, type CapabilityDescribeParams, type CapabilityInvokeParams, type EvalDefinition,
  type ExecuteParams, type LoadReply, type SessionParams, type WorkerInit,
} from "./codemode-worker-protocol"

const KERNEL_REPORT_INTERVAL_MS = 2_000
/** Process events never fire usefully inside a Worker; the main thread owns exit handling. */
const NO_PROCESS_EVENTS = { on() {}, off() {} }

export interface CodemodeWorkerDeps {
  readonly loader?: CodemodeLoader
  readonly createRuntime?: (modules: CodemodeModules, input: EvalRuntimeInput) => Promise<EvalSessionRuntime>
  readonly buildDefinition?: (modules: CodemodeModules, sandbox: boolean) => Promise<EvalDefinition>
}

function kernelPids(modules: CodemodeModules | undefined): number[] {
  if (!modules) return []
  return modules.kernelRegistry.list().flatMap(entry => {
    const pid = (entry as { pid?: unknown } | null)?.pid
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? [pid] : []
  })
}

/** Text parts only: progress crosses the thread boundary, and only its text is ever shown. */
function textUpdate(update: unknown): unknown {
  const content = (update as { content?: unknown } | undefined)?.content
  return { content: Array.isArray(content) ? content.filter(part => (part as { type?: unknown } | null)?.type === "text") : [] }
}

/** The senpi tool result made cloneable: content parts stay, details go through JSON. */
function wireResult(value: unknown): unknown {
  if (!value || typeof value !== "object") return value
  const result = value as { content?: unknown; details?: unknown; isError?: unknown }
  let details: unknown
  try { details = result.details === undefined ? undefined : JSON.parse(JSON.stringify(result.details) ?? "null") } catch { details = { unserializable: true } }
  return { content: result.content, ...(details !== undefined && { details }), ...(result.isError === true && { isError: true }) }
}

export function attachCodemodeWorker(port: RpcPort, deps: CodemodeWorkerDeps = {}): void {
  const loader = deps.loader ?? createCodemodeLoader()
  const createRuntime = deps.createRuntime ?? createEvalSessionRuntime
  const buildDefinition = deps.buildDefinition ?? buildEvalDefinition
  const capabilities = createKernelCapabilityTable()
  const stateDirs = new Map<string, string>()
  /** The eval call whose cell runs in each session now (calls are exclusive per session). */
  const running = new Map<string, string>()
  let init: WorkerInit = { cwd: process.cwd(), sandbox: true, tools: [] }
  let registry: EvalSessionRegistry | undefined
  let definition: Promise<EvalDefinition | undefined> | undefined
  let lastReport = ""

  const report = () => {
    const pids = kernelPids(loader.loaded())
    const key = pids.join(",")
    if (key !== lastReport) { lastReport = key; peer.notify(CODEMODE_RPC.kernels, { pids }) }
  }
  const timer = setInterval(report, KERNEL_REPORT_INTERVAL_MS)
  timer.unref?.()

  const hostTools = (): OwnedEvalHostTool[] => init.tools.map(entry => ({
    ...entry,
    execute: (params, call) => {
      const capability = call.kernelTools === undefined ? undefined : capabilities.register(call.sessionID, call.kernelTools)
      const toolCallId = running.get(call.sessionID)
      return peer.call(CODEMODE_RPC.hostTool, { sessionID: call.sessionID, name: entry.name, params, ...(capability && { capability }), ...(toolCallId !== undefined && { toolCallId }) }, {
        ...(call.signal && { signal: call.signal }), ...(call.onUpdate && { onUpdate: call.onUpdate }),
      }) as Promise<EvalHostToolResult>
    },
  }))

  const sessions = (): EvalSessionRegistry => registry ??= createEvalSessionRegistry({
    processEvents: NO_PROCESS_EVENTS,
    ...(init.createTimeoutMs !== undefined && { createTimeoutMs: init.createTimeoutMs }),
    ...(init.disposeTimeoutMs !== undefined && { disposeTimeoutMs: init.disposeTimeoutMs }),
    async create(sessionID, signal) {
      const modules = await loader.load()
      signal.throwIfAborted()
      const stateDir = stateDirs.get(sessionID)
      if (!stateDir) throw Error(`eval session ${sessionID} has no state directory`)
      return createRuntime(modules, { sessionID, cwd: init.cwd, stateDir, sandbox: init.sandbox, ownedTools: hostTools(), signal })
    },
  })

  const acquire = async (params: SessionParams): Promise<EvalSessionRuntime> => {
    stateDirs.set(params.sessionID, params.stateDir)
    try { return await sessions().acquire(params.sessionID) } finally { report() }
  }

  const peer = createRpcPeer(port, {
    async [CODEMODE_RPC.load](): Promise<LoadReply> {
      const modules = await loader.load()
      definition ??= buildDefinition(modules, init.sandbox).catch((error: unknown) => {
        console.warn("[oh-my-openagent/v2] eval description unavailable; keeping the placeholder", error)
        return undefined
      })
      const built = await definition
      return built ? { definition: built } : {}
    },
    async [CODEMODE_RPC.acquire](params) { await acquire(params as SessionParams); return null },
    async [CODEMODE_RPC.execute](params, call) {
      const input = params as ExecuteParams
      // Acquire again on purpose: a respawned worker rebuilds the session's kernels on its next call.
      const runtime = await acquire(input)
      const ctx = {
        cwd: init.cwd, mode: "print", hasUI: false, isProjectTrusted: () => true, agentDir: input.stateDir, model: undefined, signal: call.signal,
        sessionManager: { getSessionId: () => input.sessionID, getSessionFile: () => join(input.stateDir, "session.jsonl") },
      }
      try {
        return wireResult(await runtime.exclusive(call.signal, async () => {
          running.set(input.sessionID, input.toolCallId)
          try {
            const args = runtime.tool.prepareArguments ? runtime.tool.prepareArguments(input.params) : input.params
            return await runtime.tool.execute(input.toolCallId, args, call.signal, update => call.update(textUpdate(update)), ctx)
          } finally {
            if (running.get(input.sessionID) === input.toolCallId) running.delete(input.sessionID)
          }
        }))
      } finally { report() }
    },
    async [CODEMODE_RPC.release](params) {
      const { sessionID } = params as { sessionID: string }
      capabilities.releaseSession(sessionID)
      stateDirs.delete(sessionID)
      running.delete(sessionID)
      try { await registry?.release(sessionID) } finally { report() }
      return null
    },
    async [CODEMODE_RPC.dispose]() {
      clearInterval(timer)
      capabilities.clear()
      try { await registry?.dispose() } finally { report() }
      return null
    },
    [CODEMODE_RPC.capabilityInvoke](params, call) {
      const input = params as CapabilityInvokeParams
      return capabilities.invoke(input.capabilityId, input.request, { signal: call.signal, ...(input.scope && { scope: input.scope }), ...(input.invoker && { invoker: input.invoker }) })
    },
    [CODEMODE_RPC.capabilityDescribe](params) {
      const input = params as CapabilityDescribeParams
      return capabilities.describe(input.capabilityId, input.names)
    },
  }, {
    [CODEMODE_RPC.init](params) { init = params as WorkerInit },
  })
}
