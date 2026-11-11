import { describe, expect, test } from "bun:test"

import type { ManagerStartSpec, StartResult } from "../manager"
import { normalizeSenpiTeamSpec } from "./normalize"
import type { TeamCoreConfig } from "./runtime-config"
import type { TeamRuntimeManagerPort } from "./runtime-types"
import { spawnTeamMembers } from "./spawn-members"

const RUN = "11111111-1111-4111-8111-111111111111"
const TEAM_CONFIG: TeamCoreConfig = {
  enabled: true, tmux_visualization: false, max_parallel_members: 4, max_members: 8, max_messages_per_run: 10000, max_wall_clock_minutes: 120,
  max_member_turns: 500, base_dir: "/teams", message_payload_max_bytes: 32768, recipient_unread_max_bytes: 262144, mailbox_poll_interval_ms: 3000,
}

function recordingManager(captured: ManagerStartSpec[]): TeamRuntimeManagerPort {
  return {
    start: async (spec: ManagerStartSpec): Promise<StartResult> => {
      captured.push(spec)
      return { kind: "started", task_id: `st_${captured.length}`, status: "running", name: spec.name ?? "member" }
    },
    cancelTask: async () => {
      throw new Error("recording manager cancelTask not configured")
    },
    get: () => undefined,
    getResidentHandle: () => undefined,
  }
}

function spawnInput(captured: ManagerStartSpec[]) {
  return {
    spec: normalizeSenpiTeamSpec({ members: [
      { name: "alpha", kind: "category", category: "quick", prompt: "lead work" },
      { name: "beta", kind: "subagent_type", subagent_type: "sisyphus-junior", prompt: "work" },
    ] }, "demo"),
    teamRunId: RUN,
    manager: recordingManager(captured),
    leadSessionId: "lead-session",
    spawnDepth: 1,
    maxParallel: 1,
    deadlineAt: 1,
    now: () => 0,
  }
}

describe("spawnTeamMembers member launch kind", () => {
  test("#given in-process members #when spawned #then each start is in-process with the member task_send and no extension or member env", async () => {
    // given
    const captured: ManagerStartSpec[] = []

    // when
    const result = await spawnTeamMembers({ ...spawnInput(captured), inProcess: { teamConfig: TEAM_CONFIG } })

    // then
    expect(result.failure).toBeUndefined()
    expect(captured).toHaveLength(2)
    for (const spec of captured) {
      expect(spec.execution_mode).toBe("in-process")
      expect(spec.extensions).toBeUndefined()
      expect(spec.memberEnv).toBeUndefined()
      expect(spec.team_run_id).toBe(RUN)
      expect(spec.team_role).toBe("member")
      expect(spec.memberScopedTools?.map((tool) => tool.name)).toEqual(["task_send"])
    }
    expect(captured.map((spec) => spec.team_member_name)).toEqual(["alpha", "beta"])
    expect(captured[1]).toMatchObject({ name: `team:${RUN}:beta`, subagent_type: "sisyphus-junior", run_in_background: true, parent_session_id: "lead-session" })
  })

  test("#given process members #when spawned #then the start keeps the process shape with no member-scoped tools", async () => {
    // given
    const captured: ManagerStartSpec[] = []

    // when
    const result = await spawnTeamMembers({
      ...spawnInput(captured),
      memberExtension: { entryPath: "/trusted/member-extension.js", inheritedExtensions: [], teamConfig: "{}" },
    })

    // then
    expect(result.failure).toBeUndefined()
    const spec = captured[0]
    expect(spec?.execution_mode).toBe("process")
    expect(spec?.memberScopedTools).toBeUndefined()
    expect(spec?.extensions).toEqual(["/trusted/member-extension.js"])
    expect(spec?.memberEnv).toEqual({ SENPI_TASK_MEMBER: `${RUN}::alpha`, SENPI_TASK_TEAM_CONFIG: "{}" })
  })
})
