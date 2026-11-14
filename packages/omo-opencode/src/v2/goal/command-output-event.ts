// Wire contract of the `/omo:goal` output event, shared by the goal component that emits it and the TUI plugin that
// shows it. Its payload is the memory command output payload (../memory/command-output-event). Dependency-free so the
// TUI entry does not load the goal component.

export const GOAL_COMMAND_RPC_ID = "omo-goal"
export const GOAL_COMMAND_OUTPUT_EVENT = "command.output"
export const GOAL_COMMAND_OUTPUT_EVENT_TYPE = `rpc.${GOAL_COMMAND_RPC_ID}.${GOAL_COMMAND_OUTPUT_EVENT}` as const
