import type { AgentToolResult } from "@code-yeongyu/senpi"
import { Error as ToolError, type Result } from "@opencode/plugin/promise/tool"

type JSONValue = null | string | boolean | number | JSONValue[] | { [key: string]: JSONValue }

/** Native factories include absent optional fields as own undefined properties.
 * Omit those object fields; all other values must survive JSON transport exactly.
 * Descriptor reads avoid invoking accessors or toJSON on producer-owned objects. */
function snapshot(value: unknown, ancestors = new Set<object>()): JSONValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value
  if (!value || typeof value !== "object") throw Error("Non-JSON Native task result")
  if (ancestors.has(value)) throw Error("Cyclic Native task result")
  const array = Array.isArray(value)
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw Error("Non-JSON Native task result")
  ancestors.add(value)
  const copy: { [key: string]: JSONValue } | JSONValue[] = array ? [] : {}
  const keys = Reflect.ownKeys(value).filter((key) => !(array && key === "length"))
  if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index))))
    throw Error("Non-JSON Native task result array")
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== "string" || !descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw Error("Non-JSON Native task result field")
    if (!array && descriptor.value === undefined) continue
    Object.defineProperty(copy, key, {
      value: snapshot(descriptor.value, ancestors),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  ancestors.delete(value)
  return copy
}

/** Project the SAME Native operation result at the public SDK boundary. This
 * helper does not register tools or retain a caller, context, or permission. */
export function adaptNativeTaskResult(result: AgentToolResult<unknown>): Result {
  const native = snapshot(result)
  if (!native || typeof native !== "object" || Array.isArray(native) || !Array.isArray(native.content))
    throw Error("Invalid Native task result content")
  if (native.isError !== undefined && typeof native.isError !== "boolean")
    throw Error("Invalid Native task result isError")
  const content = native.content.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) throw Error("Invalid Native task result content part")
    if (part.type === "text" && typeof part.text === "string") {
      // SDK content has no model-only visibility channel; never expose it to UI.
      if (part.audience !== undefined) throw Error("Unsupported Native task text audience")
      return { type: "text" as const, text: part.text }
    }
    if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
      return { type: "file" as const, uri: `data:${part.mimeType};base64,${part.data}`, mime: part.mimeType }
    }
    throw Error("Unsupported Native task result content part")
  })
  const metadata = { native }
  if (native.isError === true) {
    const message = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
    throw new ToolError({ message, metadata })
  }
  // These Native task tools declare no SDK output schema. Preserve the full
  // envelope and refuse explicitly until a declaration-aware bridge exists;
  // metadata retention alone is not model-visible structured-output parity.
  if (native.structuredContent !== undefined) {
    throw new ToolError({ message: "Native structuredContent requires a declared SDK output schema", metadata })
  }
  return { content, metadata }
}
