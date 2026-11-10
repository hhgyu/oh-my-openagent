// Wire contract of the memory command output event, shared by the server component that emits it and
// the TUI plugin that shows it. Dependency-free so the TUI entry does not load the memory component.

/** RPC definition id; OpenCode names its events `rpc.<id>.<event>`. */
export const MEMORY_COMMAND_RPC_ID = "omo-memory"
export const MEMORY_COMMAND_OUTPUT_EVENT = "command.output"
export const MEMORY_COMMAND_OUTPUT_EVENT_TYPE = `rpc.${MEMORY_COMMAND_RPC_ID}.${MEMORY_COMMAND_OUTPUT_EVENT}` as const

export type MemoryCommandOutputLevel = "info" | "warning" | "error"

export interface MemoryCommandOutputEvent {
  readonly sessionID: string
  readonly command: string
  readonly level: MemoryCommandOutputLevel
  readonly text: string
}

/** The event payload, or undefined when `data` is not one (a foreign or newer emitter). */
export function readMemoryCommandOutputEvent(data: unknown): MemoryCommandOutputEvent | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined
  const { sessionID, command, level, text } = data as Record<string, unknown>
  if (typeof sessionID !== "string" || typeof command !== "string" || typeof text !== "string") return undefined
  if (level !== "info" && level !== "warning" && level !== "error") return undefined
  return { sessionID, command, level, text }
}
