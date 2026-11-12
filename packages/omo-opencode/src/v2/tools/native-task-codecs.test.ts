import { expect, test } from "bun:test"
import {
  TaskToolParams,
  TaskSendParams,
  TaskCancelParams,
  TaskOutputParams,
  normalizeTaskToolArguments,
} from "@oh-my-opencode/senpi-task/task-operations"
import { issueNativeTaskCodecs, nativeTaskInputSchemas, type NativeTaskToolName } from "./native-task-codecs"
import { createToolRegistry, type ListedTool } from "../host/tool-registry"
import { decodeToolValue } from "../host/tool-value-codec"
import { Schema } from "effect"
import { nativeTaskPublicInput } from "./native-task"
import { issueNativeTeamCodec, nativeTeamInputSchemas, type NativeTeamToolName } from "./native-team-codecs"

function fixture(name: NativeTaskToolName = "task") {
  // TypeBox's JSON object lacks the SDK JsonSchema string index signature;
  // this boundary cast preserves the actual published object, without a copy.
  const tool: ListedTool = {
    id: `native_${name}`,
    name,
    description: name,
    input: nativeTaskInputSchemas[name] as unknown as ListedTool["input"],
    execute: async () => ({}),
  }
  const issued = issueNativeTaskCodecs(tool, name)
  const registry = createToolRegistry(
    [tool],
    { [name]: () => [] },
    [issued.codec],
    issued.normalizer ? [issued.normalizer] : [],
  )
  return { tool, issued, registry, entry: registry.get(name, registry.generation) }
}

test("all four advertised inputs are the actual Native schema objects, without invented output schemas", () => {
  expect(nativeTaskInputSchemas).toEqual({
    task: TaskToolParams,
    task_send: TaskSendParams,
    task_cancel: TaskCancelParams,
    task_output: TaskOutputParams,
  })
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
  const raw = {
    prompt: " actual prompt ",
    category: " general ",
    task_summary: "very   long ".repeat(30),
    tasks: [{ prompt: "unused" }],
    run_in_background: "true",
    tools: [" read ", "write"],
    ignored: "padding",
  }
  const rawBefore = structuredClone(raw)
  await expect(defined(f.entry.inputDecoder)(raw)).rejects.toThrow("Invalid")
  const prepared = (await defined(f.entry.normalizeInput)(raw)) as ReturnType<typeof normalizeTaskToolArguments>
  expect(prepared).toEqual(normalizeTaskToolArguments(raw))
  expect(prepared.task_summary.length).toBeLessThanOrEqual(80)
  expect(prepared.tasks).toBeUndefined()
  expect(prepared.run_in_background).toBeUndefined()
  expect(prepared.prompt).toBe(" actual prompt ")
  expect(prepared.category).toBe("general")
  expect(prepared.tools).toEqual(["read", "write"])
  expect(await defined(f.entry.inputDecoder)(prepared)).toBe(prepared)
  expect(await decodeToolValue(defined(f.issued.codec.input), f.tool, "input", prepared)).toBe(prepared)
  expect(raw).toEqual(rawBefore)
  expect(Object.isFrozen(raw)).toBe(false)
})

test("real batch normalization preserves tasks-only unused prompt and clamps item summaries", async () => {
  const f = fixture()
  const raw = {
    tasks: [{ prompt: "unused", task_summary: "x".repeat(120), load_skills: [" one ", "", 42] }, null, { prompt: " " }],
    run_in_background: true,
  }
  const prepared = (await defined(f.entry.normalizeInput)(raw)) as ReturnType<typeof normalizeTaskToolArguments>
  expect(prepared).toEqual(normalizeTaskToolArguments(raw))
  expect(prepared.tasks).toHaveLength(1)
  expect(prepared.tasks[0].prompt).toBe("unused")
  expect(prepared.tasks[0].task_summary.length).toBeLessThanOrEqual(80)
  expect(await defined(f.entry.inputDecoder)(prepared)).toBe(prepared)
})

test("Native preparation throws honestly while missing prompt remains schema-valid semantic-invalid", async () => {
  const f = fixture()
  for (const raw of [{ isolated: "true" }, { apply: 1 }, { merge: "invalid" }]) {
    await expect(defined(f.entry.normalizeInput)(raw)).rejects.toThrow()
  }
  const missing = await defined(f.entry.normalizeInput)({ prompt: 42 })
  expect(missing).toEqual({})
  expect(await defined(f.entry.inputDecoder)(missing)).toBe(missing)
  const bad = { prompt: 42 }
  await expect(defined(f.entry.inputDecoder)(bad)).rejects.toThrow("Invalid")
})

