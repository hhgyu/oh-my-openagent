import { withNativeTargetPermissionService } from "../orchestration/native-task/service.test"
import { expect, test } from "bun:test"
import { createToolRegistry } from "./tool-registry"
import { issueToolValueCodec, type ToolValueCodec } from "./tool-value-codec"
import { issueToolArgumentNormalizer } from "./tool-argument-normalizer"

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}

function fixture() {
  const tool = { id: "native", name: "native", description: "native", input: { type: "object", properties: { prompt: { type: "string" } } }, execute: async () => ({ content: "ok" }) }
  const input = issueToolValueCodec(tool, "input", { schema: tool.input, decodeUnknown: value => value })
  const registry = createToolRegistry([tool], { native: () => [] }, [{ tool, input }])
  return { tool, input, registry }
}
test("association precedes cloning and snapshot never mutates shared schema", async () => {
  const { tool, registry } = fixture()
  const entry = registry.get("native", registry.generation)
  expect(entry.tool).not.toBe(tool)
  expect(entry.tool.input).toEqual(tool.input)
  expect(entry.tool.input).not.toBe(tool.input)
  expect(Object.isFrozen((entry.tool.input as { properties: object }).properties)).toBe(true)
  expect(Object.isFrozen(tool.input.properties)).toBe(false)
  expect(await defined(entry.inputDecoder)({ prompt: "ok" })).toEqual({ prompt: "ok" })
  tool.input.properties.prompt.type = "number"
  await expect(defined(entry.inputDecoder)({ prompt: "ok" })).rejects.toThrow("Changed")
})
test("replacement explicitly rebinds; same names, schemas and definitions inherit nothing", () => {
  const { tool, input, registry } = fixture()
  const old = registry.generation
  registry.replace([tool])
  expect(registry.get("native", registry.generation).inputDecoder).toBeUndefined()
  expect(() => registry.get("native", old)).toThrow("Retired")
  const copied = { ...tool }
  expect(() => registry.replace([copied], [{ tool: copied, input }])).toThrow("mismatched")
  registry.replace([tool], [{ tool, input }])
  expect(registry.get("native", registry.generation).inputDecoder).toBeDefined()
})
test("failed associations and duplicate replacement are atomic", () => {
  const { tool, registry } = fixture()
  const old = registry.generation
  const entry = registry.get("native", old)
  expect(() => registry.replace([tool], [{ tool, input: {} as ToolValueCodec }])).toThrow("Unissued")
  expect(() => registry.replace([tool, tool])).toThrow("Ambiguous")
  expect(() => registry.replace([tool], [{ tool: { ...tool } }])).toThrow("Ambiguous")
  expect(registry.generation).toBe(old)
  expect(registry.get("native", old).tool).toBe(entry.tool)
})

test("successful replacement retires the old signal synchronously after committing the new snapshot",()=>{
 const {tool}=fixture(),registry=createToolRegistry([tool],{native:()=>[],next:()=>[]}),old=registry.generation,signal=registry.retirementSignal(old)
 let observed=false
 signal.addEventListener("abort",()=>{observed=true;expect(registry.generation).toBe(old+1);expect(registry.get("next",registry.generation).tool.name).toBe("next")},{once:true})
 registry.replace([{...tool,id:"next",name:"next"}])
 expect(observed).toBe(true);expect(signal.aborted).toBe(true)
 expect(registry.retirementSignal(registry.generation).aborted).toBe(false)
 expect(()=>registry.retirementSignal(old)).toThrow("Retired")
})
test("invalid replacement does not abort current generation or revoke its codec",async()=>{
 const {tool,registry}=fixture(),generation=registry.generation,signal=registry.retirementSignal(generation)
 expect(()=>registry.replace([tool,tool])).toThrow("Ambiguous")
 expect(signal.aborted).toBe(false);expect(registry.retirementSignal(generation)).toBe(signal)
 expect(await defined(registry.get("native",generation).inputDecoder)({prompt:"valid"})).toEqual({prompt:"valid"})
})

test("actual SDK identifiers differ from names and ambiguous identifier replacement is atomic", () => {
  const { tool } = fixture()
  const original = { ...tool, id: "namespace_native" }
  const registry = createToolRegistry([original], { native: () => [], other: () => [] })
  const generation = registry.generation
  const retirement = registry.retirementSignal(generation)
  expect(registry.getById("namespace_native", generation).tool).toBe(registry.get("native", generation).tool)
  expect(() => registry.getById("native", generation)).toThrow("Unknown")
  expect(() => registry.replace([original, { ...original, name: "other" }])).toThrow("Ambiguous")
  expect(registry.generation).toBe(generation)
  expect(retirement.aborted).toBe(false)
})

test("explicit normalizers bind the original definition and retire only after valid commit", async () => {
  const { tool } = fixture()
  const input = issueToolArgumentNormalizer(tool, { schema: tool.input, normalizeUnknown: () => ({ prompt: "prepared" }) })
  const registry = createToolRegistry([tool], { native: () => [] }, [], [{ tool, input }])
  const entry = registry.getById(tool.id, registry.generation)
  expect(await defined(entry.normalizeInput)({ prompt: 123 })).toEqual({ prompt: "prepared" })
  const old = registry.generation
  expect(() => registry.replace([tool, tool], [], [{ tool, input }])).toThrow("Ambiguous")
  expect(await defined(entry.normalizeInput)({})).toEqual({ prompt: "prepared" })
  const copy = { ...tool }
  expect(() => registry.replace([copy], [], [{ tool: copy, input }])).toThrow("mismatched")
  expect(registry.generation).toBe(old)
  registry.replace([tool])
  await expect(defined(entry.normalizeInput)({})).rejects.toThrow("Retired")
  expect(registry.get("native", registry.generation).normalizeInput).toBeUndefined()
  registry.replace([tool], [], [{ tool, input }])
  expect(await defined(registry.get("native", registry.generation).normalizeInput)({})).toEqual({ prompt: "prepared" })
})

test("actual Native owner association binds exact target and registry generation atomically",async()=>{
 await withNativeTargetPermissionService(async({service,registry,targets})=>{
  const target=defined(targets.tools[0])
  const permission=service.targetPermission(target),association={tool:target,permission}
  registry.replace([target],[],[],[association])
  const generation=registry.generation,entry=registry.get("task",generation)
  defined(entry.nativeTaskPermission).assertOwner(service);expect(entry.adapter).toBeUndefined()
  expect(()=>registry.replace([target],[],[],[association,association])).toThrow("Ambiguous")
  expect(registry.generation).toBe(generation);defined(entry.nativeTaskPermission).assertCurrent()
  expect(()=>registry.replace([target],[],[],[{tool:target,permission:{} as typeof permission}])).toThrow("Unissued")
  expect(()=>registry.replace([Object.freeze({...target})],[],[],[association])).toThrow("Ambiguous")
  registry.replace([])
  expect(()=>defined(entry.nativeTaskPermission).assertCurrent()).toThrow()
  expect(()=>registry.get("task",generation)).toThrow("Retired")
 })
})

test("Native target phase cannot override an ordinary explicit resource adapter",async()=>{
 await withNativeTargetPermissionService(async({service,targets})=>{
  const target=defined(targets.tools[1])
  const association={tool:target,permission:service.targetPermission(target)}
  expect(()=>createToolRegistry([target],{task_output:()=>[]},[],[],[association])).toThrow("Ambiguous")
  const ordinary=createToolRegistry([target],{})
  expect(()=>ordinary.get("task_output",ordinary.generation)).toThrow("Unsupported resource permission mapping")
 })
})
