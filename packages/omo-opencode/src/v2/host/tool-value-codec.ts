import type { ListedTool } from "./tool-registry"
import { ToolArgumentValidationError } from "@oh-my-opencode/senpi-task/task-operations"

const brand: unique symbol = Symbol("issued tool value codec")
export type ToolValueCodec = { readonly [brand]: true }
export type ToolValueDecoder = (value: unknown) => Promise<unknown>
export type ToolCodecAssociation = {
  readonly tool: ListedTool
  readonly input?: ToolValueCodec
  readonly output?: ToolValueCodec
}
type Direction = "input" | "output"
type Issued = {
  tool: ListedTool
  direction: Direction
  schema: unknown
  snapshot: unknown
  assert: () => void
  decode: ToolValueDecoder
}
const issued = new WeakMap<ToolValueCodec, Issued>()

/** Capture data without freezing the provider's shared schema. Symbols (e.g. TypeBox
 * annotations) are checked too; accessors cannot be a stable compiled snapshot. */
function watch(value: unknown, seen = new Set<object>()): () => void {
  if (!value || typeof value !== "object") return () => {}
  if (seen.has(value)) throw Error("Cyclic codec definition")
  seen.add(value)
  const keys = Reflect.ownKeys(value)
  const fields = keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor)) throw Error("Unstable codec definition")
    const original = descriptor.value
    const nested = watch(original, seen)
    return () => {
      const current = Object.getOwnPropertyDescriptor(value, key)
      if (!current || !("value" in current) || current.value !== original) throw Error("Changed codec definition")
      nested()
    }
  })
  seen.delete(value)
  return () => {
    const current = Reflect.ownKeys(value)
    if (current.length !== keys.length || current.some((key, index) => key !== keys[index]))
      throw Error("Changed codec definition")
    fields.forEach((assert) => {
      assert()
    })
  }
}
function freezeJSON(value: unknown): unknown {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeJSON)
    Object.freeze(value)
  }
  return value
}

/** Trusted registration boundary only. The provider compiles this exact published
 * schema before issue and must return the checked original value, never Parse/coerce.
 * Neither this issuer nor its capabilities may be exposed to evaluated/model code. */
export function issueToolValueCodec(
  tool: ListedTool,
  direction: Direction,
  provider: {
    readonly schema: unknown
    readonly decodeUnknown: (value: unknown) => unknown | Promise<unknown>
  },
): ToolValueCodec {
  const schema = tool[direction]
  if (!schema || provider.schema !== schema || typeof provider.decodeUnknown !== "function")
    throw Error("Codec schema does not match tool definition")
  const keys = Reflect.ownKeys(tool)
  const values = keys.map((key) => Reflect.get(tool, key))
  const assertSchema = watch(schema)
  const assertOptions = watch(tool.options)
  const assert = () => {
    const current = Reflect.ownKeys(tool)
    if (
      current.length !== keys.length ||
      current.some((key, index) => key !== keys[index] || Reflect.get(tool, key) !== values[index])
    )
      throw Error("Changed codec definition")
    assertSchema()
    assertOptions()
  }
  const snapshot = freezeJSON(JSON.parse(JSON.stringify(schema)))
  const decodeUnknown = provider.decodeUnknown
  const codec = Object.freeze({}) as ToolValueCodec
  const decode = async (value: unknown) => {
    assert()
    try {
      const decoded = await decodeUnknown(value)
      if (decoded !== value) throw Error("Invalid tool value")
    } catch (error) {
      if (direction === "input" && error instanceof ToolArgumentValidationError) throw error
      throw Error("Invalid tool value")
    }
    assert()
    return value
  }
  issued.set(codec, { tool, direction, schema, snapshot, assert, decode })
  return codec
}

/** Resolve only an explicitly supplied association, before registry cloning. */
export function bindToolValueCodec(codec: ToolValueCodec, tool: ListedTool, direction: Direction) {
  const record = issued.get(codec)
  if (!record || record.tool !== tool || record.direction !== direction || record.schema !== tool[direction])
    throw Error("Unissued or mismatched tool codec")
  record.assert()
  return Object.freeze({ schema: record.snapshot, decode: record.decode })
}

/** Same strict decoder for the genuine SDK direct callback wrapper. This checks
 * the definition, not caller authority or registry generation. The owning callback
 * must enforce its active registration, caller/session scope and cancellation. */
export function decodeToolValue(
  codec: ToolValueCodec,
  tool: ListedTool,
  direction: Direction,
  value: unknown,
): Promise<unknown> {
  return bindToolValueCodec(codec, tool, direction).decode(value)
}
