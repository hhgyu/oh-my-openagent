import type { ToolDomain } from "@opencode/plugin/effect/tool"
import { Error as ToolError, type Result } from "@opencode/plugin/promise/tool"
import { Effect } from "effect"
import { Type } from "typebox"
import { Compile } from "typebox/compile"
import { NATIVE_LS_DESCRIPTION, type NativeLsInput, type NativeLsOutput } from "./codemode-readonly-ls"

type ToolInfo = Awaited<Effect.Success<ReturnType<ToolDomain["list"]>>>[number]

/** The Native child custom tool this counterpart stands for: `ls`, the read-only directory listing
 * the curated Native agents (explore, librarian, reviewers, qa-executor) allow. */
export const CODEMODE_READONLY_NATIVE_NAME = "ls"
/** Dedicated SDK capability. It never masquerades as a stock tool, so stock rules do not apply. */
export const CODEMODE_READONLY_TOOL_NAME = "omo_native_ls"
/** Whole-tool filtering and per-invocation `permission.assert` both use this action. */
export const CODEMODE_READONLY_PERMISSION = "omo_native_ls"

/** Immutable actual SDK call source, captured before any owner callback runs. */
export interface CodemodeReadonlyCall {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
}
type CodemodeReadonlyDispatch = (
  call: CodemodeReadonlyCall,
  input: NativeLsInput,
  signal: AbortSignal,
) => Promise<NativeLsOutput>

// The SAME parameter shape and descriptions as the Native `ls` schema.
const LsParams = Type.Object({
  path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
})
const checkInput = Compile(LsParams)

function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) return error
  return new ToolError({ message: error instanceof Error ? error.message : "Directory listing failed", error })
}

/** Registration DATA only. `codemode: true`: on OpenCode 2.2.6 the tool is reachable only through
 * the CodeMode `execute` transport, whose inner calls still run this tool's own (guarded) execute.
 * `dispatch` resolves the producer bound to the actual caller session. */
export function createCodemodeReadonlyToolInfo(dispatch: CodemodeReadonlyDispatch): Omit<ToolInfo, "id"> {
  return {
    name: CODEMODE_READONLY_TOOL_NAME,
    description: NATIVE_LS_DESCRIPTION,
    input: LsParams as unknown as ToolInfo["input"],
    options: { codemode: true, permission: CODEMODE_READONLY_PERMISSION },
    execute: (input, context) =>
      Effect.tryPromise({
        try: async (signal): Promise<Result> => {
          if (!checkInput.Check(input)) throw new ToolError({ message: "Invalid directory listing input" })
          const call: CodemodeReadonlyCall = Object.freeze({
            sessionID: context.sessionID,
            agent: context.agent,
            messageID: context.messageID,
            id: context.id,
          })
          const output = await dispatch(call, input, signal)
          return {
            content: [{ type: "text", text: output.text }],
            ...(output.details && { metadata: { ...output.details } }),
          }
        },
        catch: toToolError,
      }),
  }
}
