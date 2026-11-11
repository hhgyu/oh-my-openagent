import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { loadOmoConfig } from "@oh-my-opencode/omo-config-core"
import {
  resolveMemberExtensionEntryPath,
  type ManagedChildHandle,
  type ManagedRunner,
  type ManagedStartSpec,
  type RunnerOutcome,
} from "@oh-my-opencode/senpi-task"
import { createTeamService as createSharedTeamService } from "@oh-my-opencode/senpi-task/team-operations"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import { composeTaskEngine } from "./engine"
import { createTeamService } from "./team-service"
import { createTeamServiceTestModelRegistry } from "./team-service-test-model-registry"

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function recordingRunner(started: ManagedStartSpec[]): ManagedRunner {
  return {
    start: (spec) => {
      started.push(spec)
      const handle: ManagedChildHandle = {
        task_id: spec.taskId,
        pid: undefined,
        sessionId: undefined,
        steer: () => Promise.resolve(),
        followUp: () => Promise.resolve(),
        abort: () => Promise.resolve(),
        subscribe: () => () => undefined,
        waitForOutcome: () => new Promise<RunnerOutcome>(() => undefined),
        lastAssistantText: () => undefined,
        dispose: () => Promise.resolve(),
      }
      return Promise.resolve(handle)
    },
  }
}

function senpiAdapterHarness() {
  const cwd = mkdtempSync(join(tmpdir(), "omo-senpi-team-service-launch-"))
  tempRoots.push(cwd)
  mkdirSync(join(cwd, ".omo"), { recursive: true })
  writeFileSync(join(cwd, ".omo", "omo.json"), `${JSON.stringify({
    categories: { quick: { model: "omo-mock/mock-1" } },
  })}\n`)
  const processStarts: ManagedStartSpec[] = []
  const inProcessStarts: ManagedStartSpec[] = []
  const omoConfig = loadOmoConfig({ cwd }).config
  const engine = composeTaskEngine({
    pi: new FakeExtensionAPI(),
    omoConfig,
    cwd,
    sharedParentTools: () => [],
    runnerFactories: { inProcess: () => recordingRunner(inProcessStarts), process: () => recordingRunner(processStarts) },
  })
  engine.runtime.captureFrom({
    modelRegistry: createTeamServiceTestModelRegistry(),
    sessionManager: { getSessionId: () => "lead-session" },
  })
  const service = createTeamService({
    manager: engine.manager,
    destruction: engine.lifecycle,
    runtime: engine.runtime,
    settings: engine.settings,
    omoConfig,
    cwd,
    agentNames: new Set(Object.keys(engine.agents)),
  })
  const inProcessService = createSharedTeamService({
    manager: engine.manager,
    destruction: engine.lifecycle,
    leadSessionId: () => "lead-session",
    memberLaunch: () => ({ kind: "in-process" }),
    settings: engine.settings,
    omoConfig,
    cwd,
    agentNames: new Set(Object.keys(engine.agents)),
  })
  return { service, inProcessService, processStarts, inProcessStarts }
}

describe("createTeamService Senpi adapter member launch", () => {
  test("#given the Senpi adapter #when createTeam runs #then the member starts as a process with the member extension and member env", async () => {
    // given
    const originalArgv = process.argv
    process.argv = ["node", "senpi", "-e", "/tmp/omo.js", "--extension", "/tmp/mock-provider.ts"]
    try {
      const { service, processStarts, inProcessStarts } = senpiAdapterHarness()

      // when
      const created = await service.createTeam({
        inlineSpec: {
          name: "launch-spec",
          members: [{ name: "beta", kind: "category", category: "quick", prompt: "work" }],
        },
      })

      // then
      expect(inProcessStarts).toEqual([])
      expect(processStarts).toHaveLength(1)
      const spec = processStarts[0]
      expect(spec?.extensions).toEqual([resolveMemberExtensionEntryPath(), "/tmp/omo.js", "/tmp/mock-provider.ts"])
      expect(Object.keys(spec?.memberEnv ?? {}).sort()).toEqual(["SENPI_TASK_MEMBER", "SENPI_TASK_MEMBER_TASK_ID", "SENPI_TASK_TEAM_CONFIG"])
      expect(spec?.memberEnv?.SENPI_TASK_MEMBER).toBe(`${created.runtimeState.teamRunId}::beta`)
      expect(spec?.memberEnv?.SENPI_TASK_MEMBER_TASK_ID).toBe(created.memberTaskIds.beta)
      const teamConfig: unknown = JSON.parse(spec?.memberEnv?.SENPI_TASK_TEAM_CONFIG ?? "null")
      expect(teamConfig).toMatchObject({ members: ["beta"] })
    } finally {
      process.argv = originalArgv
    }
  })

  test("#given an in-process member launch #when createTeam runs #then the member starts in-process with its task_send and no extension or member env", async () => {
    // given
    const { inProcessService, processStarts, inProcessStarts } = senpiAdapterHarness()

    // when
    const created = await inProcessService.createTeam({
      inlineSpec: {
        name: "launch-spec",
        members: [{ name: "beta", kind: "category", category: "quick", prompt: "work" }],
      },
    })

    // then
    expect(processStarts).toEqual([])
    expect(inProcessStarts).toHaveLength(1)
    const spec = inProcessStarts[0]
    expect(spec?.extensions).toBeUndefined()
    expect(spec?.memberEnv).toBeUndefined()
    expect(spec?.memberScopedTools?.map((tool) => tool.name)).toEqual(["task_send"])
    expect(spec?.memberScopedToolNames).toEqual(["task_send"])
    expect(spec?.taskId).toBe(created.memberTaskIds.beta)
  })
})
