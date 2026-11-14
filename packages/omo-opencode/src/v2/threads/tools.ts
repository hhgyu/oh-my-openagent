import { randomUUID } from "node:crypto"
import type { Static } from "typebox"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import {
  parseThreadParams,
  threadToolParamSchemas,
  type ThreadToolName,
  type ThreadToolResult,
} from "@oh-my-opencode/thread-core/contracts"
import { isLockWaitExceeded } from "@oh-my-opencode/thread-core/gateway/lock-wait"
import type { GatewayRelay } from "@oh-my-opencode/thread-core/gateway/relay"
import type { GatewayStore } from "@oh-my-opencode/thread-core/gateway/store"
import type { DeliveryTransport } from "@oh-my-opencode/thread-core/gateway/transport"
import { THREAD_FAMILY_PROMPT_GUIDELINES, THREAD_TOOL_METADATA } from "@oh-my-opencode/thread-core/metadata"
import { createRelayToolBodies, RELAY_TOOL_NAMES, type RelayToolName } from "@oh-my-opencode/thread-core/relay-tools"
import { isReplyToConsumedSender } from "@oh-my-opencode/thread-core/reply-allowance"
import type { RunContext } from "@oh-my-opencode/thread-core/run-context"
import { failure } from "@oh-my-opencode/thread-core/tool-result"
import type { EvalHostToolResult, OwnedEvalHostTool, OwnedEvalHostToolCall } from "../tools/codemode-host-tools"
import { resolveTarget } from "@oh-my-opencode/thread-core/addressing"
import { withToolReceipt } from "./receipts"
import { callerContextMissing, createSessionToolBodies } from "./session-tools"
import type { ThreadCall, ThreadSurface } from "./surface"

export type ThreadCallFactory = {
  readonly store: GatewayStore
  readonly relay: GatewayRelay
  readonly surface: ThreadSurface
  readonly run: (sessionID: string) => RunContext
  readonly armCompletion: (durableId: string, armSeq: number) => void
  readonly transport: (workspaceRoot: () => string) => DeliveryTransport
}

const REPLY_METADATA_KEY = "omoThreadReplyAllowed"
const SESSION_TOOL_NAMES = [
  "thread_create",
  "thread_list",
  "thread_read",
  "thread_send",
  "thread_interrupt",
  "thread_close",
  "thread_handoff",
  "thread_rename",
  "thread_set_model",
  "thread_set_reasoning",
] as const
type SessionToolName = (typeof SESSION_TOOL_NAMES)[number]
const UNRECEIPTED: ReadonlySet<ThreadToolName> = new Set(["thread_send", "thread_handoff"])

/** Carries a permission verdict past the tool's failure mapping: OpenCode needs its own error to end the step. */
class PermissionVerdict extends Error {
  constructor(readonly verdict: unknown) {
    super("thread_send permission verdict")
  }
}

function output(result: ThreadToolResult): EvalHostToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result) }], details: { result } }
}

function description(name: ThreadToolName): string {
  const entry = THREAD_TOOL_METADATA.find((candidate) => candidate.name === name)
  if (entry === undefined) throw Error(`missing thread metadata for ${name}`)
  // The family guideline is Native's one system-prompt line; a cell reads it on thread_list, where every flow starts.
  return name === "thread_list" ? `${entry.description}. ${THREAD_FAMILY_PROMPT_GUIDELINES}` : entry.description
}

function threadFailure(error: unknown): ThreadToolResult {
  const message = error instanceof Error ? error.message : String(error)
  if (isLockWaitExceeded(error))
    return failure(
      "overloaded",
      `The gateway store is locked by another process: ${message}`,
      "Wait a few seconds, then retry the call.",
    )
  if (message.startsWith("host_unavailable:"))
    return failure(
      "host_unavailable",
      `The thread host is unavailable at ${message.slice("host_unavailable:".length)}.`,
      "Retry when that OpenCode server is running.",
    )
  return failure(
    "internal_error",
    `Thread operation failed: ${message}`,
    "Call thread_list and retry after checking the target.",
  )
}

