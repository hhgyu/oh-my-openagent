// `tools.task(...)` inside an `eval` cell (S9d). The cell reaches this plugin-owned host tool through the
// codemode bridge (codemode-host-tools.ts); it runs on the main thread with the calling eval call's own
// SDK context and the cell's kernel-tools capability proxy, and hands both to the Native task component,
// which runs the SAME public `task` operation as a direct call (same permission prompts, same grant
// resolution). Only a live eval call can spawn: a detached cell, or a call whose eval already returned,
// has no context and is refused.
//
// The two components are registered separately (eval first), so they meet through this late-bound port.

import type { Result, ToolContext } from "@opencode/plugin/promise/tool"
import type { EvalHostToolResult, OwnedEvalHostTool } from "./codemode-host-tools"
import { nativeTaskInputSchemas } from "./native-task-codecs"

export type EvalTaskHandler = (input: unknown, caller: ToolContext, kernelTools: unknown) => Promise<Result>

export interface EvalTaskPort {
  /** The Native task component attaches once its bridge is ready; the returned detach runs at its close. */
  attach(handler: EvalTaskHandler): () => void
  invoke(input: unknown, caller: ToolContext, kernelTools: unknown): Promise<Result>
}

export function createEvalTaskPort(): EvalTaskPort {
  let current: EvalTaskHandler | undefined
  return Object.freeze({
    attach(handler: EvalTaskHandler) {
      if (current) throw Error("The eval task port already has a Native task component attached")
      current = handler
      return () => {
        if (current === handler) current = undefined
      }
    },
    invoke(input: unknown, caller: ToolContext, kernelTools: unknown) {
      const handler = current
      if (!handler) return Promise.reject(Error("tools.task is unavailable: the Native task component is not running"))
      return handler(input, caller, kernelTools)
    },
  })
}

export const EVAL_TASK_HOST_TOOL_NAME = "task"
const DESCRIPTION =
  'Start a Native task child, exactly like the `task` tool (same input). Pass tools: ["name", ...] to grant the child kernel tools this cell\'s kernel defined with tool(fn).'
/** JSON copy: the catalog is structured-cloned into the worker, and TypeBox keeps symbol keys. */
const PARAMETERS: unknown = JSON.parse(JSON.stringify(nativeTaskInputSchemas.task))

function evalResult(result: Result): EvalHostToolResult {
  const parts =
    typeof result.content === "string" ? [{ type: "text" as const, text: result.content }] : (result.content ?? [])
  const content = parts.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : { type: "text" as const, text: `[file ${part.mime}]` },
  )
  return { content, ...(result.metadata !== undefined && { details: result.metadata }) }
}

export function createEvalTaskHostTool(port: EvalTaskPort): OwnedEvalHostTool {
  return Object.freeze({
    name: EVAL_TASK_HOST_TOOL_NAME,
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(params, call) {
      const caller = call.caller
      if (!caller || caller.sessionID !== call.sessionID) {
        throw Error(
          "tools.task can run only inside a running eval cell; a detached or finished cell cannot start tasks",
        )
      }
      // The eval call's own SDK identity, narrowed to this host call's signal. Task progress is not
      // written onto the eval tool part, whose metadata shows the cell's output.
      const signal = call.signal ? AbortSignal.any([caller.signal, call.signal]) : caller.signal
      const taskCaller: ToolContext = Object.freeze({ ...caller, signal, progress: async () => {} })
      return evalResult(await port.invoke(params, taskCaller, call.kernelTools))
    },
  })
}
