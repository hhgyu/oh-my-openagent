import { resolve } from "node:path"

import { extractApplyPatchEdits } from "./apply-patch-edits"
import type { HookInput } from "./types"

export type ToolResultTextBlock = { type: "text"; text: string }
export type ToolResultContentBlock = ToolResultTextBlock | Record<string, unknown>

/** A completed tool call in the shape the checker reads: `path`/`content`/`old_string`/`new_string`/`edits` input. */
export interface ToolResultEventLike {
  type: "tool_result"
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
  content: ToolResultContentBlock[]
  details?: unknown
  isError: boolean
}

export interface ToolResultContextLike {
  cwd: string
  sessionManager?: {
    getSessionId?: () => string
    getSessionFile?: () => string | undefined
  }
}

export function toHookInput(event: ToolResultEventLike, ctx: ToolResultContextLike, absolutePath: string, hookEventName: string): HookInput {
  return {
    session_id: ctx.sessionManager?.getSessionId?.() ?? "unknown",
    tool_name: event.toolName,
    transcript_path: ctx.sessionManager?.getSessionFile?.() ?? "",
    cwd: ctx.cwd,
    hook_event_name: hookEventName,
    tool_input: toCoreToolInput(event.input, absolutePath),
    tool_response: {
      content: event.content,
      details: event.details,
      isError: event.isError,
    },
  }
}

export function toApplyPatchHookInputs(event: ToolResultEventLike, ctx: ToolResultContextLike, hookEventName: string): HookInput[] {
  return extractApplyPatchEdits(event.details, event.input).map((edit) => toHookInput(event, ctx, resolve(ctx.cwd, edit.filePath), hookEventName))
}

function toCoreToolInput(input: Record<string, unknown>, absolutePath: string): HookInput["tool_input"] {
  const coreInput: {
    file_path: string
    content?: string
    old_string?: string
    new_string?: string
    edits?: readonly { old_string: string; new_string: string }[]
  } = {
    file_path: absolutePath,
  }

  const content = stringValue(input.content)
  if (content !== undefined) {
    coreInput.content = content
  }

  const oldString = stringValue(input.old_string) ?? stringValue(input.oldText)
  const newString = stringValue(input.new_string) ?? stringValue(input.newText)
  if (oldString !== undefined) {
    coreInput.old_string = oldString
  }
  if (newString !== undefined) {
    coreInput.new_string = newString
  }

  const edits = parseEdits(input.edits)
  if (edits.length > 0) {
    coreInput.edits = edits
  }

  return coreInput
}

function parseEdits(value: unknown): readonly { old_string: string; new_string: string }[] {
  if (!Array.isArray(value)) {
    return []
  }

  const edits: { old_string: string; new_string: string }[] = []
  for (const item of value) {
    if (!isObjectRecord(item)) {
      continue
    }
    const oldString = stringValue(item.old_string) ?? stringValue(item.oldText)
    const newString = stringValue(item.new_string) ?? stringValue(item.newText)
    if (oldString !== undefined && newString !== undefined) {
      edits.push({ old_string: oldString, new_string: newString })
    }
  }
  return edits
}

export function parseToolResultEvent(value: unknown): ToolResultEventLike | undefined {
  if (!isObjectRecord(value)) {
    return undefined
  }
  if (
    value.type !== "tool_result" ||
    typeof value.toolCallId !== "string" ||
    typeof value.toolName !== "string" ||
    !isObjectRecord(value.input) ||
    !Array.isArray(value.content) ||
    typeof value.isError !== "boolean"
  ) {
    return undefined
  }

  return {
    type: "tool_result",
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    input: value.input,
    content: value.content.filter(isObjectRecord),
    details: value.details,
    isError: value.isError,
  }
}

export function parseToolResultContext(value: unknown): ToolResultContextLike {
  if (!isObjectRecord(value)) {
    return { cwd: process.cwd() }
  }

  const cwd = stringValue(value.cwd) ?? process.cwd()
  const sessionManager = isObjectRecord(value.sessionManager) ? value.sessionManager : undefined
  const getSessionIdValue = sessionManager?.getSessionId
  const getSessionFileValue = sessionManager?.getSessionFile
  return {
    cwd,
    sessionManager: {
      getSessionId: isUnknownFunction(getSessionIdValue)
        ? () => {
            const sessionId = getSessionIdValue.call(sessionManager)
            return stringValue(sessionId) ?? "unknown"
          }
        : undefined,
      getSessionFile: isUnknownFunction(getSessionFileValue)
        ? () => {
            const sessionFile = getSessionFileValue.call(sessionManager)
            return stringValue(sessionFile)
          }
        : undefined,
    },
  }
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isUnknownFunction(value: unknown): value is () => unknown {
  return typeof value === "function"
}
