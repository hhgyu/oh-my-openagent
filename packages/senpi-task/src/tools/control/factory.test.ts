import { describe, expect, test } from "bun:test"

import { defaultResolveCallerSessionId } from "./caller-session"
import { TaskCancelParams, createTaskCancelTool } from "./cancel"
import { MemberScopedTaskSendParams, TaskSendParams, createMemberScopedTaskSendTool, createTaskSendTool } from "./send"
import { createFakeTeamService } from "../team/__fixtures__/team-tool-fakes"
import { buildLeadTeamTools } from "../team"
import { createMemberTaskSendTool } from "../../team/member-extension/tools"
import { TeamModeConfigSchema } from "@oh-my-opencode/team-core/config"
import type { CancelManager, SendManager } from "./types"

const sendManager: SendManager = {
  sendToTask: () => Promise.reject(new Error("unused")),
  list: () => [],
}
const cancelManager: CancelManager = { cancelTask: () => Promise.reject(new Error("unused")), get: () => undefined }

describe("control tool factories", () => {
  test("#given invalid task_send fields #when prepared for host validation #then diagnostics identify fields without argument values", () => {
    const tool = createTaskSendTool({ manager: sendManager })
    for (const [input, fields] of [
      [{ to: "child", message: "hello", task_id: "private-value" }, ["task_id"]],
      [{ message: "hello" }, ["to"]],
      [{ to: 42, message: "hello" }, ["to"]],
    ] as const) {
      let diagnostic: unknown
      try {
        tool.prepareArguments?.(input)
      } catch (error) {
        diagnostic = JSON.parse((error as Error).message)
      }
      expect(diagnostic).toMatchObject({
        code: "invalid_arguments",
        fields,
        expected_fields: ["to", "message", "team_run_id", "summary", "all_scope", "redispatch"],
      })
      expect(JSON.stringify(diagnostic)).not.toContain("private-value")
    }
  })

  test("#given sibling control and lead tools #when an unknown field is prepared #then each uses its own field diagnostic", () => {
    const member = createMemberScopedTaskSendTool({
      manager: sendManager,
      service: createFakeTeamService(),
      teamRunId: "run-1",
      from: "alpha",
    })
    const residentMember = createMemberTaskSendTool({
      teamRunId: "run-1",
      memberName: "alpha",
      taskId: "st_1",
      members: [],
      config: TeamModeConfigSchema.parse({}),
    })
    const tools = [
      createTaskCancelTool({ manager: cancelManager }),
      member,
      residentMember,
      ...buildLeadTeamTools({ service: createFakeTeamService() }),
    ]
    for (const tool of tools) {
      let diagnostic: unknown
      try {
        tool.prepareArguments?.({ misspelled: "private-value" })
      } catch (error) {
        diagnostic = JSON.parse((error as Error).message)
      }
      expect(diagnostic).toMatchObject({
        code: "invalid_arguments",
        fields: expect.arrayContaining(["misspelled"]),
        expected_fields: Object.keys(tool.parameters.properties),
      })
    }
  })

  test("#given the control factories #when built #then names, labels, and TypeBox params are wired", () => {
    // given / when
    const send = createTaskSendTool({ manager: sendManager })
    const cancel = createTaskCancelTool({ manager: cancelManager })
    const memberSend = createMemberScopedTaskSendTool({
      manager: sendManager,
      service: createFakeTeamService(),
      teamRunId: "run-1",
      from: "alpha",
    })

    // then
    expect(send.name).toBe("task_send")
    expect(send.parameters).toBe(TaskSendParams)
    expect(memberSend.name).toBe("task_send")
    expect(memberSend.parameters).toBe(MemberScopedTaskSendParams)
    expect(cancel.name).toBe("task_cancel")
    expect(cancel.parameters).toBe(TaskCancelParams)
    for (const tool of [send, memberSend, cancel]) {
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.label.length).toBeGreaterThan(0)
    }
  })

  test("#given the default resolver #when a session carrier is passed #then the current session id is read", () => {
    // given
    const carrier = { sessionManager: { getSessionId: () => "session-live" } }

    // when
    const resolved = defaultResolveCallerSessionId(carrier)

    // then
    expect(resolved).toBe("session-live")
  })
})
