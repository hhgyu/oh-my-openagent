import type { Result } from "@opencode/plugin/promise/tool"
import type { ToolResultContentBlock, ToolResultContextLike, ToolResultEventLike } from "@oh-my-opencode/comment-checker-core"

export interface CompletedToolCall {
  readonly tool: string
  readonly sessionID: string
  readonly id: string
  readonly input: unknown
  readonly result: Result
}

export interface CheckerToolResult {
  readonly event: ToolResultEventLike
  readonly context: ToolResultContextLike & { readonly sessionManager: { getSessionId(): string } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** OpenCode 2 ships `patch` (patchText); the checker core names the same mutation `apply_patch`. */
function checkerToolName(tool: string): string {
  return tool === "patch" ? "apply_patch" : tool
}

/** OpenCode 2 edit/write use filePath/oldString/newString; the checker core reads path/old_string/new_string. */
function checkerInput(input: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...input }
  if (normalized.path === undefined && typeof input.filePath === "string") normalized.path = input.filePath
  if (normalized.old_string === undefined && typeof input.oldString === "string") normalized.old_string = input.oldString
  if (normalized.new_string === undefined && typeof input.newString === "string") normalized.new_string = input.newString
  if (Array.isArray(input.edits)) normalized.edits = input.edits.map(item => isRecord(item) ? checkerInput(item) : item)
  return normalized
}

function checkerContent(content: Result["content"]): ToolResultContentBlock[] {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : []
  return (content ?? []).map(part => ({ ...part }))
}

export function toCheckerToolResult(call: CompletedToolCall, cwd: string): CheckerToolResult | undefined {
  if (!isRecord(call.input)) return undefined
  return {
    event: {
      type: "tool_result",
      toolCallId: call.id,
      toolName: checkerToolName(call.tool),
      input: checkerInput(call.input),
      content: checkerContent(call.result.content),
      details: call.result.metadata,
      isError: call.result.metadata?.isError === true,
    },
    context: { cwd, sessionManager: { getSessionId: () => call.sessionID } },
  }
}

/** Appends feedback the way V2 decorates tool results (string joined by newline, arrays get text parts). */
export function withFeedback(result: Result, feedback: readonly string[]): Result {
  if (feedback.length === 0) return result
  const content = typeof result.content === "string"
    ? [...(result.content.length > 0 ? [result.content] : []), ...feedback].join("\n")
    : [...(result.content ?? []), ...feedback.map(text => ({ type: "text" as const, text }))]
  return { ...result, content }
}
