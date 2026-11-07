import { AsyncLocalStorage } from "node:async_hooks"
import { Schema } from "effect"
import type { Info, Result, ToolContext } from "@opencode/plugin/promise/tool"
import { assertPermissions, type PermissionPort } from "./permission-adapters"
import type { PolicyPipeline } from "./policy-pipeline"
import type { SessionLease, SessionScopes } from "./session-state"
import type { ToolRegistry } from "./tool-registry"

async function decode(schema: Info["input"], input: unknown): Promise<unknown> {
  if (Schema.isSchema(schema)) {
    try { return await Schema.decodeUnknownPromise(schema)(input) }
    catch { throw new Error("Invalid tool value") }
  }
  if ("~standard" in schema) {
    const standard = schema["~standard"] as { validate: (value: unknown) => { value?: unknown; issues?: readonly unknown[] } | Promise<{ value?: unknown; issues?: readonly unknown[] }> }
    if (!standard || typeof standard.validate !== "function") throw new Error("Unsupported StandardSchema")
    try {
      const result = await standard.validate(input)
      if (result.issues) throw new Error("Invalid tool value")
      return result.value
    } catch { throw new Error("Invalid tool value") }
  }
  throw new Error("Unsupported JSON Schema validation; provide an Effect Codec or StandardSchema")
}

function freezeValue(value: unknown, seen = new Set<object>()): unknown {
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) throw new Error("Cyclic tool input")
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("Unsupported non-JSON tool input")
  seen.add(value)
  for (const nested of Object.values(value)) freezeValue(nested, seen)
  seen.delete(value)
  return Object.freeze(value)
}

/** The host assertion API has no signal parameter. Stop awaiting on abort; late settlement
 * is observed but can never continue into the target callback. Host owns approval teardown. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) { signal.removeEventListener("abort", abort); abort() }
  })
}

function validateResult(result: Result): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid tool result")
  if (result.metadata !== undefined && (!result.metadata || typeof result.metadata !== "object" || Array.isArray(result.metadata))) throw new Error("Invalid tool result metadata")
  if (result.content !== undefined && typeof result.content !== "string") {
    if (!Array.isArray(result.content) || result.content.some(part => !part ||
      (part.type === "text" ? typeof part.text !== "string" : part.type !== "file" || typeof part.uri !== "string" || typeof part.mime !== "string" || (part.name !== undefined && typeof part.name !== "string")))) {
      throw new Error("Invalid tool result content")
    }
  }
}

export function createToolKernel(options: { registry: ToolRegistry; scopes: SessionScopes; pipeline: PolicyPipeline; permission: PermissionPort; maxDepth?: number }) {
  const active = new AsyncLocalStorage<readonly { requested: string; routed: string }[]>()
  const maxDepth = options.maxDepth ?? 8
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new Error("Invalid tool depth limit")
  return {
    /** Call only inside a genuine host tool callback. Expose just invoke to evaluated code,
     * never this binder, context, scope authority, registry or permission port. */
    bind(context: ToolContext, lease: SessionLease) {
      options.scopes.assert(lease, context.sessionID)
      const generation = options.registry.generation
      const binding = new AbortController()
      const signal = AbortSignal.any([context.signal, lease.signal, binding.signal])
      const check = () => { signal.throwIfAborted(); options.scopes.assert(lease, context.sessionID); options.registry.assert(generation) }
      const caller: ToolContext = Object.freeze({ ...context, signal, progress: async (update: Parameters<ToolContext["progress"]>[0]) => { check(); await context.progress(update); check() } })
      return Object.freeze({
        /** The owning outer callback must close the binding in finally. */
        dispose() { binding.abort(new Error("Tool caller binding closed")) },
        async invoke(requested: string, input: unknown): Promise<Result> {
          check()
          const chain = active.getStore() ?? []
          const contains = (name: string) => chain.some(frame => frame.requested === name || frame.routed === name)
          if (chain.length >= maxDepth || contains(requested)) throw new Error("Recursive tool invocation or depth limit")
          // Resolve the requested identity too: rewriting cannot activate a hidden/unknown tool.
          options.registry.get(requested, generation)
          let finalTool: Info | undefined
          return abortable(active.run([...chain, { requested, routed: requested }], () => options.pipeline.invocation(requested, input, caller).run(async call => {
            check()
            if (contains(call.routed)) throw new Error("Recursive routed tool invocation")
            const { tool, adapter } = options.registry.get(call.routed, generation)
            finalTool = tool
            return active.run([...chain, { requested, routed: call.routed }], async () => {
              const decoded = freezeValue(await abortable(decode(tool.input, freezeValue(call.input)), signal))
              check()
              await abortable(options.scopes.authorize(lease, { requested, routed: call.routed, input: decoded }), signal)
              check()
              const permissions = adapter(decoded)
              if (tool.options?.permission && !permissions.some(permission => permission.action === tool.options!.permission)) throw new Error("Permission adapter omits declared tool permission")
              await abortable(assertPermissions(options.permission, caller, permissions), signal)
              check()
              const result = await abortable(tool.execute(decoded, caller), signal)
              check()
              validateResult(result)
              return result
            })
          }, async result => {
            check()
            validateResult(result)
            if (finalTool?.output) await abortable(decode(Schema.isSchema(finalTool.output) ? Schema.toType(finalTool.output) : finalTool.output, result.output), signal)
            check()
          })), signal)
        },
      })
    },
  }
}
