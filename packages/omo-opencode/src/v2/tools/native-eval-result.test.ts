import { describe, expect, test } from "bun:test"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { adaptEvalResult, toToolError } from "./native-eval-result"

describe("native eval result adaptation", () => {
  test("#given an isError cell result #when adapted #then the model reads a tool error with the cell text", () => {
    // given
    const value = {
      content: [
        { type: "text", text: "ReferenceError: y is not defined" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
      ],
      isError: true,
    }

    // when
    const error = (() => {
      try {
        adaptEvalResult(value)
      } catch (caught) {
        return caught
      }
    })()

    // then
    expect(error).toBeInstanceOf(ToolError)
    expect((error as ToolError).message).toBe("ReferenceError: y is not defined")
    expect(adaptEvalResult({ content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] }).content).toEqual([
      { type: "file", uri: "data:image/png;base64,aGk=", mime: "image/png" },
    ])
  })

  test("#given an error from the worker #when converted #then the model reads its message and a ToolError passes through", () => {
    // given
    const original = new ToolError({ message: "already adapted" })

    // when
    const converted = toToolError(Object.assign(Error("eval is unavailable: missing"), { name: "RemoteError" }))

    // then
    expect(converted).toBeInstanceOf(ToolError)
    expect(converted.message).toBe("eval is unavailable: missing")
    expect(toToolError(original)).toBe(original)
  })
})
