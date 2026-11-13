import { describe, expect, test } from "bun:test"
import { toCheckerToolResult, withFeedback } from "./event-translation"

describe("event-translation", () => {
  test("#given OpenCode 2 edit input #when translated #then checker-core field names and tool names are produced", () => {
    // given
    const call = {
      tool: "edit",
      sessionID: "ses_1",
      id: "call_1",
      input: { filePath: "a.ts", edits: [{ oldString: "x", newString: "y" }] },
      result: { content: "ok", metadata: { files: [] } },
    }
    // when
    const delivered = toCheckerToolResult(call, "/work")
    const patch = toCheckerToolResult({ ...call, tool: "patch", input: { patchText: "*** Begin Patch" } }, "/work")
    // then
    expect(delivered?.event).toMatchObject({
      toolName: "edit",
      isError: false,
      content: [{ type: "text", text: "ok" }],
      details: { files: [] },
      input: { path: "a.ts", edits: [{ old_string: "x", new_string: "y" }] },
    })
    expect(delivered?.context.sessionManager.getSessionId()).toBe("ses_1")
    expect(patch?.event.toolName).toBe("apply_patch")
    expect(toCheckerToolResult({ ...call, input: "not-a-record" }, "/work")).toBeUndefined()
  })

  test("#given checker feedback #when it is applied #then string results gain lines and array results gain text parts", () => {
    // given
    const feedback = ["F"]
    const original = { content: "done", metadata: { keep: true } }
    // when
    const unchanged = withFeedback(original, [])
    const appended = withFeedback(original, feedback)
    // then
    expect(unchanged).toBe(original)
    expect(appended).toEqual({ content: "done\nF", metadata: { keep: true } })
    expect(withFeedback({}, feedback)).toEqual({ content: [{ type: "text", text: "F" }] })
  })
})
