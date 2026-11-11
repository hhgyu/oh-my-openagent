import type { ToolDomain } from "@opencode/plugin/effect/tool"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { Effect, type Scope } from "effect"
import { hasJoinedPermissionCancellation, type JoinedPermissionApi } from "../../host/effect-permission-api"
import { CODEMODE_READONLY_PERMISSION, CODEMODE_READONLY_TOOL_NAME, createCodemodeReadonlyToolInfo, type CodemodeReadonlyCall } from "../../tools/codemode-readonly"
import { resolveNativeLsPath, runNativeLs, type NativeLsInput, type NativeLsOutput } from "../../tools/codemode-readonly-ls"

/** Trusted composition only: the original backend child and its approved agent and cwd. */
export interface CodemodeReadonlyChildInput {
  readonly child: object
  readonly sessionID: string
  readonly agent: string
  readonly cwd: string
  /** Original backend observation guard plus component generation fences. */
  readonly assertCurrent: () => void
}
export interface CodemodeReadonlyProducer {
  assertCurrent(): void
  revoke(): void
  join(): Promise<void>
}
export interface CodemodeReadonlyOwner {
  /** Actual listed SDK tool ID of the dedicated registration. */
  readonly hostID: string
  /** One producer per original owned backend child. */
  bindChild(input: CodemodeReadonlyChildInput): CodemodeReadonlyProducer
  /** True only while a live producer is bound to this exact session. */
  isBound(sessionID: string): boolean
}

const FOREIGN_SESSION = "The directory listing tool is available only to a Native child issued by this component"

/** Producer for one owned child: custody, one permission request per listing, joined tickets. */
function createProducer(input: CodemodeReadonlyChildInput, permission: JoinedPermissionApi) {
  const { sessionID, agent, cwd } = input
  const lifetime = new AbortController()
  const tickets = new Set<Promise<void>>()
  let revoked = false
  function assertCurrent(): void {
    if (revoked) throw Error("Directory listing producer revoked")
    input.assertCurrent()
    if (revoked) throw Error("Directory listing producer revoked")
  }
  function assertCall(call: CodemodeReadonlyCall): void {
    if (call.sessionID !== sessionID || call.agent !== agent) throw Error("Directory listing producer custody mismatch")
    assertCurrent()
  }
  function revoke(): void {
    revoked = true
    if (!lifetime.signal.aborted) lifetime.abort(Error("Directory listing producer revoked"))
  }
  return {
    assertCurrent,
    get revoked() { return revoked },
    async list(call: CodemodeReadonlyCall, request: NativeLsInput, callerSignal: AbortSignal): Promise<NativeLsOutput> {
      // The ticket is owned before any await, so a revoke and join during the request waits for it.
      const { promise: ticket, resolve: settle } = Promise.withResolvers<void>()
      tickets.add(ticket)
      try {
        assertCall(call)
        const signal = AbortSignal.any([callerSignal, lifetime.signal])
        const directory = resolveNativeLsPath(request.path, cwd)
        await permission.assert({ sessionID, agent, action: CODEMODE_READONLY_PERMISSION, resources: [directory],
          source: { type: "tool", messageID: call.messageID, id: call.id } }, { signal })
        signal.throwIfAborted()
        assertCall(call)
        return await runNativeLs(directory, request, signal)
      } finally {
        tickets.delete(ticket)
        settle()
      }
    },
    revoke,
    async join(): Promise<void> {
      revoke()
      await Promise.allSettled([...tickets])
    },
  }
}

/** Acquire the dedicated SDK registration in the original Effect plugin scope. Acquire it BEFORE the
 * owned-child tool guard, so the guard's transform also wraps this tool with its grant check. */
export function acquireCodemodeReadonly(
  domains: { readonly tool: Pick<ToolDomain, "transform" | "list"> },
  permission: JoinedPermissionApi,
): Effect.Effect<CodemodeReadonlyOwner, never, Scope.Scope> {
  return Effect.gen(function* () {
    if (!hasJoinedPermissionCancellation(permission)) return yield* Effect.die(Error("Original genuine joined permission owner required"))
    const producers = new Map<string, ReturnType<typeof createProducer>>()
    let closed = false
    const info = createCodemodeReadonlyToolInfo((call, input, signal) => {
      const producer = closed ? undefined : producers.get(call.sessionID)
      if (!producer || producer.revoked) return Promise.reject(new ToolError({ message: FOREIGN_SESSION }))
      return producer.list(call, input, signal)
    })
    yield* domains.tool.transform(editor => { editor.add(info) })
    const listed = (yield* domains.tool.list()).filter(tool => tool.name === CODEMODE_READONLY_TOOL_NAME && tool.options?.namespace === undefined)
    const registered = listed[0]
    if (listed.length !== 1 || !registered?.id) return yield* Effect.die(Error("Directory listing registration is absent or ambiguous"))
    const hostID = registered.id
    // LIFO: producers are revoked and joined before the SDK registration is removed.
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      closed = true
      await Promise.allSettled([...producers.values()].map(producer => producer.join()))
    }))
    const owner: CodemodeReadonlyOwner = {
      hostID,
      isBound(sessionID) { const producer = producers.get(sessionID); return !closed && producer !== undefined && !producer.revoked },
      bindChild(input) {
        if (closed) throw Error("Directory listing owner is closing")
        if (!input.child || !input.sessionID || !input.agent || !input.cwd) throw Error("Incomplete directory listing producer custody")
        if (producers.has(input.sessionID)) throw Error("Directory listing producer for this child session is still bound or unjoined")
        input.assertCurrent()
        const producer = createProducer(input, permission)
        producers.set(input.sessionID, producer)
        // Retained until joined, so owner close still joins a revoked producer's in-flight listing.
        const forget = () => { if (producers.get(input.sessionID) === producer) producers.delete(input.sessionID) }
        return Object.freeze({
          assertCurrent: () => producer.assertCurrent(),
          revoke() { producer.revoke() },
          async join() { try { await producer.join() } finally { forget() } },
        })
      },
    }
    return Object.freeze(owner)
  })
}
