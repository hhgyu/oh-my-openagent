import { expect, test } from "bun:test"
import type { AgentToolResult } from "@code-yeongyu/senpi"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { adaptNativeTaskResult } from "./native-task-result"

const adapt = (value: unknown) => adaptNativeTaskResult(value as AgentToolResult<unknown>)

test("plain public SDK content preserves Native text/image order and metadata without undeclared output", () => {
  const native = {
    content: [{ type: "text", text: "first\n", textSignature: "signature" }, { type: "image", data: "aGVsbG8=", mimeType: "image/png" }, { type: "text", text: "last" }],
    details: { nested: [null, false, 0, "", { optional: undefined }], category: undefined },
    usage: { totalTokens: 0 }, isError: false,
  }
  const before = Object.getOwnPropertyDescriptors(native.details)
  const result = adapt(native)
  expect(result.content).toEqual([{ type: "text", text: "first\n" }, { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png" }, { type: "text", text: "last" }])
  expect(Object.hasOwn(result, "output")).toBe(false)
  expect(result.metadata?.native).toEqual({ ...native, details: { nested: [null, false, 0, "", {}] } })
  expect(Object.getOwnPropertyDescriptors(native.details)).toEqual(before)
  expect(result.metadata?.native).not.toBe(native)
  ;(result.metadata?.native as typeof native).content[0]!.text = "detached"
  expect(native.content[0]!.text).toBe("first\n")
})

for (const [index, details] of [null, false, 0, "", [], [false, 0], undefined].entries()) test(`retains falsy/array details ${index}`, () => {
  const result = adapt({ content: [], details })
  if (details === undefined) expect(Object.hasOwn(result.metadata!.native, "details")).toBe(false)
  else expect(result.metadata!.native.details).toEqual(details)
})

test("Native errors throw the actual public SDK failure class with exact text and retained images/details", () => {
  const native = { content: [{ type: "text", text: "Native failure\n" }, { type: "image", data: "AA==", mimeType: "image/jpeg" }, { type: "text", text: "reason" }], details: { code: "refused", optional: undefined }, structuredContent: null, isError: true }
  let thrown: unknown
  try { adapt(native) } catch (error) { thrown = error }
  expect(thrown).toBeInstanceOf(ToolError)
  const error = thrown as ToolError
  expect(error.message).toBe("Native failure\n\nreason")
  expect(error._tag).toBe("Tool.Error")
  expect(error.metadata?.native).toEqual({ ...native, details: { code: "refused" } })
  expect(native.details).toHaveProperty("optional")
})

test("image-only Native failure remains an SDK error with no invented error text", () => {
  expect(() => adapt({ content: [{ type: "image", data: "", mimeType: "image/png" }], details: null, isError: true })).toThrow(ToolError)
})

test.each([null, {}, { content: null }, { content: [{ type: "audio", data: "AA==" }] }, { content: [{ type: "text", text: 1 }] }, { content: [{ type: "image", data: "AA==" }] }, { content: [], isError: "true" }])("malformed content/error flags never become successful results %p", value => {
  expect(() => adapt(value)).toThrow()
})

test("nonportable values fail without invoking accessors or toJSON", () => {
  let calls = 0
  const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { calls++; return "secret" } })
  const toJSON = { toJSON() { calls++; return {} } }
  const cycle: Record<string, unknown> = {}; cycle.self = cycle
  const sparse = Array(1)
  const symbol = { [Symbol("hidden")]: 1 }
  for (const details of [accessor, toJSON, cycle, sparse, symbol, [undefined], NaN, Infinity, 1n, new Date(), () => 1]) {
    expect(() => adapt({ content: [], details })).toThrow()
  }
  const envelope = Object.defineProperty({}, "content", { enumerable: true, get() { calls++; return [] } })
  expect(() => adapt(envelope)).toThrow()
  expect(calls).toBe(0)
})

test("shared JSON references and prototype-like keys survive detachment", () => {
  const shared = { text: "same" }
  const details = JSON.parse('{"__proto__":{"safe":true},"constructor":"value"}')
  details.left = shared; details.right = shared
  const result = adapt({ content: [], details })
  expect(JSON.parse(JSON.stringify(result.metadata?.native.details))).toEqual(details)
  expect(Object.getPrototypeOf(result.metadata?.native.details)).toBe(Object.prototype)
  expect(result.metadata?.native.details.left).not.toBe(shared)
})

test("model-only Native text is rejected because SDK content lacks a visibility channel", () => {
  expect(() => adapt({ content: [{ type: "text", text: "model only", audience: "model" }], details: {} })).toThrow("Unsupported Native task text audience")
})

const structuredValues = [null, false, 0, "", [], {}, { ok: false }]
for (const [index, value] of structuredValues.entries()) {
  test(`defined structured content ${index} refuses undeclared SDK output with complete Native metadata`, () => {
    const native = { content: [{ type: "text", text: "Native succeeded", textSignature: "sig" }], details: { count: 0 }, usage: { totalTokens: 0 }, isError: false, structuredContent: value }
    let thrown: unknown
    try { adapt(native) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(ToolError)
    const error = thrown as ToolError
    expect(error.message).toBe("Native structuredContent requires a declared SDK output schema")
    expect(error.metadata?.native).toEqual(native)
    expect(error.metadata?.native).not.toBe(native)
    expect(Object.hasOwn(error, "output")).toBe(false)
  })

  test(`Native isError precedence is preserved with structured content ${index}`, () => {
    const native = { content: [{ type: "text", text: "Original Native failure\n" }, { type: "text", text: "reason" }], details: false, isError: true, structuredContent: value }
    let thrown: unknown
    try { adapt(native) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(ToolError)
    const error = thrown as ToolError
    expect(error.message).toBe("Original Native failure\n\nreason")
    expect(error.metadata?.native).toEqual(native)
    expect(Object.hasOwn(error, "output")).toBe(false)
  })
}

test("own optional undefined structured content is omitted and remains ordinary plain success", () => {
  const native = { content: [{ type: "text" as const, text: "plain" }], details: {}, structuredContent: undefined }
  const result = adapt(native)
  expect(result.content).toEqual(native.content)
  expect(Object.hasOwn(result, "output")).toBe(false)
  expect(Object.hasOwn(result.metadata!.native, "structuredContent")).toBe(false)
  expect(Object.hasOwn(native, "structuredContent")).toBe(true)
})

