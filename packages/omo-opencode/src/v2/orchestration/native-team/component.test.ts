import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Info, ToolContext, ToolEditor as PromiseToolEditor } from "@opencode/plugin/promise/tool"
import type { ToolDomain, ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Exit, Scope } from "effect"
import { teamStorageBaseDir, toTeamCoreConfig } from "@oh-my-opencode/senpi-task/team-operations"
import { getInboxDir, resolveBaseDir } from "@oh-my-opencode/team-core/team-registry/paths"
import { loadRuntimeState, transitionRuntimeState } from "@oh-my-opencode/team-core/team-state-store"
import type { ListedTool } from "../../host/tool-registry"
import { nativeTeamEnabled } from "../../index"
import { createNativeTaskBridge } from "../../tools/native-task"
import type { PreparedNativeTaskRuntime } from "../../tools/native-task-preparation"
import { NATIVE_TEAM_TOOL_NAMES } from "../../tools/native-team-codecs"
import { TEAM_MEMBER_SEND_TOOL_NAME } from "../../tools/team-member-send"
import { createNativeChildGuardBinding } from "../native-task/child-guard-binding"
import { childCatalog, nativeTeamSettings } from "../native-task/component"
import { acquireTeamMemberOwner, type TeamMemberOwner } from "../native-task/live-member-owner"
import type { NativeTaskTargetPermissionAssociation } from "../native-task/service"
import { withNativeTargetPermissionService } from "../native-task/service.test"
import { assertRootLead, registerNativeTeamComponent, resolveOwnedTeamRunId } from "./component"

type PublicTool = Info & { readonly id: string }
type EffectInfo = ReturnType<ToolEditor["list"]>[number]
type EffectContext = Parameters<EffectInfo["execute"]>[1]
type ServiceFixture = Parameters<Parameters<typeof withNativeTargetPermissionService>[0]>[0]
type ChildGuardBinding = NonNullable<
  NonNullable<Parameters<typeof withNativeTargetPermissionService>[1]>["childGuardBinding"]
>

const LEAD = "ses_team_lead"
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}

function details(result: unknown): Record<string, unknown> {
  const metadata = typeof result === "object" && result !== null && "metadata" in result ? result.metadata : undefined
  const native = typeof metadata === "object" && metadata !== null && "native" in metadata ? metadata.native : undefined
  const value = typeof native === "object" && native !== null && "details" in native ? native.details : undefined
  if (typeof value !== "object" || value === null) throw new Error("Missing Native result details")
  return { ...value }
}

/** Controlled UNIT effect tool domain carrying the REAL member send registration. */
async function memberOwner() {
  const scope = Scope.makeUnsafe(),
    tools = new Map<string, EffectInfo>()
  const editor: ToolEditor = {
    list: () => [...tools.values()],
    get: (id) => tools.get(id),
    namespace() {},
    remove: (id) => {
      tools.delete(id)
    },
    add: (value) => {
      tools.set(value.name, { ...value, id: value.name })
    },
    update: (id, change) => {
      const value = tools.get(id)
      if (value) change(value)
    },
  }
  const domain: Pick<ToolDomain, "transform" | "list"> = {
    transform: (callback) =>
      Effect.sync(() => {
        callback(editor)
        return { dispose: Effect.void }
      }),
    list: () => Effect.sync(() => [...tools.values()]),
  }
  const owner = await Effect.runPromise(
    Effect.provideService(acquireTeamMemberOwner({ tool: domain }), Scope.Scope, scope),
  )
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))))
  const send = (sessionID: string, input: unknown) => {
    const context: EffectContext = {
      sessionID: sessionID as EffectContext["sessionID"],
      agent: "build" as EffectContext["agent"],
      messageID: "unit-message" as EffectContext["messageID"],
      id: "unit-member-call" as EffectContext["id"],
      progress: () => Effect.void,
    }
    return Effect.runPromiseExit(defined(tools.get(TEAM_MEMBER_SEND_TOOL_NAME)).execute(input, context))
  }
  return { owner, send }
}

