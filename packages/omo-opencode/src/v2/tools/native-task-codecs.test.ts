import { expect, test } from "bun:test"
import { TaskToolParams, TaskSendParams, TaskCancelParams, TaskOutputParams, normalizeTaskToolArguments } from "@oh-my-opencode/senpi-task/task-operations"
import { issueNativeTaskCodecs, nativeTaskInputSchemas, type NativeTaskToolName } from "./native-task-codecs"
import { createToolRegistry, type ListedTool } from "../host/tool-registry"
import { decodeToolValue } from "../host/tool-value-codec"

function fixture(name: NativeTaskToolName = "task") {
  // TypeBox's JSON object lacks the SDK JsonSchema string index signature;
  // this boundary cast preserves the actual published object, without a copy.
  const tool: ListedTool = { id: `native_${name}`, name, description: name, input: nativeTaskInputSchemas[name] as unknown as ListedTool["input"], execute: async () => ({}) }
  const issued = issueNativeTaskCodecs(tool, name)
  const registry = createToolRegistry([tool], { [name]: () => [] }, [issued.codec], issued.normalizer ? [issued.normalizer] : [])
  return { tool, issued, registry, entry: registry.get(name, registry.generation) }
}

test("all four advertised inputs are the actual Native schema objects, without invented output schemas", () => {
  expect(nativeTaskInputSchemas).toEqual({ task: TaskToolParams, task_send: TaskSendParams, task_cancel: TaskCancelParams, task_output: TaskOutputParams })
  for (const name of Object.keys(nativeTaskInputSchemas) as NativeTaskToolName[]) {
    const f = fixture(name)
    expect(f.tool.input as unknown).toBe(nativeTaskInputSchemas[name])
    expect(f.entry.tool.input).toEqual(JSON.parse(JSON.stringify(nativeTaskInputSchemas[name])))
    expect(f.entry.tool.output).toBeUndefined()
    expect(Boolean(f.entry.normalizeInput)).toBe(name === "task")
  }
})

test("Native summary/padding/flags are prepared before strict SAME-value validation", async () => {
  const f = fixture()
  const raw = { prompt: " actual prompt ", category: " general ", task_summary: "very   long ".repeat(30), tasks: [{ prompt: "unused" }], run_in_background: "true", tools: [" read ", "write"], ignored: "padding" }
  const rawBefore = structuredClone(raw)
  await expect(f.entry.inputDecoder!(raw)).rejects.toThrow("Invalid")
  const prepared: any = await f.entry.normalizeInput!(raw)
  expect(prepared).toEqual(normalizeTaskToolArguments(raw))
  expect(prepared.task_summary.length).toBeLessThanOrEqual(80)
  expect(prepared.tasks).toBeUndefined(); expect(prepared.run_in_background).toBeUndefined()
  expect(prepared.prompt).toBe(" actual prompt "); expect(prepared.category).toBe("general")
  expect(prepared.tools).toEqual(["read", "write"])
  expect(await f.entry.inputDecoder!(prepared)).toBe(prepared)
  expect(await decodeToolValue(f.issued.codec.input!, f.tool, "input", prepared)).toBe(prepared)
  expect(raw).toEqual(rawBefore); expect(Object.isFrozen(raw)).toBe(false)
})

test("real batch normalization preserves tasks-only unused prompt and clamps item summaries", async () => {
  const f = fixture()
  const raw = { tasks: [{ prompt: "unused", task_summary: "x".repeat(120), load_skills: [" one ", "", 42] }, null, { prompt: " " }], run_in_background: true }
  const prepared: any = await f.entry.normalizeInput!(raw)
  expect(prepared).toEqual(normalizeTaskToolArguments(raw))
  expect(prepared.tasks).toHaveLength(1)
  expect(prepared.tasks[0].prompt).toBe("unused")
  expect(prepared.tasks[0].task_summary.length).toBeLessThanOrEqual(80)
  expect(await f.entry.inputDecoder!(prepared)).toBe(prepared)
})

test("Native preparation throws honestly while missing prompt remains schema-valid semantic-invalid", async () => {
  const f = fixture()
  for (const raw of [{ isolated: "true" }, { apply: 1 }, { merge: "invalid" }]) {
    await expect(f.entry.normalizeInput!(raw)).rejects.toThrow()
  }
  const missing = await f.entry.normalizeInput!({ prompt: 42 })
  expect(missing).toEqual({})
  expect(await f.entry.inputDecoder!(missing)).toBe(missing)
  const bad = { prompt: 42 }
  await expect(f.entry.inputDecoder!(bad)).rejects.toThrow("Invalid")
})

test("other inputs validate their own schemas and never borrow task preparation", async () => {
  for (const name of ["task_send", "task_cancel", "task_output"] as const) {
    const f = fixture(name)
    expect(f.issued.normalizer).toBeUndefined()
    await expect(f.entry.inputDecoder!({ task_id: 42 })).rejects.toThrow("Invalid")
    expect(() => issueNativeTaskCodecs({ ...f.tool, input: TaskToolParams as unknown as ListedTool["input"] }, name)).toThrow("schema")
  }
})

test("post-compile Native schema mutation invalidates BOTH issued paths without freezing globals", async () => {
  const f = fixture()
  const schema = TaskToolParams as { description?: string }
  const descriptor = Object.getOwnPropertyDescriptor(schema, "description")
  try {
    schema.description = "changed after compile"
    await expect(f.entry.inputDecoder!({ prompt: "ok" })).rejects.toThrow("Changed")
    await expect(f.entry.normalizeInput!({ prompt: "ok" })).rejects.toThrow("Changed")
  } finally {
    if (descriptor) Object.defineProperty(schema, "description", descriptor)
    else delete schema.description
  }
  expect(Object.isFrozen(TaskToolParams)).toBe(false)
  expect(await f.entry.inputDecoder!({ prompt: "ok" })).toEqual({ prompt: "ok" })
})
