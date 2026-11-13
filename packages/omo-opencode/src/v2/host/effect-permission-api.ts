import { Cause, Effect, Exit, Schema, type Scope } from "effect"
import type { PermissionDomain } from "@opencode/plugin/effect/permission"
import { AssertInput } from "@opencode/plugin/permission"

export class PermissionTransportClosedError extends Error {
  override readonly name = "PermissionTransportClosedError"
  constructor() {
    super("Joined permission owner closed")
  }
}

export class PermissionRequestInterruptedError extends Error {
  override readonly name = "PermissionRequestInterruptedError"
  constructor(cause: Cause.Cause<unknown>) {
    super("Permission request interrupted by host", { cause })
  }
}

/** Internal adapter options. These are NOT options on SDK Promise.assert. */
export interface JoinedPermissionApi {
  assert(input: typeof AssertInput.Encoded, options?: { readonly signal?: AbortSignal }): Promise<void>
  /** Stops admission synchronously, interrupts and joins original request fibers.
   * Request failures stay on their request promises; close certifies termination,
   * not recovery from a failed host finalizer. */
  close(): Promise<void>
}

const owners = new WeakSet<object>()
export function hasJoinedPermissionCancellation(value: unknown): value is JoinedPermissionApi {
  return typeof value === "object" && value !== null && owners.has(value)
}

/** Exit is observed AFTER the original scoped fiber's finalizers. Never squash
 * a typed Tool.Error into FiberFailure, and never mask a different joined error
 * merely because the caller canceled while finalization was in progress. */
function rejectCause(cause: Cause.Cause<unknown>, signal: AbortSignal): never {
  const failures: unknown[] = []
  for (const reason of cause.reasons) {
    const failure = Cause.isFailReason(reason) ? reason.error : Cause.isDieReason(reason) ? reason.defect : undefined
    if (!Cause.isFailReason(reason) && !Cause.isDieReason(reason)) continue
    if (signal.aborted && Object.is(failure, signal.reason)) continue
    if (!failures.some((value) => Object.is(value, failure))) failures.push(failure)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "Joined permission request failures", { cause })
  if (signal.aborted) throw signal.reason
  throw new PermissionRequestInterruptedError(cause)
}

/** Acquire in the genuine Effect plugin scope BEFORE its consumers. Every
 * request is separately scoped, validated by the published SDK AssertInput,
 * and run against the real Effect domain. No private API or Promise adapter. */
export function acquireEffectPermissionApi(
  permission: Pick<PermissionDomain, "assert">,
): Effect.Effect<JoinedPermissionApi, never, Scope.Scope> {
  return Effect.gen(function* () {
    const runtime = yield* Effect.context<Scope.Scope>()
    const run = Effect.runPromiseExitWith(runtime)
    const lifetime = new AbortController(),
      stopped = new PermissionTransportClosedError()
    const pending = new Set<Promise<void>>()
    let closing = false,
      closed = false,
      closingWork: Promise<void> | undefined

    const api: JoinedPermissionApi = Object.freeze({
      assert(input: typeof AssertInput.Encoded, options?: { readonly signal?: AbortSignal }): Promise<void> {
        if (closing) return Promise.reject(stopped)
        const signal = options?.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal
        // Placeholder is tracked before codec/domain code can run or reenter close.
        const work = Promise.resolve().then(async () => {
          signal.throwIfAborted()
          const effect = Schema.decodeUnknownEffect(AssertInput)(input).pipe(
            Effect.flatMap((value) => permission.assert(value)),
          )
          const exit = await run(Effect.scoped(effect), { signal })
          if (Exit.isFailure(exit)) rejectCause(exit.cause, signal)
          // An uninterruptible host can finish successfully after cancellation;
          // that is still not permission for the canceled caller to continue.
          signal.throwIfAborted()
        })
        pending.add(work)
        void work.finally(() => pending.delete(work)).catch(() => {})
        return work
      },
      close(): Promise<void> {
        if (closed) return Promise.resolve()
        if (closingWork) return closingWork
        closing = true
        lifetime.abort(stopped)
        const work = (async () => {
          // Original settlement/finalizers can enqueue their own finishing work.
          while (pending.size) await Promise.allSettled([...pending])
          closed = true
        })()
        closingWork = work
        void work
          .finally(() => {
            if (!closed && closingWork === work) closingWork = undefined
          })
          .catch(() => {})
        return work
      },
    })
    owners.add(api)
    yield* Effect.addFinalizer(() => Effect.promise(() => api.close()))
    return api
  })
}
