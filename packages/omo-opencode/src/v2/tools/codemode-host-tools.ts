// The `executeTool` / `listTools` bridge an eval session hands to senpi-codemode. A cell's `tools.X(...)`
// call reaches ONLY tools this plugin registered here; any other name (including every OpenCode host
// tool) is refused, so a cell can never borrow a host tool's permissions or bypass its prompts.
//
// The JS worker kernel runs each cell inside `kernelToolsStorage.run(capability)` on codemode's OWN
// senpi copy. The capability is read synchronously at call entry and handed to the owned executor
// explicitly: V2's bundled senpi code has a separate storage instance and would never see it (S9d
// binds kernel tools through this value).

import type { ToolContext } from "@opencode/plugin/promise/tool"

/** senpi `AgentToolResult` shape the codemode bridge expects back from a host tool. */
export interface EvalHostToolResult {
  readonly content: readonly ({ readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string })[]
  readonly details?: unknown
}

export interface OwnedEvalHostToolCall {
  readonly sessionID: string
  readonly signal?: AbortSignal
  readonly onUpdate?: (update: unknown) => void
  /** The live kernel-tools capability of the calling JS cell; undefined for isolated or non-JS cells. */
  readonly kernelTools?: unknown
  /** The eval call whose cell made this call (worker side); absent for a detached cell. */
  readonly toolCallId?: string
  /** Main thread only: that eval call's own live SDK context, resolved by the `eval` tool. */
  readonly caller?: ToolContext
}

export interface OwnedEvalHostTool {
  readonly name: string
  readonly description: string
  /** JSON Schema of the parameters, shown to the cell's tool prelude. */
  readonly parameters: unknown
  execute(params: unknown, call: OwnedEvalHostToolCall): Promise<EvalHostToolResult>
}

export class EvalHostToolRefusedError extends Error {
  override readonly name = "EvalHostToolRefusedError"
  readonly code = "eval_host_tool_refused"
}

type ExecuteOptions = { readonly signal?: AbortSignal; readonly onUpdate?: (update: unknown) => void; readonly activateInactiveTool?: boolean }

export interface OwnedHostToolBridge {
  readonly executeTool: ((name: string, params: unknown, options?: ExecuteOptions) => Promise<EvalHostToolResult>) & { readonly isToolAvailable: (name: string) => boolean }
  readonly listTools: () => readonly { readonly name: string; readonly description: string; readonly parameters: unknown }[]
}

export function createOwnedHostToolBridge(input: {
  readonly sessionID: string
  readonly tools: readonly OwnedEvalHostTool[]
  readonly readKernelTools: () => unknown
}): OwnedHostToolBridge {
  const owned = new Map<string, OwnedEvalHostTool>()
  for (const tool of input.tools) {
    if (owned.has(tool.name)) throw Error(`Duplicate eval host tool ${tool.name}`)
    owned.set(tool.name, tool)
  }
  const catalog = Object.freeze([...owned.values()].map(tool => Object.freeze({ name: tool.name, description: tool.description, parameters: tool.parameters })))
  const executeTool = (name: string, params: unknown, options: ExecuteOptions = {}): Promise<EvalHostToolResult> => {
    // Read BEFORE any await: the capability lives only in the cell's synchronous async context.
    const kernelTools = input.readKernelTools()
    const tool = owned.get(name)
    if (!tool) {
      return Promise.reject(new EvalHostToolRefusedError(`Tool "${name}" is not available inside an OpenCode eval cell. Only oh-my-openagent eval host tools can be called from a cell${owned.size ? ` (${[...owned.keys()].join(", ")})` : ""}; call OpenCode tools directly instead.`))
    }
    return tool.execute(params, {
      sessionID: input.sessionID,
      ...(options.signal && { signal: options.signal }),
      ...(options.onUpdate && { onUpdate: options.onUpdate }),
      ...(kernelTools !== undefined && { kernelTools }),
    })
  }
  return { executeTool: Object.assign(executeTool, { isToolAvailable: (name: string) => owned.has(name) }), listTools: () => catalog }
}
