import { bindNativeTaskTargetPermission, type NativeTaskTargetPermissionAssociation } from "../orchestration/native-task/service"
import type { Info } from "@opencode/plugin/promise/tool"
import type { PermissionAdapter } from "./permission-adapters"
import { bindToolValueCodec, type ToolCodecAssociation, type ToolValueDecoder } from "./tool-value-codec"
import { bindToolArgumentNormalizer, type ToolNormalizerAssociation, type ToolArgumentPreparation } from "./tool-argument-normalizer"

export type ListedTool = Info & { readonly id: string }
type Entry = { tool: ListedTool; inputDecoder?: ToolValueDecoder; outputDecoder?: ToolValueDecoder; normalizeInput?: ToolArgumentPreparation; nativeTaskPermission?: ReturnType<typeof bindNativeTaskTargetPermission> }

/** Rebuild this snapshot after host tool reload/context filtering. Existing bindings then retire. */
export function createToolRegistry(initial: readonly ListedTool[], adapters: Readonly<Record<string, PermissionAdapter>>, codecs: readonly ToolCodecAssociation[] = [], normalizers: readonly ToolNormalizerAssociation[] = [], nativePermissions: readonly NativeTaskTargetPermissionAssociation[] = []) {
  let generation = 0
  let retirement = new AbortController()
  let tools = new Map<string, Entry>()
  let ids = new Map<string, string>()
  const permissionAdapters = new Map(Object.entries(adapters))
  function replace(next: readonly ListedTool[], associations: readonly ToolCodecAssociation[] = [], normalizerAssociations: readonly ToolNormalizerAssociation[] = [], nativeAssociations: readonly NativeTaskTargetPermissionAssociation[] = []) {
    const snapshot = new Map<string, Entry>()
    const snapshotIds = new Map<string, string>()
    const nextGeneration = generation + 1
    const nextRetirement = new AbortController()
    const normalizerMap = new Map<ListedTool, ToolNormalizerAssociation>()
    for (const association of normalizerAssociations) {
      if (!next.includes(association.tool) || normalizerMap.has(association.tool)) throw Error("Ambiguous normalizer association")
      normalizerMap.set(association.tool, association)
    }
    const nativeMap = new Map<ListedTool, NativeTaskTargetPermissionAssociation>()
    for (const association of nativeAssociations) {
      if (!next.includes(association.tool) || nativeMap.has(association.tool) || permissionAdapters.has(association.tool.name) || association.tool.options?.permission) throw Error("Ambiguous Native task permission association")
      nativeMap.set(association.tool, association)
    }
    const explicit = new Map<ListedTool, ToolCodecAssociation>()
    for (const association of associations) {
      if (!next.includes(association.tool) || explicit.has(association.tool)) throw Error("Ambiguous codec association")
      explicit.set(association.tool, association)
    }
    for (const tool of next) {
      if (!tool.name || !tool.id || snapshot.has(tool.name) || snapshotIds.has(tool.id)) throw new Error("Ambiguous tool registry")
      snapshotIds.set(tool.id, tool.name)
      const association = explicit.get(tool)
      const input = association?.input && bindToolValueCodec(association.input, tool, "input")
      const output = association?.output && bindToolValueCodec(association.output, tool, "output")
      const normalizer = normalizerMap.get(tool)
      const normalizeInput = normalizer && bindToolArgumentNormalizer(normalizer.input, tool, {
        signal: nextRetirement.signal,
        assert: () => { if (generation !== nextGeneration || retirement !== nextRetirement) throw Error("Retired tool registry generation") },
      })
      const native = nativeMap.get(tool)
      const nativeTaskPermission = native && bindNativeTaskTargetPermission(native.permission, tool, {
        signal: nextRetirement.signal,
        assertCurrent: () => { if (generation !== nextGeneration || retirement !== nextRetirement) throw Error("Retired Native task permission generation") },
      })
      snapshot.set(tool.name, Object.freeze({
        tool: Object.freeze({ ...tool, ...(input && { input: input.schema as Info["input"] }), ...(output && { output: output.schema as Info["output"] }), options: tool.options && Object.freeze({ ...tool.options }) }),
        inputDecoder: input?.decode, outputDecoder: output?.decode,
        normalizeInput, nativeTaskPermission,
      }))
    }
    const prior = retirement
    tools = snapshot
    ids = snapshotIds
    generation = nextGeneration
    retirement = nextRetirement
    prior.abort(new Error("Retired tool registry generation"))
  }
  replace(initial, codecs, normalizers, nativePermissions)
  function get(name: string, expected: number) {
    if (expected !== generation) throw new Error("Retired tool registry generation")
    const entry = tools.get(name)
    if (!entry) throw new Error(`Unknown tool: ${name}`)
    const adapter = permissionAdapters.get(name)
    if (!adapter && !entry.nativeTaskPermission) throw new Error(`Unsupported resource permission mapping: ${name}`)
    return { ...entry, adapter }
  }
  return {
    replace,
    get generation() { return generation },
    retirementSignal(expected: number): AbortSignal {
      if (expected !== generation) throw new Error("Retired tool registry generation")
      return retirement.signal
    },
    getById(id: string, expected: number) {
      if (expected !== generation) throw new Error("Retired tool registry generation")
      const name = ids.get(id)
      if (name === undefined) throw new Error(`Unknown tool identifier: ${id}`)
      return get(name, expected)
    },
    get,
    assert(expected: number) {
      if (expected !== generation) throw new Error("Retired tool registry generation")
    },
  }
}
export type ToolRegistry = ReturnType<typeof createToolRegistry>