/** Controlled UNIT promise tool domain recording the public registrations. */
function publicDomain() {
  const tools: PublicTool[] = []
  const editor: PromiseToolEditor = {
    list: () => tools,
    get: (id: string) => tools.find((tool) => tool.id === id),
    namespace() {},
    add(value) {
      tools.push({ ...value, id: `public-${value.name}` })
    },
    update(id, edit) {
      edit(defined(tools.find((tool) => tool.id === id)))
    },
    remove() {},
  }
  const domain = {
    async hook() {
      return { async dispose() {} }
    },
    async transform(change: (editor: PromiseToolEditor) => void) {
      change(editor)
      return { async dispose() {} }
    },
    async list() {
      return tools
    },
    async reload() {},
  }
  const find = (name: string) => defined(tools.find((tool) => tool.name === name))
  return { tools, domain, find }
}

/** The component's assembly over REAL service, kernel, registry, guard and member owner: the team
 * targets join the task targets in one registry generation, and `task_send` gains lead routing. */
async function withLeadTeam(
  run: (
    value: ServiceFixture & {
      owner: TeamMemberOwner
      memberSend: Awaited<ReturnType<typeof memberOwner>>["send"]
      call(name: string, input: unknown, sessionID?: string): Promise<unknown>
    },
  ) => Promise<void>,
  options: { refuseMember?: string } = {},
) {
  const { owner, send } = await memberOwner()
  let directory = "",
    config: PreparedNativeTaskRuntime["config"] | undefined
  const members = createNativeChildGuardBinding({
    assertGeneration() {},
    member: {
      owner,
      teamConfigFor: (lead) => {
        const settings = nativeTeamSettings(directory, lead, defined(config))
        return toTeamCoreConfig(
          settings,
          teamStorageBaseDir({ project_dir: directory, task: { state_dir: settings.state_dir } }),
        )
      },
    },
  })
  const childGuardBinding: ChildGuardBinding = (spec, prepared, origin) => {
    if (options.refuseMember !== undefined && origin?.team?.memberName === options.refuseMember)
      throw Error(`Unit refused member ${options.refuseMember}`)
    return members(spec, prepared, origin)
  }
  await withNativeTargetPermissionService(
    async (fixture) => {
      const { service, registry, kernel, f } = fixture
      directory = f.dir
      config = await f.options.config()
      const prepared = {
        config,
        agents: {},
        authorizeSkills: async () => () => ({ prepend: "", resolved: [], missing: [] }),
      } as unknown as PreparedNativeTaskRuntime
      const publics = publicDomain()
      const teamTargets =
        Promise.withResolvers<Parameters<Parameters<typeof registerNativeTeamComponent>[0]["register"]>[0]>()
      const teamRegistered = Promise.withResolvers<readonly NativeTaskTargetPermissionAssociation[]>()
      const team = registerNativeTeamComponent({
        tool: publics.domain,
        directory,
        prepared,
        registry,
        kernel,
        service,
        assertCurrent() {},
        register(targets) {
          teamTargets.resolve(targets)
          return teamRegistered.promise
        },
      })
      const bridge = createNativeTaskBridge({
        tool: publics.domain,
        prepared,
        async rollbackAcquisition() {
          await service.close()
        },
        async acquire(targets) {
          const teamDefinitions = await teamTargets.promise
          const targetPermissions = targets.tools.map((tool) => ({ tool, permission: service.targetPermission(tool) }))
          const teamPermissions = teamDefinitions.tools.map((tool) => ({
            tool,
            permission: service.targetPermission(tool),
          }))
          registry.replace(
            [...targets.tools, ...teamDefinitions.tools],
            [...targets.codecs, ...teamDefinitions.codecs],
            targets.normalizers,
            [...targetPermissions, ...teamPermissions],
          )
          teamRegistered.resolve(teamPermissions)
          return {
            registry,
            kernel,
            service,
            targetPermissions,
            teamRouting: (caller, call) => team.teamRouting(caller, call),
            context(caller) {
              return { cwd: f.dir, sessionManager: { getSessionId: () => caller.sessionID } }
            },
            taskDependencies: () => ({}),
            outputDependencies: () => ({ stateDir: f.dir }),
            async release() {},
          }
        },
      })
      try {
        await bridge.ready
        await team.ready
        const callers = new Map<string, ToolContext>()
        const call = (name: string, input: unknown, sessionID = LEAD) => {
          const caller = callers.get(sessionID) ?? f.raw(sessionID).caller
          callers.set(sessionID, caller)
          return publics.find(name).execute(input, caller)
        }
        await run({ ...fixture, owner, memberSend: send, call })
      } finally {
        await service.close()
        await team.close()
        await bridge.close()
      }
    },
    {
      childGuardBinding,
      policyTools: ["task", "task_output", "task_send", "task_cancel", ...NATIVE_TEAM_TOOL_NAMES, "read"],
    },
  )
}

