import type { AgentToolResult } from "@code-yeongyu/senpi"
import { createCuratedReadonlyBashTool, CuratedReadonlyBashParams, CuratedReadonlyCommandError, type CuratedReadonlyBashInput } from "@oh-my-opencode/senpi-task/task-operations"
import { curatedReadonlyFormatter } from "@oh-my-opencode/utils/curated-readonly-presentation"
import type { ToolDomain } from "@opencode/plugin/effect/tool"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { Effect } from "effect"
import { Compile } from "typebox/compile"
import { adaptNativeTaskResult } from "./native-task-result"

type ToolInfo = Awaited<Effect.Success<ReturnType<ToolDomain["list"]>>>[number]

/** Dedicated SDK capability. The Native original name stays `bash` in its binding slot; this tool
 * never masquerades as stock shell, so shell or webfetch rules do not apply to it implicitly. */
export const READONLY_BROKER_TOOL_NAME = "omo_native_readonly"
/** Whole-tool filtering and per-invocation `permission.assert` both use this action. */
export const READONLY_BROKER_PERMISSION = "omo_native_readonly"

/** Immutable actual SDK call source, captured before any owner callback runs. */
export interface ReadonlyBrokerCall {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
}
type ReadonlyBrokerDispatch = (call: ReadonlyBrokerCall, input: CuratedReadonlyBashInput, signal: AbortSignal) => Promise<AgentToolResult<undefined>>

// The ORIGINAL Native description text; its executor is never invoked.
const native = createCuratedReadonlyBashTool(".", () => Promise.reject(Error("Description template only")), curatedReadonlyFormatter)
const checkInput = Compile(CuratedReadonlyBashParams)

/** Typed SDK failures and broker policy refusals stay tool errors with their original text. */
function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) return error
  if (error instanceof CuratedReadonlyCommandError) return new ToolError({ message: error.message, error })
  return new ToolError({ message: error instanceof Error ? error.message : "Read-only broker request failed", error })
}

/** Registration DATA only. `dispatch` resolves the producer bound to the actual caller session. */
export function createReadonlyBrokerToolInfo(dispatch: ReadonlyBrokerDispatch): Omit<ToolInfo, "id"> {
  return {
    name: READONLY_BROKER_TOOL_NAME,
    description: native.description,
    // The SAME original typebox schema object; decoding is checked below, never assumed.
    input: CuratedReadonlyBashParams as unknown as ToolInfo["input"],
    options: { codemode: false, permission: READONLY_BROKER_PERMISSION },
    execute: (input, context) => Effect.tryPromise({
      try: async signal => {
        if (!checkInput.Check(input)) throw new ToolError({ message: "Invalid read-only broker input" })
        const call: ReadonlyBrokerCall = Object.freeze({ sessionID: context.sessionID, agent: context.agent, messageID: context.messageID, id: context.id })
        return adaptNativeTaskResult(await dispatch(call, input, signal))
      },
      catch: toToolError,
    }),
  }
}
