import type { ChildProcess } from "node:child_process"
import type { AgentToolResult } from "@code-yeongyu/senpi"
import {
  createCuratedReadonlyBashTool, executeCuratedReadonlyCommand,
  type CuratedReadonlyBashInput, type CuratedReadonlyExecutor,
} from "@oh-my-opencode/senpi-task/task-operations"
import { curatedReadonlyFormatter } from "@oh-my-opencode/utils/curated-readonly-presentation"
import type { ToolDomain } from "@opencode/plugin/effect/tool"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { Effect, type Scope } from "effect"
import { hasJoinedPermissionCancellation, type JoinedPermissionApi } from "../../host/effect-permission-api"
import { createReadonlyBrokerToolInfo, READONLY_BROKER_PERMISSION, READONLY_BROKER_TOOL_NAME, type ReadonlyBrokerCall } from "../../tools/curated-readonly"

/** The ORIGINAL Native executor signature, including its trusted process observer. */
export type ReadonlyExecute = typeof executeCuratedReadonlyCommand

/** Trusted composition only: the original backend child and its approved agent and cwd. */
export interface ReadonlyChildInput {
  readonly child: object
  readonly sessionID: string
  readonly agent: string
  readonly cwd: string
  /** Original backend observation guard plus component generation fences. */
  readonly assertCurrent: () => void
}
export interface ReadonlyProducer {
  assertCurrent(): void
  revoke(): void
  join(): Promise<void>
}
export interface ReadonlyBrokerOwner {
  /** Actual listed SDK tool ID of the dedicated registration. */
  readonly hostID: string
  /** One producer per original owned backend child. */
  bindChild(input: ReadonlyChildInput): ReadonlyProducer
  /** True only while a live producer is bound to this exact session. */
  isBound(sessionID: string): boolean
}

const FOREIGN_SESSION = "The read-only broker is available only to a curated Native child issued by this component"

type Operation = { readonly call: ReadonlyBrokerCall; process?: Promise<void> }

/** Settles after the original child closes (exit plus both stdio streams), or a spawn failure. */
function processClosed(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    child.once("close", () => resolve())
    child.once("error", () => { if (child.pid === undefined) resolve() })
  })
}

