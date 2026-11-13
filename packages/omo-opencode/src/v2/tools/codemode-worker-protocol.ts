// Message contract between the main-thread eval client (codemode-worker-client.ts) and the codemode
// worker (codemode-worker-runtime.ts), carried by codemode-rpc.ts. Every payload is structured-cloned.
//
// main -> worker calls:
//   load                 import codemode, build the eval description            -> LoadReply
//   acquire              start (or join) the session's kernels                  SessionParams -> null
//   execute              run one eval call; signal + progress updates           ExecuteParams -> senpi tool result
//   release              session deleted: dispose its kernels and capabilities  { sessionID } -> null
//   dispose              plugin dispose: dispose every session                  null -> null
//   capability.invoke    S9d: call a kernel tool through a captured capability  CapabilityInvokeParams -> unknown
//   capability.describe  S9d: describe kernel tools                             CapabilityDescribeParams -> unknown
// main -> worker notification: init (WorkerInit), sent once, first, right after the worker spawns.
// worker -> main call: host-tool (HostToolParams -> EvalHostToolResult), a cell reaching a plugin-owned tool.
// worker -> main notification: kernels (KernelsNotice), the pids of live subprocess kernels.

export const CODEMODE_RPC = {
  init: "init",
  load: "load",
  acquire: "acquire",
  execute: "execute",
  release: "release",
  dispose: "dispose",
  capabilityInvoke: "capability.invoke",
  capabilityDescribe: "capability.describe",
  hostTool: "host-tool",
  kernels: "kernels",
} as const

export interface EvalDefinition {
  readonly description: string
  readonly parameters: unknown
}

export interface WorkerInit {
  readonly cwd: string
  readonly sandbox: boolean
  /** Catalog of the plugin-owned host tools; their executors stay on the main thread. */
  readonly tools: readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[]
  readonly createTimeoutMs?: number
  readonly disposeTimeoutMs?: number
}

export interface LoadReply {
  readonly definition?: EvalDefinition
}
export interface SessionParams {
  readonly sessionID: string
  readonly stateDir: string
}
export interface ExecuteParams extends SessionParams {
  readonly toolCallId: string
  readonly params: unknown
}

/** A live kernel-tools capability registered in the worker; only its id crosses the thread boundary. */
export interface CapabilityRef {
  readonly id: string
  readonly invokeScope: boolean
}

export interface HostToolParams {
  readonly sessionID: string
  readonly name: string
  readonly params: unknown
  readonly capability?: CapabilityRef
  /** The eval call whose cell is running in this session right now; absent for a detached cell. */
  readonly toolCallId?: string
}

export interface KernelToolScope {
  readonly tools?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] }
}

export interface KernelToolInvokeRequest {
  readonly name: string
  readonly kernel_generation: number
  readonly definition_revision: number
  readonly args: unknown
  readonly call_id: string
}

export interface CapabilityInvokeParams {
  readonly capabilityId: string
  readonly request: KernelToolInvokeRequest
  readonly scope?: KernelToolScope
  readonly invoker?: { readonly sessionId: string }
}

export interface CapabilityDescribeParams {
  readonly capabilityId: string
  readonly names: readonly string[]
}
export interface KernelsNotice {
  readonly pids: readonly number[]
}

/** One session's eval runtime as the main thread sees it. */
export interface EvalSessionHandle {
  run(toolCallId: string, params: unknown, signal: AbortSignal, onUpdate: (update: unknown) => void): Promise<unknown>
}

/** What `registerNativeEval` drives; the production backend is the codemode worker client. */
export interface EvalBackend {
  /** Starts (or joins) loading codemode; resolves once cells can run. */
  load(): Promise<void>
  /** codemode's own description and schema once loaded; undefined before, or if it could not be built. */
  definition(): EvalDefinition | undefined
  acquire(sessionID: string, signal: AbortSignal): Promise<EvalSessionHandle>
  release(sessionID: string): Promise<void>
  dispose(): Promise<void>
}
