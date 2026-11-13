// The dedicated SDK tool through which a Native task child calls the kernel tools its parent's `eval` cell
// granted (S9d). Native installs one child tool per granted descriptor; V2 registers ONE dispatcher,
// `omo_kernel_tool` (`name` + `args`), because OpenCode tools are registered for the whole server, not per
// child. The context hook (native-task component) hides it from every session without a live binding
// and rewrites its description for a bound child to list exactly the tools that child was granted.

import type { KernelToolDescriptor } from "@oh-my-opencode/senpi-task"
import type { ToolDomain } from "@opencode/plugin/effect/tool"
import { Error as ToolError, type Result } from "@opencode/plugin/promise/tool"
import { Effect } from "effect"
import { Type } from "typebox"
import { Compile } from "typebox/compile"
import type { KernelToolOutcome } from "./kernel-tool-proxy"

type ToolInfo = Awaited<Effect.Success<ReturnType<ToolDomain["list"]>>>[number]

export const KERNEL_TOOL_TOOL_NAME = "omo_kernel_tool"
/** Whole-tool filtering uses this action: a user deny rule removes the tool from every child. */
export const KERNEL_TOOL_PERMISSION = "omo_kernel_tool"

/** Immutable actual SDK call source, captured before any owner callback runs. */
export interface KernelToolCall {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
}
export interface KernelToolCallInput {
  readonly name: string
  readonly args?: unknown
}
type KernelToolDispatch = (
  call: KernelToolCall,
  input: KernelToolCallInput,
  signal: AbortSignal,
) => Promise<KernelToolOutcome>

const KernelToolParams = Type.Object({
  name: Type.String({
    description: "Name of a parent kernel tool granted to you (listed in this tool's description).",
  }),
  args: Type.Optional(Type.Unknown({ description: "Arguments for that tool, matching its input schema." })),
})
const checkInput = Compile(KernelToolParams)

const BASE_DESCRIPTION =
  "Call a tool your parent session defined in its eval kernel (JavaScript tool(fn) or Python @tool) and granted to you when it started this task."

/** The model-facing description and input of the dispatcher for one bound child. */
export function kernelToolSurface(descriptors: readonly KernelToolDescriptor[]): {
  readonly description: string
  readonly input: unknown
} {
  const lines = descriptors.map(
    (descriptor) =>
      `- ${descriptor.name} (${descriptor.language}): ${descriptor.description || `Parent-defined tool ${descriptor.name}.`} args schema: ${JSON.stringify(descriptor.input_schema)}`,
  )
  return {
    description: [
      BASE_DESCRIPTION,
      "Pass `name` and `args`. The result is JSON: { kernel_tool, value } or { kernel_tool, error: { code, message } }.",
      "Granted tools:",
      ...lines,
    ].join("\n"),
    input: KernelToolParams,
  }
}

function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) return error
  return new ToolError({ message: error instanceof Error ? error.message : "Kernel tool call failed", error })
}

/** Registration DATA only. `dispatch` resolves the producer bound to the actual caller session. */
export function createKernelToolInfo(dispatch: KernelToolDispatch): Omit<ToolInfo, "id"> {
  return {
    name: KERNEL_TOOL_TOOL_NAME,
    description: BASE_DESCRIPTION,
    input: KernelToolParams as unknown as ToolInfo["input"],
    options: { codemode: false, permission: KERNEL_TOOL_PERMISSION },
    execute: (input, context) =>
      Effect.tryPromise({
        try: async (signal): Promise<Result> => {
          if (!checkInput.Check(input))
            throw new ToolError({ message: "Invalid kernel tool input: pass { name, args }" })
          const call: KernelToolCall = Object.freeze({
            sessionID: context.sessionID,
            agent: context.agent,
            messageID: context.messageID,
            id: context.id,
          })
          const outcome = await dispatch(call, input, signal)
          const metadata = { kernelTool: { ...outcome.details } }
          if (outcome.isError) throw new ToolError({ message: outcome.text, metadata })
          return { content: [{ type: "text", text: outcome.text }], metadata }
        },
        catch: toToolError,
      }),
  }
}
