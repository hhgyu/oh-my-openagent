import { AsyncLocalStorage } from "node:async_hooks"
import { Schema } from "effect"
import type { Info, Result, ToolContext } from "@opencode/plugin/promise/tool"
import { assertPermissions, type PermissionPort } from "./permission-adapters"
import type { PolicyPipeline } from "./policy-pipeline"
import type { SessionLease, SessionScopes } from "./session-state"
import type { ToolRegistry } from "./tool-registry"
import type { ToolValueDecoder } from "./tool-value-codec"
import { hasJoinedPermissionCancellation } from "./effect-permission-api"
import { markHostAction } from "./host-action"

async function decode(schema: Info["input"], input: unknown): Promise<unknown> {
  if (Schema.isSchema(schema)) {
    try {
      return await Schema.decodeUnknownPromise(schema)(input)
    } catch {
      throw new Error("Invalid tool value")
    }
  }
  if ("~standard" in schema) {
    const standard = schema["~standard"] as {
      validate: (
        value: unknown,
      ) => { value?: unknown; issues?: readonly unknown[] } | Promise<{ value?: unknown; issues?: readonly unknown[] }>
    }
    if (!standard || typeof standard.validate !== "function") throw new Error("Unsupported StandardSchema")
    try {
      const result = await standard.validate(input)
      if (result.issues) throw new Error("Invalid tool value")
      return result.value
    } catch {
      throw new Error("Invalid tool value")
    }
  }
  throw new Error("Unsupported JSON Schema validation; provide an Effect Codec or StandardSchema")
}

function freezeValue(value: unknown, seen = new Set<object>()): unknown {
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) throw new Error("Cyclic tool input")
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new Error("Unsupported non-JSON tool input")
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
    if (signal.aborted) {
      signal.removeEventListener("abort", abort)
      abort()
    }
  })
}

function validateResult(result: Result): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid tool result")
  if (
    result.metadata !== undefined &&
    (!result.metadata || typeof result.metadata !== "object" || Array.isArray(result.metadata))
  )
    throw new Error("Invalid tool result metadata")
  if (result.content !== undefined && typeof result.content !== "string") {
    if (
      !Array.isArray(result.content) ||
      result.content.some(
        (part) =>
          !part ||
          (part.type === "text"
            ? typeof part.text !== "string"
            : part.type !== "file" ||
              typeof part.uri !== "string" ||
              typeof part.mime !== "string" ||
              (part.name !== undefined && typeof part.name !== "string")),
      )
    ) {
      throw new Error("Invalid tool result content")
    }
  }
}

const issuedCallBrand: unique symbol = Symbol("issued tool call")
/** Trusted component authority only. Never expose this token or its issuer to evaluated code. */
export interface IssuedToolCall {
  readonly [issuedCallBrand]: true
  readonly sessionID: ToolContext["sessionID"]
  readonly leaseGeneration: number
  readonly registryGeneration: number
  readonly admissionSignal: AbortSignal
  readonly lifetimeSignal: AbortSignal
  assertAdmission(): void
  assertLifetime(): void
}
export interface ToolCallAuthority {
  capture(caller: ToolContext): IssuedToolCall
  /** Persistent lifetime check; raw caller cancellation cannot poison shared initialization. */
  assert(token: IssuedToolCall, expectedLease?: SessionLease): void
  /** Every NEW service action requires its original still-active authorized target frame. */
  assertCall(token: IssuedToolCall): void
  parent(token: IssuedToolCall): SessionLease
}
type AuthorizedFrame = {
  caller: ToolContext | undefined
  readonly lease: SessionLease
  readonly generation: number
  readonly rawSignal: AbortSignal
  readonly retirement: AbortSignal
  check: (() => void) | undefined
  open: boolean
}

