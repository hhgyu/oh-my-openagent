import { Context, Effect, Schema, SchemaAST, Scope } from "effect"
import { HttpApiSchema } from "effect/http-api"
import type { HttpApiEndpoint } from "effect/http-api"
import { ClientApi } from "@opencode/protocol/client"
import type * as EffectPlugin from "@opencode/plugin/effect/plugin"
import type * as PromisePlugin from "@opencode/plugin/promise/plugin"
import type { SessionBackendApi } from "./session-backend"
import { withJoinedSessionCancellation } from "./session-cancellation"

type Endpoint = Pick<HttpApiEndpoint.Top, "params" | "query" | "headers" | "payload" | "success">
type WireCall = (...args: never[]) => Promise<unknown>
type Codec = Schema.Codec<unknown, unknown>
type FullSessionSurface = Pick<
  PromisePlugin.Context["session"],
  | "create"
  | "get"
  | "list"
  | "prompt"
  | "synthetic"
  | "interrupt"
  | "wait"
  | "remove"
  | "context"
  | "instructions"
  | "update"
>
export type EffectSessionBackendApi = SessionBackendApi & FullSessionSurface
type SharedMethod = Exclude<keyof FullSessionSurface, "instructions" | "update">
// Wire codecs validate full results; retain the backend's narrower branded identity
// view alongside the complete Promise SDK DTO instead of projecting any fields away.
type JoinedCall<K extends SharedMethod> = (
  ...args: Parameters<FullSessionSurface[K]>
) => Promise<Awaited<ReturnType<FullSessionSurface[K]>> & Awaited<ReturnType<SessionBackendApi[K]>>>
class SessionCodecError extends Error {
  override readonly name = "SessionCodecError"
  constructor() {
    super("Invalid session API value")
  }
}
class SessionTransportClosedError extends Error {
  override readonly name = "SessionTransportClosedError"
  constructor() {
    super("Session transport owner closed")
  }
}
interface SessionRequestOwner {
  request<T>(work: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T>
}
const json = Schema.fromJsonString(Schema.Unknown)
const opaque = () => new SessionCodecError()

/** Compile only the pinned public endpoint schema fields. No SDK implementation import.
 * These buffered session codecs have no service requirements; rebuilding the public AST
 * gives the dynamic boundary an unknown-value codec, not unchecked branded input. */
function compile(endpoint: Endpoint) {
  const payloads = [...endpoint.payload.values()].flatMap((value) => [...value.schemas])
  const successes = [...endpoint.success]
  if (payloads.length > 1 || successes.length > 1 || payloads.some((value) => !Schema.isSchema(value))) throw opaque()
  const inputs = [endpoint.params, endpoint.query && Schema.toType(endpoint.query), endpoint.headers, ...payloads]
    .filter((value): value is Schema.Top => value !== undefined && Schema.isSchema(value))
    .map((value) => Schema.make<Codec>(value.ast))
  const success = successes[0] ?? HttpApiSchema.NoContent
  const noContent = HttpApiSchema.isNoContent(success.ast)
  const type = Schema.toType(success).ast
  const data = SchemaAST.isObjects(success.ast)
    ? success.ast.propertySignatures.find((field) => field.name === "data")
    : undefined
  const unwrap =
    !noContent &&
    SchemaAST.isObjects(type) &&
    type.indexSignatures.length === 0 &&
    type.propertySignatures.length === 1 &&
    type.propertySignatures[0]?.name === "data" &&
    data
  const output = Schema.make<Codec>(unwrap ? unwrap.type : success.ast)
  return { inputs, output, noContent }
}

/** The caller captures this context in the genuine Effect plugin scope. All operations
 * terminate their scoped fiber/finalizers before the returned promise rejects on abort. */
export function createEffectSessionBackendApi(
  session: EffectPlugin.Context["session"],
  runtime: Context.Context<Scope.Scope>,
): EffectSessionBackendApi {
  return makeEffectSessionBackendApi(session, runtime)
}

/** Acquire before component setup: its later finalizers may still perform permanent
 * cleanup through this API. This earlier owner finalizer then closes/aborts/joins leftovers. */
export function acquireEffectSessionBackendApi(
  session: EffectPlugin.Context["session"],
): Effect.Effect<EffectSessionBackendApi, never, Scope.Scope> {
  return Effect.gen(function* () {
    const runtime = yield* Effect.context<Scope.Scope>()
    const lifetime = new AbortController()
    const pending = new Set<Promise<unknown>>()
    const reason = new SessionTransportClosedError()
    let closed = false
    const owner: SessionRequestOwner = {
      request<T>(work: (signal: AbortSignal) => Promise<T>, callerSignal?: AbortSignal): Promise<T> {
        if (closed) return Promise.reject(reason)
        const signal = callerSignal ? AbortSignal.any([lifetime.signal, callerSignal]) : lifetime.signal
        // Register the returned promise before callbacks/Effect runners can start or
        // reenter scope closure. A queued call is owned even before its first host effect.
        const promise = Promise.resolve().then(() => {
          if (closed) throw reason
          return work(signal)
        })
        pending.add(promise)
        void promise.finally(() => pending.delete(promise)).catch(() => {})
        return promise
      },
    }
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        closed = true
        lifetime.abort(reason)
        await Promise.allSettled([...pending])
      }),
    )
    return makeEffectSessionBackendApi(session, runtime, owner)
  })
}

