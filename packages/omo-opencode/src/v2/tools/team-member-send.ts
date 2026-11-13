import type { AgentToolResult } from "@code-yeongyu/senpi"
import {
  createMemberTaskSendTool,
  createToolArgumentValidator,
  MemberTaskSendParams,
  type MemberTaskSendInput,
} from "@oh-my-opencode/senpi-task/task-operations"
import type { ToolDomain } from "@opencode/plugin/effect/tool"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { Effect } from "effect"
import { adaptNativeTaskResult } from "./native-task-result"
import { strictPublicInput } from "./native-task"

type ToolInfo = Awaited<Effect.Success<ReturnType<ToolDomain["list"]>>>[number]

/** Dedicated SDK capability for an in-process team member. The Native original name stays
 * `task_send` in its binding slot; the parent's public `task_send` keeps its own registration. */
export const TEAM_MEMBER_SEND_TOOL_NAME = "omo_team_send"
/** Whole-tool permission filtering uses this action, never the parent `task_send` rules. */
export const TEAM_MEMBER_SEND_PERMISSION = "omo_team_send"

/** Immutable actual SDK call source, captured before any owner callback runs. */
export interface TeamMemberSendCall {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
}
type TeamMemberSendDispatch = (
  call: TeamMemberSendCall,
  input: MemberTaskSendInput,
) => Promise<AgentToolResult<unknown>>

// The ORIGINAL Native description and schema; this template's closure is never invoked.
const native = createMemberTaskSendTool({
  teamRunId: "template",
  memberName: "template",
  taskId: "template",
  members: [],
  config: {
    enabled: false,
    tmux_visualization: false,
    max_parallel_members: 1,
    max_members: 1,
    max_messages_per_run: 1,
    max_wall_clock_minutes: 1,
    max_member_turns: 1,
    message_payload_max_bytes: 1024,
    recipient_unread_max_bytes: 1024,
    mailbox_poll_interval_ms: 500,
  },
})
const validateInput = createToolArgumentValidator(MemberTaskSendParams)

function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) return error
  return new ToolError({ message: error instanceof Error ? error.message : "Team member send failed", error })
}

/** Registration DATA only. `dispatch` resolves the producer bound to the actual caller session. */
export function createTeamMemberSendToolInfo(dispatch: TeamMemberSendDispatch): Omit<ToolInfo, "id"> {
  return {
    name: TEAM_MEMBER_SEND_TOOL_NAME,
    description: `Team member task_send. ${native.description}`,
    // The SAME original static schema object; decoding is checked below, never assumed.
    input: strictPublicInput(native.parameters),
    options: { codemode: false, permission: TEAM_MEMBER_SEND_PERMISSION },
    execute: (input, context) =>
      Effect.tryPromise({
        try: async () => {
          const params = validateInput(input)
          const call: TeamMemberSendCall = Object.freeze({
            sessionID: context.sessionID,
            agent: context.agent,
            messageID: context.messageID,
            id: context.id,
          })
          return adaptNativeTaskResult(await dispatch(call, params))
        },
        catch: toToolError,
      }),
  }
}
