import type { ListedTool } from "./tool-registry"

const brand: unique symbol = Symbol("issued tool argument normalizer")
export type ToolArgumentNormalizer = { readonly [brand]: true }
export type ToolNormalizerAssociation = { readonly tool: ListedTool; readonly input: ToolArgumentNormalizer }
export type ToolArgumentPreparation = (value: unknown) => Promise<unknown>
type Issued = { tool: ListedTool; assert: () => void; normalize: ToolArgumentPreparation }
const issued = new WeakMap<ToolArgumentNormalizer, Issued>()

/** Watch identity as well as schema/options contents without freezing shared providers. */
function watch(value: unknown, seen = new Set<object>()): () => void {
  if (!value || typeof value !== "object") return () => {}
  if (seen.has(value)) throw Error("Cyclic normalizer definition")
  seen.add(value)
  const keys = Reflect.ownKeys(value)
  const checks = keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor)) throw Error("Unstable normalizer definition")
    const original = descriptor.value
    const nested = watch(original, seen)
    return () => {
      const current = Object.getOwnPropertyDescriptor(value, key)
      if (
        !current ||
        !("value" in current) ||
        current.value !== original ||
        current.enumerable !== descriptor.enumerable
      )
        throw Error("Changed normalizer definition")
      nested()
    }
  })
  seen.delete(value)
  return () => {
    const current = Reflect.ownKeys(value)
    if (current.length !== keys.length || current.some((key, index) => key !== keys[index]))
      throw Error("Changed normalizer definition")
    checks.forEach((check) => check())
  }
}

/** JSON transport copy: no getters/toJSON, coercion, dropped fields or shared objects.
 * An absent top-level argument is preserved for the canonical Native preparation. */
function detach(value: unknown, seen = new Set<object>(), top = true): unknown {
  if (value === undefined && top) return undefined
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value
  if (!value || typeof value !== "object") throw Error("Unsupported non-JSON tool arguments")
  if (seen.has(value)) throw Error("Cyclic tool arguments")
  const array = Array.isArray(value)
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    throw Error("Unsupported non-JSON tool arguments")
  seen.add(value)
  const copy: Record<string, unknown> | unknown[] = array ? [] : {}
  const keys = Reflect.ownKeys(value).filter((key) => !(array && key === "length"))
  if (array && (keys.length !== value.length || keys.some((key, index) => key !== String(index))))
    throw Error("Unsupported non-JSON tool arguments")
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== "string" || !descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw Error("Unsupported non-JSON tool arguments")
    Object.defineProperty(copy, key, {
      value: detach(descriptor.value, seen, false),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  seen.delete(value)
  return copy
}

/** Trusted registration only; never publish this issuer or token to model/evaluated code. */
export function issueToolArgumentNormalizer(
  tool: ListedTool,
  provider: {
    readonly schema: unknown
    readonly normalizeUnknown: (value: unknown) => unknown | Promise<unknown>
  },
): ToolArgumentNormalizer {
  if (provider.schema !== tool.input || typeof provider.normalizeUnknown !== "function")
    throw Error("Normalizer schema does not match tool definition")
  const assert = watch(tool)
  const normalizeUnknown = provider.normalizeUnknown
  const token = Object.freeze({}) as ToolArgumentNormalizer
  issued.set(token, {
    tool,
    assert,
    normalize: async (value) => {
      assert()
      const normalized = await normalizeUnknown(detach(value))
      assert()
      return detach(normalized)
    },
  })
  return token
}

/** Bind before cloning; the registry owns the generation assertion and retirement. */
export function bindToolArgumentNormalizer(
  token: ToolArgumentNormalizer,
  tool: ListedTool,
  generation: {
    readonly signal: AbortSignal
    readonly assert: () => void
  },
): ToolArgumentPreparation {
  const record = issued.get(token)
  if (!record || record.tool !== tool) throw Error("Unissued or mismatched tool normalizer")
  record.assert()
  const check = () => {
    generation.signal.throwIfAborted()
    generation.assert()
    record.assert()
  }
  return async (value) => {
    check()
    const normalized = await record.normalize(value)
    check()
    return normalized
  }
}