function makeEffectSessionBackendApi(
  session: EffectPlugin.Context["session"],
  runtime: Context.Context<Scope.Scope>,
  owner?: SessionRequestOwner,
): EffectSessionBackendApi {
  const run = Effect.runPromiseWith(runtime)
  function adapt<F extends WireCall, I, A>(endpoint: Endpoint, operation: (input: I) => Effect.Effect<A, unknown>) {
    const codec = compile(endpoint)
    const execute = async (input?: Parameters<F>[0], signal?: AbortSignal): Promise<Awaited<ReturnType<F>>> => {
      signal?.throwIfAborted()
      const effect = Effect.gen(function* () {
        const normalized = yield* Schema.encodeUnknownEffect(json)(input ?? {}).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(json)),
          Effect.mapError(opaque),
        )
        const parts = yield* Effect.forEach(codec.inputs, (schema) =>
          Schema.decodeUnknownEffect(schema)(normalized).pipe(Effect.mapError(opaque)),
        )
        // Type erasure is confined to the already schema-decoded public endpoint boundary.
        const decoded = Object.assign({}, ...parts) as I
        const result = yield* operation(decoded)
        const wire = codec.noContent
          ? undefined
          : yield* Schema.encodeUnknownEffect(codec.output)(result).pipe(Effect.mapError(opaque))
        // The public success codec, not a cast, validated/encoded the returned wire value.
        return wire as Awaited<ReturnType<F>>
      })
      try {
        return await run(Effect.scoped(effect), { signal })
      } catch (error) {
        if (signal?.aborted) throw signal.reason
        throw error
      }
    }
    return (input?: Parameters<F>[0], options?: { signal?: AbortSignal }): Promise<Awaited<ReturnType<F>>> =>
      owner ? owner.request((signal) => execute(input, signal), options?.signal) : execute(input, options?.signal)
  }
  const endpoints = ClientApi.groups["server.session"].endpoints
  return withJoinedSessionCancellation(
    {
      create: adapt<
        JoinedCall<"create">,
        Parameters<typeof session.create>[0],
        Effect.Success<ReturnType<typeof session.create>>
      >(endpoints["session.create"], session.create),
      get: adapt<JoinedCall<"get">, Parameters<typeof session.get>[0], Effect.Success<ReturnType<typeof session.get>>>(
        endpoints["session.get"],
        session.get,
      ),
      list: adapt<
        JoinedCall<"list">,
        Parameters<typeof session.list>[0],
        Effect.Success<ReturnType<typeof session.list>>
      >(endpoints["session.list"], session.list),
      prompt: adapt<
        JoinedCall<"prompt">,
        Parameters<typeof session.prompt>[0],
        Effect.Success<ReturnType<typeof session.prompt>>
      >(endpoints["session.prompt"], session.prompt),
      synthetic: adapt<
        JoinedCall<"synthetic">,
        Parameters<typeof session.synthetic>[0],
        Effect.Success<ReturnType<typeof session.synthetic>>
      >(endpoints["session.synthetic"], session.synthetic),
      interrupt: adapt<
        JoinedCall<"interrupt">,
        Parameters<typeof session.interrupt>[0],
        Effect.Success<ReturnType<typeof session.interrupt>>
      >(endpoints["session.interrupt"], session.interrupt),
      wait: adapt<
        JoinedCall<"wait">,
        Parameters<typeof session.wait>[0],
        Effect.Success<ReturnType<typeof session.wait>>
      >(endpoints["session.wait"], session.wait),
      remove: adapt<
        JoinedCall<"remove">,
        Parameters<typeof session.remove>[0],
        Effect.Success<ReturnType<typeof session.remove>>
      >(endpoints["session.remove"], session.remove),
      context: adapt<
        JoinedCall<"context">,
        Parameters<typeof session.context>[0],
        Effect.Success<ReturnType<typeof session.context>>
      >(endpoints["session.context"], session.context),
      update: adapt<
        EffectSessionBackendApi["update"],
        Parameters<typeof session.update>[0],
        Effect.Success<ReturnType<typeof session.update>>
      >(endpoints["session.update"], session.update),
      instructions: {
        entry: {
          list: adapt<
            SessionBackendApi["instructions"]["entry"]["list"],
            Parameters<typeof session.instructions.entry.list>[0],
            Effect.Success<ReturnType<typeof session.instructions.entry.list>>
          >(endpoints["session.instructions.entry.list"], session.instructions.entry.list),
          put: adapt<
            SessionBackendApi["instructions"]["entry"]["put"],
            Parameters<typeof session.instructions.entry.put>[0],
            Effect.Success<ReturnType<typeof session.instructions.entry.put>>
          >(endpoints["session.instructions.entry.put"], session.instructions.entry.put),
          remove: adapt<
            SessionBackendApi["instructions"]["entry"]["remove"],
            Parameters<typeof session.instructions.entry.remove>[0],
            Effect.Success<ReturnType<typeof session.instructions.entry.remove>>
          >(endpoints["session.instructions.entry.remove"], session.instructions.entry.remove),
        },
      },
    } satisfies EffectSessionBackendApi,
    "effect-runtime",
  )
}
