// Kernel tool bindings for Native task children (S9d).
//
// Grant: a parent `eval` cell calls `tools.task({ tools: [...] })`. The owned eval `task` executor
// (eval-task-host-tool.ts) lends that cell's capability proxy to exactly that task call through the
// ledger below; the component's task context hands it to senpi-task as `ctx.kernelTools`, so the SAME
// Native `resolveTaskKernelTools` / `resolveKernelToolGrant` decides the grant (curated agents, process
// children, collisions, missing tools and policy escalation are refused exactly as in Native). A `task`
// call made outside an eval cell lends nothing, so a request for kernel tools is refused there.
//
// Binding: the approved spec carries the grant; the child guard binding claims `kernel-live-bindings`
// with the dedicated `omo_kernel_tool` registration and binds one producer per owned child. Every call
// checks custody (session and agent of the bound child), the producer's lifetime and the backend
// fences, then invokes through kernel-tool-proxy.ts.

import type { KernelToolGrant } from "@oh-my-opencode/senpi-task"
import type { ToolDomain } from "@opencode/plugin/effect/tool"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { Effect, type Scope } from "effect"
import { createKernelToolInfo, kernelToolSurface, KERNEL_TOOL_TOOL_NAME, type KernelToolCall, type KernelToolCallInput } from "../../tools/kernel-tool"
import { createKernelToolInvoker, kernelToolFailure, type KernelToolOutcome } from "../../tools/kernel-tool-proxy"

/** Trusted composition only: the original backend child, its approved agent and the approved grant. */
export interface KernelChildInput {
  readonly child: object
  readonly sessionID: string
  readonly agent: string
  readonly taskId: string
  readonly grant: KernelToolGrant
  /** Original backend observation guard plus component generation fences. */
  readonly assertCurrent: () => void
}
export interface KernelToolProducer { assertCurrent(): void; revoke(): void; join(): Promise<void> }
export interface KernelToolOwner {
  /** Actual listed SDK tool ID of the dedicated registration. */
  readonly hostID: string
  bindChild(input: KernelChildInput): KernelToolProducer
  isBound(sessionID: string): boolean
  /** Model-facing description and input for a bound child; undefined otherwise. */
  surface(sessionID: string): { readonly description: string; readonly input: unknown } | undefined
}

const FOREIGN_SESSION = "Parent kernel tools are available only to a Native child that was granted them from an eval cell"

function createProducer(input: KernelChildInput) {
  const lifetime = new AbortController()
  const tickets = new Set<Promise<void>>()
  let revoked = false
  const invoker = createKernelToolInvoker({ grant: input.grant, invokerSessionID: input.sessionID, isCurrent: () => !revoked })
  const surface = kernelToolSurface(input.grant.descriptors)
  function assertCurrent(): void {
    if (revoked) throw Error("Kernel tool producer revoked")
    input.assertCurrent()
  }
  function revoke(): void {
    revoked = true
    if (!lifetime.signal.aborted) lifetime.abort(Error("Kernel tool producer revoked"))
  }
  return {
    surface,
    get revoked() { return revoked },
    assertCurrent,
    async invoke(call: KernelToolCall, request: KernelToolCallInput, callerSignal: AbortSignal): Promise<KernelToolOutcome> {
      const { promise: ticket, resolve: settle } = Promise.withResolvers<void>()
      tickets.add(ticket)
      try {
        if (call.sessionID !== input.sessionID || call.agent !== input.agent) throw Error("Kernel tool producer custody mismatch")
        try { assertCurrent() } catch (error) {
          return kernelToolFailure(request.name, "tools_unavailable", `Parent kernel tool "${request.name}" is no longer available: ${error instanceof Error ? error.message : String(error)}`)
        }
        return await invoker.invoke({ name: request.name, args: request.args ?? {}, callID: call.id, signal: AbortSignal.any([callerSignal, lifetime.signal]) })
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

/** Acquire the dedicated SDK registration in the original Effect plugin scope, BEFORE the owned-child
 * tool guard, so the guard's transform also wraps this tool with its grant check. */
export function acquireKernelToolOwner(domains: { readonly tool: Pick<ToolDomain, "transform" | "list"> }): Effect.Effect<KernelToolOwner, never, Scope.Scope> {
  return Effect.gen(function* () {
    const producers = new Map<string, ReturnType<typeof createProducer>>()
    let closed = false
    const info = createKernelToolInfo((call, request, signal) => {
      const producer = closed ? undefined : producers.get(call.sessionID)
      if (!producer || producer.revoked) return Promise.reject(new ToolError({ message: FOREIGN_SESSION }))
      return producer.invoke(call, request, signal)
    })
    yield* domains.tool.transform(editor => { editor.add(info) })
    const listed = (yield* domains.tool.list()).filter(tool => tool.name === KERNEL_TOOL_TOOL_NAME && tool.options?.namespace === undefined)
    const registered = listed[0]
    if (listed.length !== 1 || !registered?.id) return yield* Effect.die(Error("Kernel tool registration is absent or ambiguous"))
    const hostID = registered.id
    // LIFO: producers are revoked and joined before the SDK registration is removed.
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      closed = true
      await Promise.allSettled([...producers.values()].map(producer => producer.join()))
    }))
    const live = (sessionID: string) => { const producer = producers.get(sessionID); return !closed && producer !== undefined && !producer.revoked ? producer : undefined }
    const owner: KernelToolOwner = {
      hostID,
      isBound: sessionID => live(sessionID) !== undefined,
      surface: sessionID => live(sessionID)?.surface,
      bindChild(input) {
        if (closed) throw Error("Kernel tool owner is closing")
        if (!input.child || !input.sessionID || !input.agent || !input.taskId || input.grant.descriptors.length === 0) throw Error("Incomplete kernel tool producer custody")
        if (producers.has(input.sessionID)) throw Error("Kernel tool producer for this child session is still bound or unjoined")
        input.assertCurrent()
        const producer = createProducer(input)
        producers.set(input.sessionID, producer)
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

type ModelContext = { readonly sessionID: string; readonly tools: Record<string, unknown> }

/** Unbound sessions never see the dispatcher; a bound child sees it described with its own grant. */
export function applyKernelToolSurface(context: ModelContext, owner: Pick<KernelToolOwner, "hostID" | "surface">): void {
  if (!(owner.hostID in context.tools)) return
  const surface = owner.surface(context.sessionID)
  if (surface) context.tools[owner.hostID] = { description: surface.description, input: surface.input }
  else delete context.tools[owner.hostID]
}

/** Lends one eval cell's capability to its task calls (session + eval call id) while they run. Calls of
 * one cell share the id and the capability; the most recent loan wins if they ever differ. */
export function createKernelCallLedger() {
  const lent = new Map<string, { readonly capability: unknown }[]>()
  const key = (caller: { readonly sessionID: string; readonly id: string }) => `${caller.sessionID}\u0000${caller.id}`
  return {
    lend(caller: { readonly sessionID: string; readonly id: string }, capability: unknown): () => void {
      const id = key(caller), loan = { capability }
      lent.set(id, [...lent.get(id) ?? [], loan])
      return () => {
        const rest = (lent.get(id) ?? []).filter(entry => entry !== loan)
        if (rest.length) lent.set(id, rest)
        else lent.delete(id)
      }
    },
    read(caller: { readonly sessionID: string; readonly id: string }): unknown {
      return lent.get(key(caller))?.at(-1)?.capability
    },
    size: () => lent.size,
  }
}