export function createToolKernel(options: {
  registry: ToolRegistry
  scopes: SessionScopes
  pipeline: PolicyPipeline
  permission: PermissionPort
  maxDepth?: number
}) {
  const active = new AsyncLocalStorage<
    readonly { requested: string; routed: string; lease: SessionLease; open: boolean }[]
  >()
  const authorized = new AsyncLocalStorage<AuthorizedFrame>()
  const issued = new WeakMap<IssuedToolCall, AuthorizedFrame>()
  function lifetime(token: IssuedToolCall, expectedLease?: SessionLease): AuthorizedFrame {
    const frame = issued.get(token)
    if (!frame) throw new Error("Unissued tool call authority")
    if (expectedLease !== undefined && expectedLease !== frame.lease)
      throw new Error("Tool call authority has a foreign parent lease")
    token.lifetimeSignal.throwIfAborted()
    options.scopes.assert(frame.lease, token.sessionID)
    options.registry.assert(frame.generation)
    return frame
  }
  const callAuthority: ToolCallAuthority = Object.freeze({
    capture(caller: ToolContext): IssuedToolCall {
      const frame = authorized.getStore()
      if (!frame || !frame.open || frame.caller !== caller || !frame.check)
        throw new Error("No active authorized tool callback")
      frame.check()
      const lifetimeSignal = AbortSignal.any([frame.lease.signal, frame.retirement])
      const token = Object.freeze({
        sessionID: caller.sessionID,
        leaseGeneration: frame.lease.generation,
        registryGeneration: frame.generation,
        lifetimeSignal,
        admissionSignal: AbortSignal.any([frame.rawSignal, lifetimeSignal]),
        assertAdmission(this: IssuedToolCall) {
          const owner = lifetime(this)
          owner.rawSignal.throwIfAborted()
          this.admissionSignal.throwIfAborted()
        },
        assertLifetime(this: IssuedToolCall) {
          lifetime(this)
        },
      }) as IssuedToolCall
      issued.set(token, frame)
      return token
    },
    assert(token: IssuedToolCall, expectedLease?: SessionLease) {
      lifetime(token, expectedLease)
    },
    assertCall(token: IssuedToolCall) {
      const frame = lifetime(token)
      if (!frame.open || authorized.getStore() !== frame || !frame.check)
        throw new Error("No active authorized tool callback")
      frame.check()
    },
    parent(token: IssuedToolCall) {
      return lifetime(token).lease
    },
  })
  const maxDepth = options.maxDepth ?? 8
  if (!Number.isInteger(maxDepth) || maxDepth < 1) throw new Error("Invalid tool depth limit")
  return {
    callAuthority,
    /** Trusted component authority only: runs `run` under an authorized frame for a host-originated
     * action on `lease` that no model tool call carries (the restart recovery of left-behind task
     * children, D-037). The frame grants no tool permission; whatever the action does asserts its own
     * approval, and the issued caller is marked so that approval names the action, not a tool call. */
    async hostAction<T>(
      context: ToolContext,
      lease: SessionLease,
      reason: string,
      run: (caller: ToolContext) => Promise<T>,
    ): Promise<T> {
      options.scopes.assert(lease, context.sessionID)
      const generation = options.registry.generation
      const retirement = options.registry.retirementSignal(generation)
      const rawSignal = context.signal
      const signal = AbortSignal.any([rawSignal, lease.signal, retirement])
      const check = () => {
        signal.throwIfAborted()
        options.scopes.assert(lease, context.sessionID)
        options.registry.assert(generation)
      }
      const caller: ToolContext = Object.freeze({
        ...context,
        signal,
        progress: async () => {
          check()
        },
      })
      markHostAction(caller, reason)
      const frame: AuthorizedFrame = { caller, lease, generation, rawSignal, retirement, check, open: true }
      try {
        check()
        return await authorized.run(frame, () => run(caller))
      } finally {
        frame.open = false
        frame.caller = undefined
        frame.check = undefined
      }
    },
    /** Call only inside a genuine host tool callback. Expose just invoke to evaluated code,
     * never this binder, context, scope authority, registry or permission port. */
    bind(context: ToolContext, lease: SessionLease) {
      options.scopes.assert(lease, context.sessionID)
      const generation = options.registry.generation
      const retirement = options.registry.retirementSignal(generation)
      const rawSignal = context.signal
      const binding = new AbortController()
      const signal = AbortSignal.any([rawSignal, lease.signal, binding.signal, retirement])
      const check = () => {
        signal.throwIfAborted()
        options.scopes.assert(lease, context.sessionID)
        options.registry.assert(generation)
      }
      const caller: ToolContext = Object.freeze({
        ...context,
        signal,
        progress: async (update: Parameters<ToolContext["progress"]>[0]) => {
          check()
          await context.progress(update)
          check()
        },
      })
      return Object.freeze({
        /** The owning outer callback must close the binding in finally. */
        dispose() {
          binding.abort(new Error("Tool caller binding closed"))
        },
        async invoke(requested: string, input: unknown): Promise<Result> {
          // Nested policy phases cannot borrow the outer target issuance frame.
          return authorized.exit(async () => {
            check()
            // SDK child callbacks may inherit their parent's asynchronous context. Keep
            // other live leases for return-cycle detection, but each lease owns its
            // own tool stack; completed callbacks cannot retain recursion state.
            const chain = (active.getStore() ?? []).filter((frame) => frame.open)
            const ownChain = chain.filter((frame) => frame.lease === lease)
            const contains = (name: string) =>
              ownChain.some((frame) => frame.open && (frame.requested === name || frame.routed === name))
            if (ownChain.length >= maxDepth || contains(requested))
              throw new Error("Recursive tool invocation or depth limit")
            // Resolve the requested identity too: rewriting cannot activate a hidden/unknown tool.
            options.registry.get(requested, generation)
            let finalTool: Info | undefined
            let outputDecoder: ToolValueDecoder | undefined
            let joinedPermission: Promise<void> | undefined
            const invocationFrame = { requested, routed: requested, lease, open: true }
            try {
              return await abortable(
                active.run([...chain, invocationFrame], () =>
                  options.pipeline.invocation(requested, input, caller).run(
                    async (call) => {
                      check()
                      if (contains(call.routed)) throw new Error("Recursive routed tool invocation")
                      const {
                        tool,
                        adapter,
                        nativeTaskPermission,
                        inputDecoder,
                        normalizeInput,
                        outputDecoder: routedOutputDecoder,
                      } = options.registry.get(call.routed, generation)
                      finalTool = tool
                      outputDecoder = routedOutputDecoder
                      invocationFrame.routed = call.routed
                      return active.run([...chain, invocationFrame], async () => {
                        const prepared = normalizeInput
                          ? await abortable(normalizeInput(call.input), signal)
                          : call.input
                        check()
                        const decoded = freezeValue(
                          await abortable(
                            inputDecoder
                              ? inputDecoder(freezeValue(prepared))
                              : decode(tool.input, freezeValue(prepared)),
                            signal,
                          ),
                        )
                        check()
                        await abortable(
                          options.scopes.authorize(lease, { requested, routed: call.routed, input: decoded }),
                          signal,
                        )
                        check()
                        if (nativeTaskPermission) {
                          if (requested !== tool.name)
                            throw Error("Native task permission cannot transfer across routes")
                          nativeTaskPermission.assertCurrent()
                          check()
                        } else {
                          if (!adapter)
                            throw new Error("Tool has neither a permission adapter nor a native task permission")
                          const permissions = adapter(decoded)
                          const declaredPermission = tool.options?.permission
                          if (
                            declaredPermission &&
                            !permissions.some((permission) => permission.action === declaredPermission)
                          )
                            throw new Error("Permission adapter omits declared tool permission")
                          const permissionWork = assertPermissions(options.permission, caller, permissions)
                          // Capture original work before waiting: the OUTER abortable can
                          // reject too. Genuine port work must still join before invoke
                          // settles; legacy SDK Promise ports remain explicitly unjoined.
                          if (hasJoinedPermissionCancellation(options.permission)) joinedPermission = permissionWork
                          await abortable(permissionWork, signal)
                          check()
                        }
                        const frame: AuthorizedFrame = {
                          caller,
                          lease,
                          generation,
                          rawSignal,
                          retirement,
                          check,
                          open: true,
                        }
                        const result = await abortable(
                          authorized.run(frame, async () => {
                            try {
                              return await tool.execute(decoded, caller)
                            } finally {
                              frame.open = false
                              frame.caller = undefined
                              frame.check = undefined
                            }
                          }),
                          signal,
                        )
                        check()
                        validateResult(result)
                        return result
                      })
                    },
                    async (result) => {
                      check()
                      validateResult(result)
                      if (outputDecoder) await abortable(outputDecoder(result.output), signal)
                      else if (finalTool?.output)
                        await abortable(
                          decode(
                            Schema.isSchema(finalTool.output) ? Schema.toType(finalTool.output) : finalTool.output,
                            result.output,
                          ),
                          signal,
                        )
                      check()
                    },
                  ),
                ),
                signal,
              )
            } finally {
              try {
                // Preserve an actual distinct/falsy joined failure over an outer
                // cancellation. A permission failure cannot coincide with target
                // failure: target issuance has not happened on that path.
                if (joinedPermission) await joinedPermission
              } finally {
                invocationFrame.open = false
              }
            }
          })
        },
      })
    },
  }
}
