import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Info, Result, ToolContext } from "@opencode/plugin/promise/tool"
import { createLspRuntime, type LspRuntimeOptions, type LspFormatResult, LspToolFailure } from "./runtime"
import { LSP_TOOL_NAMES, lspSchemas, type LspToolName } from "./schemas"
export { LspToolFailure, type LspMutation, type LspRuntimeOptions, type LspFormatResult } from "./runtime"

const descriptions: Record<LspToolName, string> = {
  lsp_diagnostics:
    "Get language server errors/warnings/hints for a file or directory. Bun TypeScript directories use bun check and optional bun lint. Severity defaults to all.",
  lsp_goto_definition: "Jump to symbol definitions. line is 1-based; character is 0-based.",
  lsp_find_references:
    "Find symbol references across the workspace; includeDeclaration defaults to true. Displays at most 200.",
  lsp_symbols:
    "Get document symbols or search workspace symbols. Workspace scope requires query; limit defaults to and is capped at 200.",
  lsp_prepare_rename:
    "Check whether a symbol can be renamed before calling lsp_rename. line is 1-based; character is 0-based.",
  lsp_rename:
    "Rename a symbol across the workspace, applying all authorized file changes. line is 1-based; character is 0-based.",
}
export interface LspComponentOptions extends Omit<LspRuntimeOptions, "directory" | "permission"> {
  readonly enabled?: boolean
}
/** Explicit composition only. Root registers this factory after its own QA gate. */
export function createLspComponent(options: LspComponentOptions) {
  let phase: "new" | "registering" | "active" | "closed" = "new"
  let runtime: ReturnType<typeof createLspRuntime> | undefined
  return {
    /** Internal formatter port; not registered as a model tool. Use after original execute resolves. */
    format(filePath: string, caller: ToolContext): Promise<LspFormatResult> {
      if (phase === "closed") return Promise.reject(new LspToolFailure("disposed", "LSP component disposed"))
      if (options.enabled === false)
        return Promise.resolve({
          details: { status: "unavailable", reason: "disabled", linesAdded: 0, linesRemoved: 0 },
        })
      if (phase !== "active" || !runtime)
        return Promise.reject(new Error("LSP component must be registered before formatting"))
      return runtime.format(filePath, caller)
    },
    /** Post-original diagnostics port bound to this component's owned closure, never a catalog lookup. */
    diagnostics(filePath: string, caller: ToolContext): Promise<Result> {
      if (phase === "closed") return Promise.reject(new LspToolFailure("disposed", "LSP component disposed"))
      if (options.enabled === false)
        return Promise.resolve({
          content: "LSP diagnostics unavailable: component disabled",
          metadata: {
            isError: true,
            status: "unavailable",
            errorKind: "missing_dependency",
            reason: "disabled",
            filePath,
            severity: "error",
          },
        })
      if (phase !== "active" || !runtime)
        return Promise.reject(new Error("LSP component must be registered before diagnostics"))
      return runtime.execute("lsp_diagnostics", { filePath, severity: "error" }, caller)
    },
    async register(context: Pick<Plugin.Context, "tool" | "permission" | "location">): Promise<() => Promise<void>> {
      if (phase !== "new") throw new Error("LSP component is already registered or disposed")
      phase = "registering"
      if (options.enabled === false) {
        phase = "active"
        return async () => {
          phase = "closed"
        }
      }
      let ownedRuntime: ReturnType<typeof createLspRuntime>
      try {
        ownedRuntime = createLspRuntime({
          ...options,
          directory: context.location.directory,
          permission: context.permission,
        })
      } catch (error) {
        phase = "closed"
        throw error
      }
      runtime = ownedRuntime
      let registration: Awaited<ReturnType<typeof context.tool.transform>>
      try {
        registration = await context.tool.transform((editor) => {
          for (const name of LSP_TOOL_NAMES) {
            editor.add({
              name,
              description: descriptions[name],
              input: lspSchemas[name],
              options: { codemode: false },
              execute: (input: unknown, caller) => ownedRuntime.execute(name, input, caller),
            } as Info)
          }
        })
      } catch (error) {
        phase = "closed"
        await ownedRuntime.dispose()
        throw error
      }
      phase = "active"
      let disposal: Promise<void> | undefined
      return () => {
        if (disposal) return disposal
        phase = "closed"
        disposal = (async () => {
          try {
            await ownedRuntime.dispose()
          } finally {
            await registration.dispose()
          }
        })()
        return disposal
      }
    },
  }
}
