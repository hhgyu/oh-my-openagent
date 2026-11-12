// Symmetric request/response channel between OpenCode's main thread and the codemode worker. Both ends
// use the same peer: the main thread calls `load`/`acquire`/`execute`/... on the worker, and the worker
// calls `host-tool` back on the main thread when a cell reaches a plugin-owned tool.
//
// Wire messages (structured-cloned by postMessage):
//   { rpc: "call", id, method, params }     start a call; ids are per sender, so both ends count alone
//   { rpc: "abort", id, reason }            the caller's signal fired; the callee's handler signal aborts
//   { rpc: "update", id, value }            progress from the callee, delivered to the caller's onUpdate
//   { rpc: "result", id, value }            the call resolved
//   { rpc: "error", id, error }             the call rejected; `error` is a WireError
//   { rpc: "notify", method, params }       one-way, no reply

export interface RpcPort {
  postMessage(message: unknown): void
  addEventListener(type: "message", listener: (event: { readonly data?: unknown }) => void): void
}

export interface WireError {
  readonly name: string
  readonly message: string
  readonly code?: string
}

/** An error thrown on the other end; `name` and the string `code` (e.g. `kernel_tool_stale`) survive. */
class RemoteError extends Error {
  readonly code: string | undefined
  constructor(wire: WireError) {
    super(wire.message)
    this.name = wire.name
    this.code = wire.code
  }
}

function toWireError(error: unknown): WireError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) }
  const code = (error as { code?: unknown }).code
  return { name: error.name, message: error.message, ...(typeof code === "string" && { code }) }
}

export interface RpcCallOptions {
  readonly signal?: AbortSignal
  readonly onUpdate?: (value: unknown) => void
  /** After an abort, wait this long for the callee's own answer before rejecting with the reason. 0 = reject at once. */
  readonly abortGraceMs?: number
}

export interface RpcHandlerCall {
  readonly signal: AbortSignal
  update(value: unknown): void
}
export type RpcHandler = (params: unknown, call: RpcHandlerCall) => unknown
export type RpcNotification = (params: unknown) => void

export interface RpcPeer {
  call(method: string, params: unknown, options?: RpcCallOptions): Promise<unknown>
  notify(method: string, params: unknown): void
  /** Rejects every outgoing call with `error`, aborts every incoming one, and refuses new calls. */
  close(error: Error): void
}

type Outgoing = { resolve(value: unknown): void; reject(error: unknown): void; onUpdate?: (value: unknown) => void }
type Message = {
  rpc?: unknown
  id?: unknown
  method?: unknown
  params?: unknown
  value?: unknown
  error?: unknown
  reason?: unknown
}

function wireOf(value: unknown): WireError {
  const wire = value as Partial<WireError> | undefined
  return {
    name: typeof wire?.name === "string" ? wire.name : "Error",
    message: typeof wire?.message === "string" ? wire.message : "remote call failed",
    ...(typeof wire?.code === "string" && { code: wire.code }),
  }
}

export function createRpcPeer(
  port: RpcPort,
  handlers: Readonly<Record<string, RpcHandler>>,
  notifications: Readonly<Record<string, RpcNotification>> = {},
): RpcPeer {
  const outgoing = new Map<number, Outgoing>()
  const incoming = new Map<number, AbortController>()
  let nextId = 0
  let closed: Error | undefined

  function send(message: Record<string, unknown>): void {
    try {
      port.postMessage(message)
    } catch (error) {
      // An uncloneable value (DataCloneError): the caller still gets an answer instead of hanging.
      if (message.rpc === "result" && typeof message.id === "number")
        port.postMessage({ rpc: "error", id: message.id, error: toWireError(error) })
      else if (message.rpc !== "update") throw error
    }
  }

  async function serve(id: number, method: string, params: unknown): Promise<void> {
    const controller = new AbortController()
    incoming.set(id, controller)
    try {
      const handler = handlers[method]
      if (!handler) throw Error(`unknown codemode worker method ${method}`)
      const value = await handler(params, {
        signal: controller.signal,
        update: (update) => {
          if (!controller.signal.aborted) send({ rpc: "update", id, value: update })
        },
      })
      if (!closed) send({ rpc: "result", id, value })
    } catch (error) {
      if (!closed) send({ rpc: "error", id, error: toWireError(error) })
    } finally {
      incoming.delete(id)
    }
  }

  port.addEventListener("message", (event) => {
    const message = event.data as Message | undefined
    if (!message || typeof message !== "object") return
    if (message.rpc === "notify" && typeof message.method === "string") {
      notifications[message.method]?.(message.params)
      return
    }
    if (typeof message.id !== "number") return
    if (message.rpc === "call" && typeof message.method === "string") {
      void serve(message.id, message.method, message.params)
      return
    }
    if (message.rpc === "abort") {
      incoming.get(message.id)?.abort(new RemoteError(wireOf(message.reason)))
      return
    }
    const pending = outgoing.get(message.id)
    if (!pending) return
    if (message.rpc === "update") pending.onUpdate?.(message.value)
    else if (message.rpc === "result") pending.resolve(message.value)
    else if (message.rpc === "error") pending.reject(new RemoteError(wireOf(message.error)))
  })

  return {
    call(method, params, options = {}) {
      if (closed) return Promise.reject(closed)
      const { signal } = options
      if (signal?.aborted) return Promise.reject(signal.reason ?? Error("aborted"))
      const id = nextId++
      return new Promise<unknown>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const onAbort = () => {
          send({ rpc: "abort", id, reason: toWireError(signal?.reason ?? Error("aborted")) })
          const grace = options.abortGraceMs ?? 0
          if (grace <= 0) {
            settle()
            reject(signal?.reason)
            return
          }
          timer = setTimeout(() => {
            settle()
            reject(signal?.reason)
          }, grace)
          timer.unref?.()
        }
        const settle = () => {
          outgoing.delete(id)
          signal?.removeEventListener("abort", onAbort)
          if (timer) clearTimeout(timer)
        }
        outgoing.set(id, {
          resolve: (value) => {
            settle()
            resolve(value)
          },
          reject: (error) => {
            settle()
            reject(error)
          },
          ...(options.onUpdate && { onUpdate: options.onUpdate }),
        })
        signal?.addEventListener("abort", onAbort, { once: true })
        try {
          send({ rpc: "call", id, method, params })
        } catch (error) {
          settle()
          reject(error)
        }
      })
    },
    notify(method, params) {
      if (!closed) send({ rpc: "notify", method, params })
    },
    close(error) {
      if (closed) return
      closed = error
      for (const pending of [...outgoing.values()]) pending.reject(error)
      for (const controller of incoming.values()) controller.abort(error)
    },
  }
}
