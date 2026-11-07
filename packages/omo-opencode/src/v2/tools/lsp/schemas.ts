import { z } from "zod"

const filePath = z.string().min(1).refine(value => !value.includes("\0"), "NUL in path")
const position = { filePath, line: z.number().int().min(1), character: z.number().int().min(0) }
export const lspSchemas = {
  lsp_diagnostics: z.object({ filePath, severity: z.enum(["error", "warning", "information", "hint", "all"]).default("all") }).strict(),
  lsp_goto_definition: z.object(position).strict(),
  lsp_find_references: z.object({ ...position, includeDeclaration: z.boolean().default(true) }).strict(),
  lsp_symbols: z.object({ filePath, scope: z.enum(["document", "workspace"]), query: z.string().optional(), limit: z.number().int().min(1).default(200).transform(value => Math.min(value, 200)) }).strict().refine(value => value.scope !== "workspace" || !!value.query, "query is required for workspace scope"),
  lsp_prepare_rename: z.object(position).strict(),
  lsp_rename: z.object({ ...position, newName: z.string().min(1) }).strict(),
} as const
export const LSP_TOOL_NAMES = Object.freeze(Object.keys(lspSchemas) as LspToolName[])
export type LspToolName = keyof typeof lspSchemas
export type LspInput = z.infer<(typeof lspSchemas)[LspToolName]>
