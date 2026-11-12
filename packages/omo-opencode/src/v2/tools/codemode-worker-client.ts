// Main-thread side of the Native `eval` runtime: a thin client over the codemode worker. It never
// imports codemode; it spawns the worker on the first eval call, forwards calls by message
// (codemode-worker-protocol.ts), runs plugin-owned host tools for cells, and owns process-exit cleanup.
//
// Lifetimes: plugin dispose -> `dispose` message, then terminate. Session deletion -> `release`. A worker
// that dies is replaced on the next call (its sessions restart like a kernel reset). Process `exit` ->
// terminate the worker and kill the kernel pids it last reported (codemode-kernel-reaper.ts), since a
// worker thread cannot run cleanup during exit; `beforeExit` still gets the full awaited dispose.

import { existsSync } from "node:fs"
import { join } from "node:path"
import { Worker as ThreadWorker } from "node:worker_threads"
import { CodemodeUnavailableError } from "./codemode-loader"
import { EvalHostToolRefusedError, type OwnedEvalHostTool } from "./codemode-host-tools"
import { bounded, type ProcessEvents } from "./codemode-session-registry"
import { createKernelToolsCapabilityProxy } from "./codemode-capability"
import { killKernelTreesSync } from "./codemode-kernel-reaper"
import { createRpcPeer, type RpcPeer, type RpcPort } from "./codemode-rpc"
import { CODEMODE_RPC, type EvalBackend, type EvalDefinition, type HostToolParams, type KernelsNotice, type LoadReply } from "./codemode-worker-protocol"

/** Source checkouts run the `.ts` entry; the build emits `codemode-worker.js` next to the V2 chunks. */
const WORKER_ENTRY_FILES = ["codemode-worker.js", "codemode-worker.ts"] as const
const EXECUTE_ABORT_GRACE_MS = 5_000
const DISPOSE_MARGIN_MS = 5_000
const DEFAULT_DISPOSE_TIMEOUT_MS = 15_000

export interface CodemodeWorkerPort extends RpcPort {
  addEventListener(type: "message" | "error" | "close", listener: (event: { readonly data?: unknown; readonly message?: string }) => void): void
  terminate(): void
  unref?(): void
}

export function locateCodemodeWorker(directory: string = import.meta.dir, exists: (path: string) => boolean = existsSync): string {
  for (const name of WORKER_ENTRY_FILES) {
    const path = join(directory, name)
    if (exists(path)) return path
  }
  throw new CodemodeUnavailableError(`eval is unavailable: the codemode worker entry ${WORKER_ENTRY_FILES[0]} is missing from ${directory}. Rebuild or reinstall oh-my-openagent.`)
}

/**
 * Spawns the worker through `node:worker_threads`, not the Web `Worker`: any `process.on("worker", ...)`
 * listener in the host (team-core's lock-worker-lifetime calls `worker.on(...)`) gets an EventEmitter
 * Worker, and a Web Worker made that listener throw an uncaught TypeError on every spawn. The thread is
 * still a separate isolate, so codemode's import graph stays off OpenCode's main thread.
 */
export function spawnCodemodeWorker(entry: string = locateCodemodeWorker()): CodemodeWorkerPort {
  const worker = new ThreadWorker(entry)
  return {
    postMessage: message => worker.postMessage(message),
    addEventListener(type, listener) {
      if (type === "message") worker.on("message", (data: unknown) => listener({ data }))
      else if (type === "error") worker.on("error", (error: unknown) => listener({ message: error instanceof Error ? error.message : String(error) }))
      else worker.on("exit", (code: number) => listener({ message: `exited with code ${code}` }))
    },
    terminate: () => { void worker.terminate() },
    unref: () => worker.unref(),
  }
}

export interface CodemodeWorkerBackendOptions {
  readonly cwd: string
  readonly sandbox: boolean
  readonly ownedTools: readonly OwnedEvalHostTool[]
  readonly stateDir: (sessionID: string) => string
  readonly processEvents?: ProcessEvents
  readonly spawn?: () => CodemodeWorkerPort
  readonly killKernels?: (pids: readonly number[]) => void
  readonly createTimeoutMs?: number
  readonly disposeTimeoutMs?: number
}

