import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Info } from "@opencode/plugin/promise/tool"
import { createLspRuntime, type LspRuntimeOptions } from "./runtime"
import { LSP_TOOL_NAMES, lspSchemas, type LspToolName } from "./schemas"
export { LSP_TOOL_NAMES, lspSchemas } from "./schemas"
export { createLspRuntime, LspToolFailure, type LspMutation, type LspRuntimeOptions } from "./runtime"

const descriptions: Record<LspToolName, string> = {
  lsp_diagnostics: "Get language server errors/warnings/hints for a file or directory. Bun TypeScript directories use bun check and optional bun lint. Severity defaults to all.",
  lsp_goto_definition: "Jump to symbol definitions. line is 1-based; character is 0-based.",
  lsp_find_references: "Find symbol references across the workspace; includeDeclaration defaults to true. Displays at most 200.",
  lsp_symbols: "Get document symbols or search workspace symbols. Workspace scope requires query; limit defaults to and is capped at 200.",
  lsp_prepare_rename: "Check whether a symbol can be renamed before calling lsp_rename. line is 1-based; character is 0-based.",
  lsp_rename: "Rename a symbol across the workspace, applying all authorized file changes. line is 1-based; character is 0-based.",
}
export interface LspComponentOptions extends Omit<LspRuntimeOptions, "directory" | "permission"> {
  readonly enabled?: boolean
}
/** Explicit composition only. Root registers this factory after its own QA gate. */
export function createLspComponent(options: LspComponentOptions) {
  return {
    async register(context: Pick<Plugin.Context, "tool" | "permission" | "location">): Promise<() => Promise<void>> {
      if (options.enabled === false) return async () => {}
      const runtime = createLspRuntime({ ...options, directory: context.location.directory, permission: context.permission })
      let registration: Awaited<ReturnType<typeof context.tool.transform>>
      try {
        registration = await context.tool.transform(editor => {
          for (const name of LSP_TOOL_NAMES) {
            editor.add({ name, description: descriptions[name], input: lspSchemas[name], options: { codemode: false }, execute: (input: unknown, caller) => runtime.execute(name, input, caller) } as Info)
          }
        })
      } catch (error) { await runtime.dispose(); throw error }
      let disposed = false
      return async () => {
        if (disposed) return
        disposed = true
        try { await runtime.dispose() } finally { await registration.dispose() }
      }
    },
  }
}