function leadTeamConfig(directory: string, config: PreparedNativeTaskRuntime["config"]) {
  const settings = nativeTeamSettings(directory, LEAD, config)
  return toTeamCoreConfig(
    settings,
    teamStorageBaseDir({ project_dir: directory, task: { state_dir: settings.state_dir } }),
  )
}

function inbox(
  directory: string,
  config: PreparedNativeTaskRuntime["config"],
  runId: string,
  recipient: string,
): unknown[] {
  const dir = getInboxDir(resolveBaseDir(leadTeamConfig(directory, config)), runId, recipient)
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")))
    : []
}

const TWO_MEMBERS = {
  inline_spec: {
    name: "unit-team",
    members: [
      { name: "alpha", category: "qa", prompt: "block alpha" },
      { name: "beta", category: "qa", prompt: "block beta" },
    ],
  },
}

describe("#given the lead team component", () => {
  test("#then it is enabled unless explicitly disabled", () => {
    expect(nativeTeamEnabled(undefined)).toBe(true)
    expect(nativeTeamEnabled({})).toBe(true)
    expect(nativeTeamEnabled({ "omo-native-team-enabled": false })).toBe(false)
  })

  test("#then the 6 lead team tools are never child catalog grants", () => {
    // given
    const catalog = [...NATIVE_TEAM_TOOL_NAMES, "read"].map(
      (name) => ({ id: name, name, description: name }) as unknown as ListedTool,
    )
    // when
    const granted = childCatalog(catalog).map((tool) => tool.name)
    // then
    expect(granted).toEqual(["read"])
  })

  test("#then an owned child is never a lead", () => {
    // given
    const child = { resolveAncestry: () => ({ rootSessionId: "ses_root", depth: 1 }) }
    const root = { resolveAncestry: (sessionID: string) => ({ rootSessionId: sessionID, depth: 0 }) }
    // then
    expect(() => assertRootLead("ses_child", child)).toThrow("root lead session")
    expect(() => assertRootLead("ses_root", root)).not.toThrow()
  })

  test("#then a message naming no team run defaults only to the single owned team", async () => {
    // given
    const row = (teamRunId: string, leadSessionId: string) => ({
      teamRunId,
      teamName: teamRunId,
      status: "active",
      memberCount: 1,
      scope: "project" as const,
      leadSessionId,
    })
    // when
    const single = await resolveOwnedTeamRunId(
      { listTeams: async () => [row("run-a", LEAD), row("run-b", "ses_other")] },
      LEAD,
    )
    const none = await resolveOwnedTeamRunId({ listTeams: async () => [row("run-b", "ses_other")] }, LEAD)
    const many = await resolveOwnedTeamRunId({ listTeams: async () => [row("run-a", LEAD), row("run-c", LEAD)] }, LEAD)
    // then
    expect(single).toEqual({ kind: "resolved", teamRunId: "run-a" })
    expect(none).toEqual({ kind: "none" })
    expect(many.kind).toBe("ambiguous")
  })
})