export function createCodemodeWorkerBackend(options: CodemodeWorkerBackendOptions): EvalBackend {
  const owned = new Map(options.ownedTools.map(tool => [tool.name, tool]))
  const events = options.processEvents ?? process
  const kill = options.killKernels ?? killKernelTreesSync
  const disposeTimeoutMs = (options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS) + DISPOSE_MARGIN_MS
  let connection: { readonly port: CodemodeWorkerPort; readonly peer: RpcPeer } | undefined
  let definition: EvalDefinition | undefined
  let pids: readonly number[] = []
  let disposal: Promise<void> | undefined
  /** Per eval session: aborted when the session is released or its worker goes, ending its kernel-tool proxies. */
  const lifetimes = new Map<string, AbortController>()
  const lifetimeOf = (sessionID: string): AbortSignal => {
    let controller = lifetimes.get(sessionID)
    if (!controller) lifetimes.set(sessionID, controller = new AbortController())
    return controller.signal
  }
  const endLifetime = (sessionID: string, reason: Error) => { lifetimes.get(sessionID)?.abort(reason); lifetimes.delete(sessionID) }

  /** Stops the current worker without any message: crash, exit, or after a dispose reply. */
  const drop = (error: Error) => {
    const current = connection
    connection = undefined
    for (const sessionID of [...lifetimes.keys()]) endLifetime(sessionID, error)
    if (current) { current.peer.close(error); current.port.terminate() }
    if (pids.length) { kill(pids); pids = [] }
  }
  const onExit = () => drop(Error("process exiting"))
  const onBeforeExit = () => { void backend.dispose().catch(error => console.warn("[oh-my-openagent/v2] eval cleanup failed", error)) }
  events.on("exit", onExit)
  events.on("beforeExit", onBeforeExit)

  async function hostTool(peer: RpcPeer, params: unknown, call: { readonly signal: AbortSignal; update(value: unknown): void }) {
    const input = params as HostToolParams
    const tool = owned.get(input.name)
    if (!tool) throw new EvalHostToolRefusedError(`Tool "${input.name}" is not available inside an OpenCode eval cell.`)
    const kernelTools = input.capability ? createKernelToolsCapabilityProxy(peer, input.capability, input.sessionID, lifetimeOf(input.sessionID)) : undefined
    return tool.execute(input.params, {
      sessionID: input.sessionID, signal: call.signal, onUpdate: call.update,
      ...(kernelTools && { kernelTools }), ...(input.toolCallId !== undefined && { toolCallId: input.toolCallId }),
    })
  }

  function connect(): RpcPeer {
    if (disposal) throw Error("eval is shutting down")
    if (connection) return connection.peer
    const port = (options.spawn ?? spawnCodemodeWorker)()
    const peer: RpcPeer = createRpcPeer(port, { [CODEMODE_RPC.hostTool]: (params, call) => hostTool(peer, params, call) }, {
      [CODEMODE_RPC.kernels]: params => { pids = [...(params as KernelsNotice).pids] },
    })
    const current = { port, peer }
    const lost = (event: { readonly message?: string }) => {
      if (connection !== current) return
      console.warn("[oh-my-openagent/v2] eval runtime worker stopped; the next eval call starts a new one", event.message ?? "")
      drop(Error(`eval runtime worker stopped${event.message ? `: ${event.message}` : ""}; run the cell again`))
    }
    port.addEventListener("error", lost)
    port.addEventListener("close", lost)
    // The worker must never keep `opencode run` alive on its own.
    port.unref?.()
    peer.notify(CODEMODE_RPC.init, {
      cwd: options.cwd, sandbox: options.sandbox,
      tools: options.ownedTools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
      ...(options.createTimeoutMs !== undefined && { createTimeoutMs: options.createTimeoutMs }),
      ...(options.disposeTimeoutMs !== undefined && { disposeTimeoutMs: options.disposeTimeoutMs }),
    })
    connection = current
    return peer
  }

  const backend: EvalBackend = {
    async load() {
      const reply = await connect().call(CODEMODE_RPC.load, null) as LoadReply
      definition ??= reply.definition
    },
    definition: () => definition,
    async acquire(sessionID, signal) {
      await connect().call(CODEMODE_RPC.acquire, { sessionID, stateDir: options.stateDir(sessionID) }, { signal })
      return {
        run: (toolCallId, params, runSignal, onUpdate) => connect().call(CODEMODE_RPC.execute, { sessionID, stateDir: options.stateDir(sessionID), toolCallId, params }, {
          signal: runSignal, onUpdate, abortGraceMs: EXECUTE_ABORT_GRACE_MS,
        }),
      }
    },
    async release(sessionID) {
      endLifetime(sessionID, Error(`eval session ${sessionID} was released`))
      if (connection && !disposal) await connection.peer.call(CODEMODE_RPC.release, { sessionID })
    },
    dispose() {
      disposal ??= (async () => {
        const current = connection
        try {
          if (current) await bounded(current.peer.call(CODEMODE_RPC.dispose, null), disposeTimeoutMs, `eval runtime worker did not dispose within ${disposeTimeoutMs} ms`)
        } finally {
          drop(Error("eval is shutting down"))
          events.off("exit", onExit)
          events.off("beforeExit", onBeforeExit)
        }
      })()
      return disposal
    },
  }
  return backend
}
