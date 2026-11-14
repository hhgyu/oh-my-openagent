// Wire contract of the computer-use events, shared by the server component that emits them and the TUI plugin that
// shows them. Dependency-free so the TUI entry does not load the component. `/computer` output has the memory
// command output shape (`readMemoryCommandOutputEvent` reads it).

export const COMPUTER_RPC_ID = "omo-computer"
export const COMPUTER_COMMAND_OUTPUT_EVENT = "command.output"
export const COMPUTER_PERMISSION_EVENT = "permission.required"
export const COMPUTER_COMMAND_OUTPUT_EVENT_TYPE = `rpc.${COMPUTER_RPC_ID}.${COMPUTER_COMMAND_OUTPUT_EVENT}` as const
export const COMPUTER_PERMISSION_EVENT_TYPE = `rpc.${COMPUTER_RPC_ID}.${COMPUTER_PERMISSION_EVENT}` as const

export interface ComputerPermissionEvent {
  readonly sessionID: string
  readonly permission: "screen_recording" | "accessibility"
  readonly app: string
}

export function readComputerPermissionEvent(data: unknown): ComputerPermissionEvent | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined
  const { sessionID, permission, app } = data as Record<string, unknown>
  if (typeof sessionID !== "string" || typeof app !== "string") return undefined
  if (permission !== "screen_recording" && permission !== "accessibility") return undefined
  return { sessionID, permission, app }
}
