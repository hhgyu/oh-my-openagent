import { expect, test } from "bun:test"
import {
  bindToolArgumentNormalizer,
  issueToolArgumentNormalizer,
  type ToolArgumentNormalizer,
} from "./tool-argument-normalizer"

function fixture(normalizeUnknown: (value: unknown) => unknown | Promise<unknown> = (value) => value) {
  const tool = {
    id: "space_tool",
    name: "tool",
    description: "tool",
    input: { type: "object", properties: { text: { type: "string" } } },
    options: { permission: "read" },
    execute: async () => ({}),
  }
  const token = issueToolArgumentNormalizer(tool, { schema: tool.input, normalizeUnknown })
  const controller = new AbortController()
  const normalize = bindToolArgumentNormalizer(token, tool, { signal: controller.signal, assert() {} })
  return { tool, token, controller, normalize }
}

test("private issuance refuses spoof, equal definitions and mismatched schema", () => {
  const f = fixture()
  const generation = { signal: f.controller.signal, assert() {} }
  expect(() => bindToolArgumentNormalizer({} as ToolArgumentNormalizer, f.tool, generation)).toThrow("Unissued")
  expect(() => bindToolArgumentNormalizer(f.token, { ...f.tool }, generation)).toThrow("mismatched")
  expect(() =>
    issueToolArgumentNormalizer(f.tool, { schema: { ...f.tool.input }, normalizeUnknown: (value) => value }),
  ).toThrow("schema")
})

test("provider mutates only detached arguments and cannot leak its shared result", async () => {
  const result = { text: "normalized" }
  const f = fixture((value) => {
    ;(value as { nested: { text: string } }).nested.text = "changed"
    return result
  })
  const input = { nested: { text: "raw" } }
  const output = await f.normalize(input)
  expect(input.nested.text).toBe("raw")
  expect(Object.isFrozen(input)).toBe(false)
  expect(output).toEqual(result)
  expect(output).not.toBe(result)
  Object.freeze(output)
  expect(Object.isFrozen(result)).toBe(false)
})

test("detachment refuses getters, cycles, dropped JSON values and unsafe array properties without invoking getters", async () => {
  let reads = 0,
    calls = 0
  const f = fixture((value) => {
    calls++
    return value
  })
  const getter = Object.defineProperty({}, "text", {
    enumerable: true,
    get() {
      reads++
      return "x"
    },
  })
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  const array = Object.assign([], { extra: true })
  for (const value of [
    getter,
    cycle,
    { value: undefined },
    { value: NaN },
    { value: () => 1 },
    new Date(),
    array,
    [,],
  ]) {
    await expect(f.normalize(value)).rejects.toThrow()
  }
  expect(reads).toBe(0)
  expect(calls).toBe(0)
  const dangerous = JSON.parse('{"__proto__":{"polluted":true}}')
  expect(await f.normalize(dangerous)).toEqual(dangerous)
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
})

test("schema, handler and options changes refuse without freezing provider globals", async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => {
      f.tool.input.properties.text.type = "number"
    },
    (f: ReturnType<typeof fixture>) => {
      f.tool.options.permission = "write"
    },
    (f: ReturnType<typeof fixture>) => {
      f.tool.execute = async () => ({ content: "new" })
    },
  ]) {
    const f = fixture()
    change(f)
    await expect(f.normalize({})).rejects.toThrow("Changed")
    expect(Object.isFrozen(f.tool.input)).toBe(false)
  }
})

test("mutation and retirement during asynchronous preparation refuse its late result", async () => {
  for (const retire of [false, true]) {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const f = fixture(async (value) => {
      await gate
      return value
    })
    const pending = f.normalize({ text: "raw" })
    if (retire) f.controller.abort(Error("Retired"))
    else f.tool.options.permission = "changed"
    release()
    await expect(pending).rejects.toThrow(retire ? "Retired" : "Changed")
  }
})

test("absent arguments reach canonical preparation and preparation errors stay truthful", async () => {
  expect(await fixture((value) => (value === undefined ? {} : value)).normalize(undefined)).toEqual({})
  const failure = new TypeError("isolated must be a boolean")
  await expect(
    fixture(() => {
      throw failure
    }).normalize({}),
  ).rejects.toBe(failure)
})

test("candidate generation assertion prevents provider execution before registry commit", async () => {
  let calls = 0,
    committed = false
  const f = fixture((value) => {
    calls++
    return value
  })
  const prepare = bindToolArgumentNormalizer(f.token, f.tool, {
    signal: f.controller.signal,
    assert() {
      if (!committed) throw Error("not committed")
    },
  })
  await expect(prepare({})).rejects.toThrow("not committed")
  expect(calls).toBe(0)
  committed = true
  expect(await prepare({})).toEqual({})
  expect(calls).toBe(1)
})
