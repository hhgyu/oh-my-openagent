import type { Static } from "typebox"

import {
  parseThreadParams,
  threadToolParamSchemas,
  type ThreadToolName,
  type ThreadToolResult,
} from "@oh-my-opencode/thread-core/contracts"
import { gatewaySchemaRefusal, type ThreadErrorCode } from "@oh-my-opencode/thread-core/errors"
import type { GatewayRelay } from "@oh-my-opencode/thread-core/gateway/relay"
import { metadata, output, type AnyTool, type ToolOutput } from "./internals"
import {
  createRelayToolBodies,
  RELAY_TOOL_NAMES,
  type RelayToolCall,
  type RelayToolName,
} from "@oh-my-opencode/thread-core/relay-tools"
import type { ThreadToolSurfaceOptions } from "./ports"

export type RelayToolsContext = {
  readonly options: ThreadToolSurfaceOptions
  readonly relay: GatewayRelay
  readonly failure: (
    code: ThreadErrorCode,
    message: string,
    next: string,
    details?: Readonly<Record<string, unknown>>,
  ) => ThreadToolResult
}

type Call<T extends RelayToolName> = RelayToolCall<T>

/**
 * The four relay tools. They run over the gateway store alone and take no host listing, so a
 * terminal with no host running can still report and read its outbox. Binding a chat thread is
 * not a session tool: the gateway writes, moves and expires bindings through the relay SDK as its
 * own principal. Mutations are idempotent per `(caller, tool, key)` inside the store transaction
 * that performs them.
 */
export function createRelayTools(context: RelayToolsContext): AnyTool[] {
  const { options, relay, failure } = context

  async function run<T extends RelayToolName>(
    name: T,
    callId: string,
    args: unknown,
    ectx: unknown,
    body: (call: Call<T>) => Promise<ThreadToolResult>,
  ): Promise<ToolOutput> {
    const callerId =
      (ectx as { sessionManager?: { getSessionId?: () => string } } | undefined)?.sessionManager?.getSessionId?.() ??
      options.callerSessionId()
    const parsed = parseThreadParams(threadToolParamSchemas[name], args)
    if (parsed.kind === "error") return output(parsed as ThreadToolResult)
    const value = parsed.value as Static<(typeof threadToolParamSchemas)[T]>
    const explicit =
      "idempotency_key" in value ? (value as { idempotency_key?: string }).idempotency_key?.trim() : undefined
    try {
      return output(
        await body({
          value,
          callerId,
          key: explicit !== undefined && explicit.length > 0 ? explicit : `call:${callId}`,
        }),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const schema = gatewaySchemaRefusal(error)
      if (schema !== undefined) return output({ kind: "error", error: schema })
      if (message.startsWith("host_unavailable:"))
        return output(
          failure(
            "host_unavailable",
            `The thread host is unavailable at ${message.slice("host_unavailable:".length)}.`,
            "Retry when the session's host is running, or address the calling session with self.",
          ),
        )
      return output(
        failure(
          "internal_error",
          `Thread relay operation failed: ${message}`,
          "Retry; thread_report (tool.thread_report() in an eval cell) without binding_id uses the chat binding the gateway keeps for this session.",
        ),
      )
    }
  }

  const bodies = createRelayToolBodies({
    relay,
    latestCompletionArm: (durableId) => options.store.latestCompletionArm(durableId),
    ...(options.callerRunDeliveries === undefined ? {} : { callerRunDeliveries: options.callerRunDeliveries }),
    ...(options.callerRunHasLocalInput === undefined ? {} : { callerRunHasLocalInput: options.callerRunHasLocalInput }),
    ...(options.onCompletionArmed === undefined ? {} : { onCompletionArmed: options.onCompletionArmed }),
  })

  const tool = <T extends RelayToolName>(name: T, body: (call: Call<T>) => Promise<ThreadToolResult>): AnyTool => ({
    ...metadata(name as ThreadToolName),
    parameters: threadToolParamSchemas[name],
    execute: (id: string, args: unknown, _signal: unknown, _onUpdate: unknown, ectx: unknown) =>
      run(name, id, args, ectx, body),
  })

  return RELAY_TOOL_NAMES.map((name) =>
    tool(name, bodies[name] as (call: Call<RelayToolName>) => Promise<ThreadToolResult>),
  )
}
