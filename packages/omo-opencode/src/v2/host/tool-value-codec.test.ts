import { expect, test } from "bun:test"
import type { ListedTool } from "./tool-registry"
import { decodeToolValue, issueToolValueCodec, type ToolValueCodec } from "./tool-value-codec"

export function rawTool(): ListedTool {
  return { id: "native", name: "native", description: "strict JSON", input: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] }, execute: async () => ({ content: "ok" }) }
}
export function issueInput(tool: ListedTool, decodeUnknown = (value: unknown) => {
  if (!value || typeof value !== "object" || typeof (value as { prompt?: unknown }).prompt !== "string") throw Error("private validator diagnostic")
  return value
}) {
  return issueToolValueCodec(tool, "input", { schema: tool.input, decodeUnknown })
}
test("strict direct decoder returns identical value and sanitizes validation errors", async () => {
  const tool = rawTool()
  const codec = issueInput(tool)
  const value = { prompt: "hello" }
  expect(await decodeToolValue(codec, tool, "input", value)).toBe(value)
  await expect(decodeToolValue(codec, tool, "input", { prompt: 42 })).rejects.toThrow("Invalid tool value")
  expect(Object.isFrozen(tool.input)).toBe(false)
})
test("casts, serialized tokens, foreign definitions and opposite directions have no authority", () => {
  const tool = rawTool()
  const codec = issueInput(tool)
  for (const fake of [{}, JSON.parse(JSON.stringify(codec))]) expect(() => decodeToolValue(fake as ToolValueCodec, tool, "input", {})).toThrow("Unissued")
  expect(() => decodeToolValue(codec, { ...tool }, "input", {})).toThrow("mismatched")
  expect(() => decodeToolValue(codec, tool, "output", {})).toThrow("mismatched")
  expect(() => issueToolValueCodec(tool, "input", { schema: { ...tool.input }, decodeUnknown: value => value })).toThrow("does not match")
})
test("schema, handler and definition mutation refuse a stale compiled validator", () => {
  for (const mutate of [
    (tool: ListedTool) => { (tool.input as { required: string[] }).required.push("another") },
    (tool: ListedTool) => { Reflect.set(tool, "execute", async () => ({ content: "changed" })) },
    (tool: ListedTool) => { Reflect.set(tool, "description", "changed") },
  ]) {
    const tool = rawTool()
    const codec = issueInput(tool)
    mutate(tool)
    expect(() => decodeToolValue(codec, tool, "input", { prompt: "ok" })).toThrow("Changed")
  }
})
test("async validation refuses mutation during await and corrective decoders", async () => {
  const tool = rawTool()
  let release!: (value: unknown) => void
  const codec = issueInput(tool, () => new Promise(resolve => { release = resolve }))
  const value = { prompt: "ok" }
  const pending = decodeToolValue(codec, tool, "input", value)
  Reflect.set(tool, "description", "changed")
  release(value)
  await expect(pending).rejects.toThrow("Changed")
  const other = rawTool()
  const coercive = issueInput(other, () => ({ prompt: "corrected" }))
  await expect(decodeToolValue(coercive, other, "input", value)).rejects.toThrow("Invalid tool value")
})

