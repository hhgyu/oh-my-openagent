// Per-session registry of eval runtimes. Since the Worker move it runs INSIDE the codemode worker
// (codemode-worker-runtime.ts); the main thread reaches it only through codemode-worker-client.ts.
//
// Teardown has three triggers: session deletion releases one runtime, dispose releases all, and the
// process `exit` hook abandons whatever is left (synchronous kill paths only). Every path is idempotent
// and bounded by a timeout so cleanup cannot hang.

import type { EvalSessionRuntime } from "./codemode-session"

const DEFAULT_RUNTIME_CREATE_TIMEOUT_MS = 60_000
const DEFAULT_RUNTIME_DISPOSE_TIMEOUT_MS = 15_000

export interface ProcessEvents {
  on(event: "exit" | "beforeExit", listener: () => void): unknown
  off(event: "exit" | "beforeExit", listener: () => void): unknown
}

export interface EvalSessionRegistryOptions {
  create(sessionID: string, signal: AbortSignal): Promise<EvalSessionRuntime>
  readonly createTimeoutMs?: number
  readonly disposeTimeoutMs?: number
  readonly processEvents?: ProcessEvents
  readonly onError?: (message: string, error: unknown) => void
}

export interface EvalSessionRegistry {
  /** The session's runtime, created on first use; concurrent callers share one creation. */
  acquire(sessionID: string): Promise<EvalSessionRuntime>
  /** Session deleted: abort an in-flight creation or dispose the live runtime. Idempotent. */
  release(sessionID: string): Promise<void>
  /** Plugin dispose: release every session and refuse new ones. Idempotent. */
  dispose(): Promise<void>
  size(): number
}

type Entry = {
  readonly controller: AbortController
  readonly runtime: Promise<EvalSessionRuntime>
  settled?: EvalSessionRuntime
}

/** Rejects with `message` when `work` has not settled within `timeoutMs`; the work itself keeps running. */
export function bounded<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(message)), timeoutMs)
    timer.unref?.()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function createEvalSessionRegistry(options: EvalSessionRegistryOptions): EvalSessionRegistry {
  const createTimeoutMs = options.createTimeoutMs ?? DEFAULT_RUNTIME_CREATE_TIMEOUT_MS
  const disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_RUNTIME_DISPOSE_TIMEOUT_MS
  const report = options.onError ?? ((message, error) => console.warn(`[oh-my-openagent/v2] ${message}`, error))
  const events = options.processEvents ?? process
  const sessions = new Map<string, Entry>()
  let closing: Promise<void> | undefined

  const onExit = () => {
    for (const entry of sessions.values()) {
      entry.controller.abort(Error("process exiting"))
      entry.settled?.abandon()
    }
  }
  const onBeforeExit = () => {
    void registry.dispose()
  }
  events.on("exit", onExit)
  events.on("beforeExit", onBeforeExit)

  async function retire(entry: Entry): Promise<void> {
    entry.controller.abort(Error("eval session released"))
    let runtime: EvalSessionRuntime
    try {
      runtime = await entry.runtime
    } catch {
      return
    }
    await bounded(
      runtime.dispose(),
      disposeTimeoutMs,
      `eval session runtime did not dispose within ${disposeTimeoutMs} ms`,
    )
  }

  const registry: EvalSessionRegistry = {
    size: () => sessions.size,
    acquire(sessionID) {
      if (closing) return Promise.reject(Error("eval is shutting down"))
      const existing = sessions.get(sessionID)
      if (existing) return existing.runtime
      const controller = new AbortController()
      const created = options.create(sessionID, controller.signal)
      const runtime = bounded(
        created,
        createTimeoutMs,
        `eval runtime did not start within ${Math.round(createTimeoutMs / 1000)} s`,
      )
      const entry: Entry = { controller, runtime }
      sessions.set(sessionID, entry)
      runtime.then(
        (value) => {
          entry.settled = value
          // Released or closed while starting: the late runtime is disposed, never handed out again.
          if (controller.signal.aborted || sessions.get(sessionID) !== entry)
            void value.dispose().catch((error) => report("eval runtime cleanup failed", error))
        },
        () => {
          controller.abort(Error("eval runtime failed to start"))
          if (sessions.get(sessionID) === entry) sessions.delete(sessionID)
          // A creation that timed out may still finish: dispose it then instead of leaking its kernels.
          created
            .then(
              (late) => late.dispose(),
              () => {},
            )
            .catch((error) => report("late eval runtime cleanup failed", error))
        },
      )
      return runtime
    },
    async release(sessionID) {
      const entry = sessions.get(sessionID)
      if (!entry) return
      sessions.delete(sessionID)
      await retire(entry)
    },
    dispose() {
      closing ??= (async () => {
        const entries = [...sessions.values()]
        sessions.clear()
        const results = await Promise.allSettled(entries.map(retire))
        events.off("exit", onExit)
        events.off("beforeExit", onBeforeExit)
        const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
        if (failures.length) throw new AggregateError(failures, "eval session cleanup incomplete")
      })()
      return closing
    },
  }
  return registry
}