test("other inputs validate their own schemas and never borrow task preparation", async () => {
  for (const name of ["task_send", "task_cancel", "task_output"] as const) {
    const f = fixture(name)
    expect(f.issued.normalizer).toBeUndefined()
    await expect(defined(f.entry.inputDecoder)({ task_id: 42 })).rejects.toThrow("Invalid")
    expect(() =>
      issueNativeTaskCodecs({ ...f.tool, input: TaskToolParams as unknown as ListedTool["input"] }, name),
    ).toThrow("schema")
  }
})

test("#given invalid task_send fields #when decoded on both issued paths #then safe field diagnostics survive", async () => {
  const f = fixture("task_send")
  for (const [input, fields] of [
    [{ to: "child", message: "hello", task_id: "private-value" }, ["task_id"]],
    [{ message: "hello" }, ["to"]],
    [{ to: 42, message: "hello" }, ["to"]],
  ] as const) {
    for (const decode of [
      defined(f.entry.inputDecoder),
      (value: unknown) => decodeToolValue(defined(f.issued.codec.input), f.tool, "input", value),
    ]) {
      let diagnostic: unknown
      try {
        await decode(input)
      } catch (error) {
        diagnostic = JSON.parse((error as Error).message)
      }
      expect(diagnostic).toMatchObject({
        code: "invalid_arguments",
        fields,
        expected_fields: ["to", "message", "team_run_id", "summary", "all_scope", "redispatch"],
      })
      expect(JSON.stringify(diagnostic)).not.toContain("private-value")
    }
    const standard = Schema.toStandardSchemaV1(nativeTaskPublicInput("task_send"))
    const result = await standard["~standard"].validate(input)
    expect(result.issues?.map((issue) => JSON.parse(issue.message))).toContainEqual(
      expect.objectContaining({ code: "invalid_arguments", fields }),
    )
  }
  const correct = { to: "child", message: "hello" }
  expect(await defined(f.entry.inputDecoder)(correct)).toBe(correct)
  await expect(
    defined(f.entry.inputDecoder)({ to: "child", message: { type: "shutdown_response", aprove: true } }),
  ).rejects.toMatchObject({
    diagnostic: { fields: expect.arrayContaining(["message/aprove", "message/approve"]) },
  })
})

test("#given sibling Native schemas #when a field is unknown #then each codec reports its own expected names", async () => {
  for (const name of ["task_output", "task_cancel"] as const) {
    const f = fixture(name)
    await expect(defined(f.entry.inputDecoder)({ misspelled: "private-value" })).rejects.toMatchObject({
      diagnostic: {
        code: "invalid_arguments",
        fields: ["misspelled"],
        expected_fields: Object.keys(nativeTaskInputSchemas[name].properties),
      },
    })
  }
  for (const name of Object.keys(nativeTeamInputSchemas) as NativeTeamToolName[]) {
    const schema = nativeTeamInputSchemas[name]
    const tool: ListedTool = {
      id: name,
      name,
      description: name,
      input: schema as unknown as ListedTool["input"],
      execute: async () => ({}),
    }
    const codec = defined(issueNativeTeamCodec(tool, name).input)
    await expect(decodeToolValue(codec, tool, "input", { misspelled: "private-value" })).rejects.toMatchObject({
      diagnostic: {
        code: "invalid_arguments",
        fields: expect.arrayContaining(["misspelled"]),
        expected_fields: Object.keys(schema.properties),
      },
    })
  }
})

test("post-compile Native schema mutation invalidates BOTH issued paths without freezing globals", async () => {
  const f = fixture()
  const schema = TaskToolParams as { description?: string }
  const descriptor = Object.getOwnPropertyDescriptor(schema, "description")
  try {
    schema.description = "changed after compile"
    await expect(defined(f.entry.inputDecoder)({ prompt: "ok" })).rejects.toThrow("Changed")
    await expect(defined(f.entry.normalizeInput)({ prompt: "ok" })).rejects.toThrow("Changed")
  } finally {
    if (descriptor) Object.defineProperty(schema, "description", descriptor)
    else delete schema.description
  }
  expect(Object.isFrozen(TaskToolParams)).toBe(false)
  expect(await defined(f.entry.inputDecoder)({ prompt: "ok" })).toEqual({ prompt: "ok" })
})
function defined<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("expected a defined value")
  return value
}
