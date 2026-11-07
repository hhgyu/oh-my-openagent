import type { Info } from "@opencode/plugin/promise/tool"
import type { PermissionAdapter } from "./permission-adapters"

export type ListedTool = Info & { readonly id: string }

/** Rebuild this snapshot after host tool reload/context filtering. Existing bindings then retire. */
export function createToolRegistry(initial: readonly ListedTool[], adapters: Readonly<Record<string, PermissionAdapter>>) {
  let generation = 0
  let tools = new Map<string, ListedTool>()
  const permissionAdapters = new Map(Object.entries(adapters))
  function replace(next: readonly ListedTool[]) {
    const snapshot = new Map<string, ListedTool>()
    for (const tool of next) {
      if (!tool.name || snapshot.has(tool.name)) throw new Error("Ambiguous tool registry")
      snapshot.set(tool.name, Object.freeze({ ...tool, options: tool.options && Object.freeze({ ...tool.options }) }))
    }
    tools = snapshot
    generation++
  }
  replace(initial)
  return {
    replace,
    get generation() { return generation },
    get(name: string, expected: number) {
      if (expected !== generation) throw new Error("Retired tool registry generation")
      const tool = tools.get(name)
      if (!tool) throw new Error(`Unknown tool: ${name}`)
      const adapter = permissionAdapters.get(name)
      if (!adapter) throw new Error(`Unsupported resource permission mapping: ${name}`)
      return { tool, adapter }
    },
    assert(expected: number) {
      if (expected !== generation) throw new Error("Retired tool registry generation")
    },
  }
}
export type ToolRegistry = ReturnType<typeof createToolRegistry>