describe("#given a root lead calling team_create with 2 members", () => {
  test("#when the call returns #then 2 in-process owned members are bound and the team is active, and the lead team surface round-trips", async () => {
    await withLeadTeam(async ({ f, owner, memberSend, call }) => {
      // when
      const created = details(await call("team_create", TWO_MEMBERS))
      // then
      expect(created.kind).toBe("created")
      const runId = String(created.team_run_id),
        config = await f.options.config()
      const state = await loadRuntimeState(runId, leadTeamConfig(f.dir, config))
      expect(state.status).toBe("active")
      expect(state.leadSessionId).toBe(LEAD)
      const sessions = state.members.map((member) => defined(member.sessionId))
      expect(sessions).toHaveLength(2)
      expect(f.calls.filter((entry) => entry === "create")).toHaveLength(2)
      expect(sessions.every((sessionID) => owner.isBound(sessionID))).toBe(true)

      // when: task CRUD round-trips in team-core
      const task = details(await call("task_create", { team_run_id: runId, subject: "unit", description: "unit work" }))
      const taskId = String(task.task_id ?? (task.task as { id?: string } | undefined)?.id)
      const listed = details(await call("task_list", { team_run_id: runId }))
      const updated = details(
        await call("task_update", { team_run_id: runId, task_id: taskId, status: "claimed", owner: "alpha" }),
      )
      const read = details(await call("task_get", { team_run_id: runId, task_id: taskId }))
      // then
      expect(task.kind).toBe("created")
      expect(JSON.stringify(listed)).toContain(taskId)
      expect(updated.kind).toBe("updated")
      expect(JSON.stringify(read)).toContain("claimed")

      // when: another root session names the lead's team run
      const foreign = await call("task_list", { team_run_id: runId }, "ses_not_the_lead").then(
        (result) => JSON.stringify(details(result)),
        (error: unknown) => String(error),
      )
      // then: team storage is per lead, so the run and its tasks are not visible to it
      expect(foreign).toBe(JSON.stringify({ kind: "list", tasks: [] }))

      // when: the lead messages a member through its public task_send
      const sent = details(await call("task_send", { to: "alpha", message: "lead work" }))
      // then
      expect(sent.kind).toBe("team_message")
      const toAlpha = inbox(f.dir, config, runId, "alpha")
      expect(toAlpha).toHaveLength(1)
      expect(toAlpha[0]).toMatchObject({ from: "lead", to: "alpha", body: "lead work" })

      // when: a member reports to the lead through its bound send
      const reported = await memberSend(defined(sessions[0]), { to: "lead", message: "member report" })
      // then
      expect(Exit.isSuccess(reported)).toBe(true)
      const toLead = inbox(f.dir, config, runId, "lead")
      expect(toLead).toHaveLength(1)
      expect(toLead[0]).toMatchObject({ to: "lead", body: "member report" })
      const alpha = (created.members as { task_id: string; name: string }[]).find((member) => member.name === "alpha")
      const events: { type: string; payload: unknown }[] = readFileSync(
        join(f.dir, LEAD, "logs", `${defined(alpha).task_id}.jsonl`),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      const leadLog = join(
        defined(nativeTeamSettings(f.dir, LEAD, config).state_dir),
        "logs",
        `${defined(alpha).task_id}.jsonl`,
      )
      const leadEvents: { type: string; payload: unknown }[] = readFileSync(leadLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
      expect(leadEvents.filter((event) => event.type === "team_message_sent").map((event) => event.payload)).toEqual([
        { message_id: (toAlpha[0] as { messageId: string }).messageId, from: "lead", to: "alpha", kind: "message" },
      ])
      expect(events.filter((event) => event.type === "team_message_sent").map((event) => event.payload)).toEqual([
        { message_id: (toLead[0] as { messageId: string }).messageId, from: "alpha", to: "lead", kind: "message" },
      ])

      // when
      const deleted = details(await call("team_delete", { team_run_id: runId, force: true }))
      // then
      expect(deleted.kind).toBe("deleted")
      expect(sessions.some((sessionID) => owner.isBound(sessionID))).toBe(false)
    })
  })

  test("#when one member start is refused #then the created member is cancelled and the team fails", async () => {
    await withLeadTeam(
      async ({ f, owner, call }) => {
        // when
        const outcome = await call("team_create", TWO_MEMBERS).then(
          (result) => JSON.stringify(details(result)),
          (error: unknown) => String(error),
        )
        // then
        expect(outcome).toContain("beta")
        const config = leadTeamConfig(f.dir, await f.options.config())
        const runs = readdirSync(join(resolveBaseDir(config), "runtime"))
        expect(runs).toHaveLength(1)
        const state = await loadRuntimeState(defined(runs[0]), config)
        expect(state.status).toBe("failed")
        const tasks = join(f.dir, LEAD, "tasks")
        const records = readdirSync(tasks)
          .filter((name) => name.endsWith(".json"))
          .map((name) => JSON.parse(readFileSync(join(tasks, name), "utf8")))
        const alpha = defined(records.find((record) => String(record.name).endsWith(":alpha"))),
          beta = defined(records.find((record) => String(record.name).endsWith(":beta")))
        expect(alpha.status).toBe("cancelled")
        expect(owner.isBound(String(alpha.child_session_id))).toBe(false)
        expect(beta.status).toBe("error")
        expect(f.calls.filter((entry) => entry === "create")).toHaveLength(1)
        expect(f.calls).toContain("remove")
      },
      { refuseMember: "beta" },
    )
  })

  test("#when both members finished their turn #then team_delete releases and destroys them and the team is deleted", async () => {
    await withLeadTeam(async ({ f, owner, call }) => {
      // given
      const { runId, sessions, taskIds, config } = await idleTeam(f, call)
      // when
      const deleted = details(await call("team_delete", { team_run_id: runId }))
      // then
      expect(deleted.kind).toBe("deleted")
      expect(deleted.cancelled_task_ids).toEqual([])
      expect(deleted.released_task_ids).toEqual(taskIds)
      await expectTornDown(f, owner, { runId, sessions, taskIds, config })
      expect(f.calls.filter((entry) => entry === "remove")).toHaveLength(2)
    })
  })

  test("#when a delete stopped half-way with alpha released and beta still resident #then a retry completes", async () => {
    await withLeadTeam(async ({ f, owner, call }) => {
      // given
      const { runId, sessions, taskIds, config } = await idleTeam(f, call)
      expect(details(await call("task_cancel", { task_id: defined(taskIds[0]) })).kind).toBe("released")
      await transitionRuntimeState(runId, (state) => ({ ...state, status: "deleting" }), leadTeamConfig(f.dir, config))
      // when
      const deleted = details(await call("team_delete", { team_run_id: runId }))
      // then
      expect(deleted.kind).toBe("deleted")
      await expectTornDown(f, owner, { runId, sessions, taskIds, config })
      // beta, still resident, is released and destroyed by the retry itself
      expect(f.calls.filter((entry) => entry === "remove")).toHaveLength(1)
    })
  })
})

type LeadTeamFixture = Parameters<Parameters<typeof withLeadTeam>[0]>[0]

/** A created team whose 2 members each finished their first turn and stay resident and idle. */
async function idleTeam(f: LeadTeamFixture["f"], call: LeadTeamFixture["call"]) {
  const created = details(await call("team_create", TWO_MEMBERS))
  const runId = String(created.team_run_id),
    config = await f.options.config()
  const taskIds = (created.members as { task_id: string }[]).map((member) => member.task_id)
  const state = await loadRuntimeState(runId, leadTeamConfig(f.dir, config))
  const sessions = state.members.map((member) => defined(member.sessionId))
  for (const sessionID of sessions) f.finishChild(sessionID, "member idle")
  for (const id of taskIds) await waitFor(() => record(f.dir, id)?.status === "completed")
  return { runId, sessions, taskIds, config }
}

async function expectTornDown(
  f: LeadTeamFixture["f"],
  owner: TeamMemberOwner,
  team: Awaited<ReturnType<typeof idleTeam>>,
) {
  expect(existsSync(join(resolveBaseDir(leadTeamConfig(f.dir, team.config)), "runtime", team.runId))).toBe(false)
  for (const id of team.taskIds) expect(record(f.dir, id)?.residency_state).not.toBe("resident")
  expect(team.sessions.some((sessionID) => owner.isBound(sessionID))).toBe(false)
}

function record(directory: string, id: string): Record<string, unknown> | undefined {
  const file = join(directory, LEAD, "tasks", `${id}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (condition()) return
    await Bun.sleep(10)
  }
  throw Error("Condition not reached")
}
