// senpi tool results and errors of the Native `eval` tool, as they arrive from the codemode worker,
// adapted to the OpenCode SDK shapes.

import { Error as ToolError, type Result } from "@opencode/plugin/promise/tool"

const METADATA_DETAILS_MAX_BYTES = 64 * 1024

function jsonDetails(details: unknown): unknown {
  if (details === undefined) return undefined
  try {
    const text = JSON.stringify(details)
    if (text === undefined) return undefined
    return text.length > METADATA_DETAILS_MAX_BYTES ? { truncated: true, bytes: text.length } : JSON.parse(text)
  } catch {
    return { unserializable: true }
  }
}

/** senpi `AgentToolResult` of a cell to the SDK result: text stays text, images become data-URI files,
 * `isError` becomes a tool error the model reads. */
export function adaptEvalResult(value: unknown, metadataKey = "nativeEval"): Result {
  if (!value || typeof value !== "object" || !Array.isArray((value as { content?: unknown }).content))
    throw Error("eval returned no content")
  const result = value as { content: unknown[]; details?: unknown; isError?: unknown }
  type Part =
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "file"; readonly uri: string; readonly mime: string }
  const content = result.content.flatMap((part): Part[] => {
    if (!part || typeof part !== "object") return []
    const item = part as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }
    if (item.type === "text" && typeof item.text === "string") return [{ type: "text", text: item.text }]
    if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      return [{ type: "file", uri: `data:${item.mimeType};base64,${item.data}`, mime: item.mimeType }]
    }
    return []
  })
  const details = jsonDetails(result.details)
  const metadata = details === undefined ? {} : { [metadataKey]: details }
  if (result.isError === true) {
    throw new ToolError({
      message: content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") || "eval cell failed",
      metadata,
    })
  }
  return { content, metadata }
}

export function progressText(update: unknown): string | undefined {
  const content = (update as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content)) return undefined
  const text = content
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n")
  return text ? text.slice(-2048) : undefined
}

export function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) return error
  return new ToolError({ message: (error instanceof Error ? error.message : String(error)) || "eval failed", error })
}