/** Producer over the ORIGINAL Native factory, policy and executor for one owned child. */
function createReadonlyProducer(options: ReadonlyChildInput & { readonly permission: JoinedPermissionApi; readonly execute?: ReadonlyExecute }) {
  const { sessionID, agent, cwd, permission } = options
  const checkCurrent = options.assertCurrent
  const execute = options.execute ?? executeCuratedReadonlyCommand
  const lifetime = new AbortController()
  const operations = new WeakMap<AbortSignal, Operation>()
  const tickets = new Set<Promise<void>>()
  let revoked = false
  function assertCurrent(): void {
    if (revoked) throw Error("Read-only producer revoked")
    checkCurrent()
    if (revoked) throw Error("Read-only producer revoked")
  }
  function assertCall(call: ReadonlyBrokerCall): void {
    if (call.sessionID !== sessionID || call.agent !== agent) throw Error("Read-only producer custody mismatch")
    assertCurrent()
  }
  // Injected into the ORIGINAL factory: receives only the canonical planned command, so the
  // permission resource is the exact normalized argv (curl includes --disable).
  const executor: CuratedReadonlyExecutor = async (command, commandCwd, timeoutSeconds, signal) => {
    const operation = signal === undefined ? undefined : operations.get(signal)
    if (!operation || !signal || commandCwd !== cwd) throw Error("Read-only broker execution has no owned operation")
    assertCall(operation.call)
    signal.throwIfAborted()
    await permission.assert({
      sessionID, agent, action: READONLY_BROKER_PERMISSION,
      resources: [JSON.stringify({ cwd, program: command.program, args: command.args })],
      source: { type: "tool", messageID: operation.call.messageID, id: operation.call.id },
    }, { signal })
    // Final fence in the same synchronous turn as the spawn.
    signal.throwIfAborted()
    assertCall(operation.call)
    return execute(command, cwd, timeoutSeconds, signal, child => { operation.process = processClosed(child) })
  }
  const nativeTool = createCuratedReadonlyBashTool(cwd, executor, curatedReadonlyFormatter)
  function revoke(): void {
    revoked = true
    if (!lifetime.signal.aborted) lifetime.abort(Error("Read-only producer revoked"))
  }
  return {
    nativeTool,
    assertCurrent,
    get revoked() { return revoked },
    invoke(call: ReadonlyBrokerCall, input: CuratedReadonlyBashInput, callerSignal: AbortSignal): Promise<AgentToolResult<undefined>> {
      // The ticket is owned before any owner callback can reentrantly revoke and join.
      let settle!: () => void
      const ticket = new Promise<void>(resolve => { settle = resolve })
      tickets.add(ticket)
      const controller = new AbortController()
      const signal = controller.signal
      const abort = (reason: unknown) => { if (!signal.aborted) controller.abort(reason) }
      const onCaller = () => abort(callerSignal.reason), onLifetime = () => abort(lifetime.signal.reason)
      callerSignal.addEventListener("abort", onCaller, { once: true })
      lifetime.signal.addEventListener("abort", onLifetime, { once: true })
      if (callerSignal.aborted) onCaller()
      if (lifetime.signal.aborted) onLifetime()
      const operation: Operation = { call: Object.freeze({ ...call }) }
      operations.set(signal, operation)
      let result: Promise<AgentToolResult<undefined>>
      try {
        assertCall(operation.call)
        result = nativeTool.execute(operation.call.id, input, signal)
      } catch (error) { result = Promise.reject(error) }
      const finish = () => {
        callerSignal.removeEventListener("abort", onCaller)
        lifetime.signal.removeEventListener("abort", onLifetime)
        tickets.delete(ticket)
        settle()
      }
      // The ticket settles only after the original callback outcome AND the original process close.
      void result.then(() => operation.process, () => operation.process).then(finish, finish)
      return result
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
export function acquireReadonlyBroker(
  domains: { readonly tool: Pick<ToolDomain, "transform" | "list"> },
  permission: JoinedPermissionApi,
  options: { readonly execute?: ReadonlyExecute } = {},
): Effect.Effect<ReadonlyBrokerOwner, never, Scope.Scope> {
  return Effect.gen(function* () {
    if (!hasJoinedPermissionCancellation(permission)) return yield* Effect.die(Error("Original genuine joined permission owner required"))
    const producers = new Map<string, ReturnType<typeof createReadonlyProducer>>()
    let closed = false
    const info = createReadonlyBrokerToolInfo((call, input, signal) => {
      const producer = closed ? undefined : producers.get(call.sessionID)
      if (!producer) return Promise.reject(new ToolError({ message: FOREIGN_SESSION }))
      return producer.invoke(call, input, signal)
    })
    yield* domains.tool.transform(editor => { editor.add(info) })
    const listed = (yield* domains.tool.list()).filter(tool => tool.name === READONLY_BROKER_TOOL_NAME && tool.options?.namespace === undefined)
    const registered = listed[0]
    if (listed.length !== 1 || !registered?.id) return yield* Effect.die(Error("Read-only broker registration is absent or ambiguous"))
    const hostID = registered.id
    // LIFO: producers are revoked and joined before the SDK registration is removed.
    yield* Effect.addFinalizer(() => Effect.promise(async () => {
      closed = true
      await Promise.allSettled([...producers.values()].map(producer => producer.join()))
    }))
    const owner: ReadonlyBrokerOwner = {
      hostID,
      isBound(sessionID) { const producer = producers.get(sessionID); return !closed && producer !== undefined && !producer.revoked },
      bindChild(input) {
        if (closed) throw Error("Read-only broker is closing")
        if (!input.child || !input.sessionID || !input.agent || !input.cwd) throw Error("Incomplete read-only producer custody")
        if (producers.has(input.sessionID)) throw Error("Read-only producer for this child session is still bound or unjoined")
        input.assertCurrent()
        const producer = createReadonlyProducer({ ...input, permission, ...(options.execute && { execute: options.execute }) })
        producers.set(input.sessionID, producer)
        // Retained until joined, so owner close still joins a revoked producer's in-flight work.
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