export function createThreadHostTools(factory: ThreadCallFactory): OwnedEvalHostTool[] {
  const sessionBodies = createSessionToolBodies(factory.surface)

  function threadCall(callerId: string, caller: ToolContext | undefined): ThreadCall {
    let root: Promise<string> | undefined
    let rootValue = ""
    const workspaceRoot = () =>
      (root ??= factory.surface.host.session.get({ sessionID: callerId }).then((info) => {
        rootValue = info.location.directory
        return rootValue
      }))
    const run = factory.run(callerId)
    const replyEvidence = {
      callerReplyTargets: () => [...run.replyTo],
      callerReplySenders: () => [...run.replySenders],
    }
    return {
      callerId,
      callId: randomUUID(),
      workspaceRoot,
      replyEvidence,
      async send(request) {
        if (caller === undefined) return callerContextMissing()
        await factory.surface.host.permission
          .assert({
            sessionID: callerId as never,
            agent: caller.agent,
            action: "thread_send",
            resources: [request.thread_id],
            save: [request.thread_id],
            metadata: { [REPLY_METADATA_KEY]: isReplyToConsumedSender(replyEvidence, request.thread_id) },
            source: { type: "tool", messageID: String(caller.messageID), id: String(caller.id) },
          })
          .catch((verdict: unknown) => {
            throw new PermissionVerdict(verdict)
          })
        await workspaceRoot()
        const self = await factory.surface.host.session.get({ sessionID: callerId })
        const name = self.title?.trim()
        return (await factory
          .transport(() => rootValue)
          .deliver({
            sender: {
              kind: "session",
              durable_id: callerId,
              ...(name === undefined || name === "" ? {} : { name }),
              ...(run.turn === 0 ? {} : { turn_id: `turn-${run.turn}` }),
              ...(run.cause === undefined ? {} : { cause_delivery_id: run.cause }),
            },
            caller_id: callerId,
            target: { kind: "local", thread_id: request.thread_id, ...(request.all_scope ? { all_scope: true } : {}) },
            text: request.text,
            mode: request.mode,
            ...(request.expected_turn_id === undefined ? {} : { expected_turn_id: request.expected_turn_id }),
            idempotency_key: request.idempotency_key,
            args: request.args,
            ...(run.chainHop > 0 ? { inbound_hop: run.chainHop } : {}),
          })) as Awaited<ReturnType<ThreadCall["send"]>>
      },
    }
  }

  async function runSessionTool(name: SessionToolName, params: unknown, call: OwnedEvalHostToolCall) {
    const parsed = parseThreadParams(threadToolParamSchemas[name], params)
    if (parsed.kind === "error") return output(parsed as ThreadToolResult)
    const value = parsed.value as Static<(typeof threadToolParamSchemas)[typeof name]>
    const context = threadCall(call.sessionID, call.caller)
    const body = () =>
      (sessionBodies[name] as (value: unknown, call: ThreadCall) => Promise<ThreadToolResult>)(value, context)
    if (UNRECEIPTED.has(name)) {
      try {
        return output(await body())
      } catch (error) {
        if (error instanceof PermissionVerdict) throw error.verdict
        return output(threadFailure(error))
      }
    }
    const explicit =
      "idempotency_key" in value ? (value as { idempotency_key?: string }).idempotency_key?.trim() : undefined
    const scope = {
      principal: `session:${call.sessionID}`,
      operation: name,
      idempotency_key: explicit !== undefined && explicit.length > 0 ? explicit : `call:${context.callId}`,
    }
    try {
      return output(await withToolReceipt(factory.store, scope, value, body))
    } catch (error) {
      return output(threadFailure(error))
    }
  }

  async function runRelayTool(name: RelayToolName, params: unknown, call: OwnedEvalHostToolCall) {
    const parsed = parseThreadParams(threadToolParamSchemas[name], params)
    if (parsed.kind === "error") return output(parsed as ThreadToolResult)
    const run = factory.run(call.sessionID)
    const context = threadCall(call.sessionID, call.caller)
    const bodies = createRelayToolBodies({
      relay: factory.relay,
      resolveSession: async (address, _callerId, allScope) => {
        const resolved = resolveTarget(await factory.surface.entries(), address, {
          all_scope: allScope,
          callerWorkspaceRoot: await context.workspaceRoot(),
        })
        if (resolved.kind === "error") return failure(resolved.code, resolved.message, resolved.next_action)
        return { id: resolved.entry.thread_id }
      },
      latestCompletionArm: (durableId) => factory.store.latestCompletionArm(durableId),
      callerRunDeliveries: () => [...run.consumed],
      callerRunHasLocalInput: () => run.local,
      onCompletionArmed: factory.armCompletion,
    })
    const value = parsed.value as Static<(typeof threadToolParamSchemas)[typeof name]>
    const explicit =
      "idempotency_key" in value ? (value as { idempotency_key?: string }).idempotency_key?.trim() : undefined
    try {
      return output(
        await (bodies[name] as (call: { value: unknown; callerId: string; key: string }) => Promise<ThreadToolResult>)({
          value,
          callerId: call.sessionID,
          key: explicit !== undefined && explicit.length > 0 ? explicit : `call:${context.callId}`,
        }),
      )
    } catch (error) {
      return output(threadFailure(error))
    }
  }

  const tool = (name: ThreadToolName, execute: OwnedEvalHostTool["execute"]): OwnedEvalHostTool =>
    Object.freeze({
      name,
      description: description(name),
      /** JSON copy: the catalog is structured-cloned into the codemode worker, and TypeBox keeps symbol keys. */
      parameters: JSON.parse(JSON.stringify(threadToolParamSchemas[name])) as unknown,
      execute,
    })

  return [
    ...SESSION_TOOL_NAMES.map((name) => tool(name, (params, call) => runSessionTool(name, params, call))),
    ...RELAY_TOOL_NAMES.map((name) => tool(name, (params, call) => runRelayTool(name, params, call))),
  ]
}
