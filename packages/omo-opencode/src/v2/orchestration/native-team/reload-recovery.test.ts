import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Info, ToolContext, ToolEditor as PromiseToolEditor } from "@opencode/plugin/promise/tool"
import type { ToolDomain, ToolEditor } from "@opencode/plugin/effect/tool"
import { Effect, Exit, Scope } from "effect"
import { teamStorageBaseDir, toTeamCoreConfig } from "@oh-my-opencode/senpi-task/team-operations"
import { reserveMessageForDelivery } from "@oh-my-opencode/team-core/team-mailbox"
import { getInboxDir, resolveBaseDir } from "@oh-my-opencode/team-core/team-registry/paths"
import { loadRuntimeState } from "@oh-my-opencode/team-core/team-state-store"
import { openTeamDeliveryJournal } from "../../host/team-delivery-journal"
import { createPolicyPipeline } from "../../host/policy-pipeline"
import { createSessionScopes } from "../../host/session-state"
import { createToolKernel } from "../../host/tool-kernel"
import { createToolRegistry } from "../../host/tool-registry"
import { createNativeTaskBridge } from "../../tools/native-task"
import type { PreparedNativeTaskRuntime } from "../../tools/native-task-preparation"
import { NATIVE_TEAM_TOOL_NAMES } from "../../tools/native-team-codecs"
import { TEAM_MEMBER_SEND_TOOL_NAME } from "../../tools/team-member-send"
import { createNativeChildGuardBinding } from "../native-task/child-guard-binding"
import { discoverTeamLeads, nativeTaskStateDir, nativeTeamSettings } from "../native-task/component"
import { acquireTeamMemberOwner, type TeamMemberOwner } from "../native-task/live-member-owner"
import { createNativeTaskService, type NativeTaskTargetPermissionAssociation } from "../native-task/service"
import { withNativeTargetPermissionService } from "../native-task/service.test"
import { registerNativeTeamComponent, type NativeTeamComponent } from "./component"
import { teamDeliveryInputId, type TeamDeliverySession } from "./lead-delivery"

type PublicTool = Info & { readonly id: string }
type EffectInfo = ReturnType<ToolEditor["list"]>[number]
type EffectContext = Parameters<EffectInfo["execute"]>[1]
type Base = Parameters<Parameters<typeof withNativeTargetPermissionService>[0]>[0]
type Config = PreparedNativeTaskRuntime["config"]

const LEAD = "ses_reload_lead"
const TWO_MEMBERS = {
  inline_spec: {
    name: "reload-team",
    members: [
      { name: "alpha", category: "qa", prompt: "block alpha" },
      { name: "beta", category: "qa", prompt: "block beta" },
    ],
  },
}
const cleanups: (() => Promise<void> | void)[] = []
/** Plugin generations close inside the service fixture, before its state directory is removed. */
const generations: (() => Promise<void>)[] = []
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
async function waitFor(condition: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await condition()) return
    await Bun.sleep(10)
  }
  throw Error(`Condition not reached: ${label}`)
}

/** Controlled UNIT effect tool domain carrying the REAL member send registration; it outlives a reload. */
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

function leadTeamConfig(directory: string, config: Config) {
  const settings = nativeTeamSettings(directory, LEAD, config)
  return toTeamCoreConfig(
    settings,
    teamStorageBaseDir({ project_dir: directory, task: { state_dir: settings.state_dir } }),
  )
}
function inboxIds(directory: string, config: Config, runId: string, recipient: string): string[] {
  const dir = getInboxDir(resolveBaseDir(leadTeamConfig(directory, config)), runId, recipient)
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json") && !name.startsWith("."))
        .map((name) => String(JSON.parse(readFileSync(join(dir, name), "utf8")).messageId))
    : []
}
// The lead poller can move a fresh message to processed/ before the test reads the inbox.
function knownMessageIds(directory: string, config: Config, runId: string, recipient: string): string[] {
  const dir = join(getInboxDir(resolveBaseDir(leadTeamConfig(directory, config)), runId, recipient), "processed")
  const done = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -".json".length))
    : []
  return [...new Set([...inboxIds(directory, config, runId, recipient), ...done])]
}
function sentMessageId(sent: Record<string, unknown>): string {
  const team = sent["team"]
  const id = typeof team === "object" && team !== null && "message_id" in team ? team.message_id : undefined
  if (typeof id !== "string") throw new Error("Missing team message id in the send result")
  return id
}
function processed(directory: string, config: Config, runId: string, recipient: string, messageId: string): boolean {
  return existsSync(
    join(
      getInboxDir(resolveBaseDir(leadTeamConfig(directory, config)), runId, recipient),
      "processed",
      `${messageId}.json`,
    ),
  )
}
function record(directory: string, id: string): Record<string, unknown> | undefined {
  const file = join(directory, LEAD, "tasks", `${id}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined
}
function journalPath(directory: string): string {
  return join(nativeTaskStateDir(directory, LEAD), "team-deliveries.sqlite")
}

/** ONE plugin generation over the shared unit host: fresh session scopes, registry, kernel, Native task
 * service, lead team component (with its delivery owner) and public bridge. A reload closes it and
 * assembles the next one over the same state directory, exactly like a plugin reload. */
async function assemble(base: Base, owner: TeamMemberOwner, pollIntervalMs: number) {
  const { f } = base
  const directory = f.dir,
    config = await f.options.config()
  const scopes = createSessionScopes()
  const permission = defined(base.options.hostGrant).permission
  const registry = createToolRegistry([], {}),
    kernel = createToolKernel({ registry, scopes, pipeline: createPolicyPipeline(), permission })
  const teamConfigFor = (lead: string) => {
    const settings = nativeTeamSettings(directory, lead, config)
    return toTeamCoreConfig(
      settings,
      teamStorageBaseDir({ project_dir: directory, task: { state_dir: settings.state_dir } }),
    )
  }
  let team: NativeTeamComponent | undefined
  const childGuardBinding = createNativeChildGuardBinding({
    assertGeneration() {},
    member: { owner, teamConfigFor, onBound: (member) => team?.memberBound(member) ?? (() => {}) },
  })
  const service = createNativeTaskService(f.ctx, {
    ...base.options,
    scopes,
    callAuthority: kernel.callAuthority,
    childGuardBinding,
    policy: {
      tools: ["task", "task_output", "task_send", "task_cancel", ...NATIVE_TEAM_TOOL_NAMES, "read"],
      authorize() {},
    },
  })
  const prepared = {
    config,
    agents: {},
    authorizeSkills: async () => () => ({ prepend: "", resolved: [], missing: [] }),
  } as unknown as PreparedNativeTaskRuntime
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
  const teamTargets =
    Promise.withResolvers<Parameters<Parameters<typeof registerNativeTeamComponent>[0]["register"]>[0]>()
  const teamRegistered = Promise.withResolvers<readonly NativeTaskTargetPermissionAssociation[]>()
  team = registerNativeTeamComponent({
    tool: domain,
    directory,
    prepared,
    registry,
    kernel,
    service,
    assertCurrent() {},
    delivery: {
      session: f.ctx.session as unknown as TeamDeliverySession,
      assertGeneration() {},
      isMemberBound: (sessionID) => owner.isBound(sessionID),
      teamConfigFor,
      journalPathFor: (lead) => join(nativeTaskStateDir(directory, lead), "team-deliveries.sqlite"),
      pollIntervalMs,
      discoverLeads: () => discoverTeamLeads(directory, config),
    },
    register(targets) {
      teamTargets.resolve(targets)
      return teamRegistered.promise
    },
  })
  const owned = team
  const bridge = createNativeTaskBridge({
    tool: domain,
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
        teamRouting: (caller, call) => owned.teamRouting(caller, call),
        context(caller) {
          return { cwd: directory, sessionManager: { getSessionId: () => caller.sessionID } }
        },
        taskDependencies: () => ({}),
        outputDependencies: () => ({ stateDir: directory }),
        async release() {},
      }
    },
  })
  await bridge.ready
  await owned.ready
  const callers = new Map<string, ToolContext>()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await service.close()
    await owned.close()
    await bridge.close()
    scopes.dispose()
  }
  generations.push(close)
  return {
    config,
    call(name: string, input: unknown, sessionID = LEAD) {
      const caller = callers.get(sessionID) ?? f.raw(sessionID).caller
      callers.set(sessionID, caller)
      return defined(tools.find((tool) => tool.name === name)).execute(input, caller)
    },
    close,
  }
}

async function withReloadableTeam(
  run: (value: {
    base: Base
    owner: TeamMemberOwner
    memberSend: Awaited<ReturnType<typeof memberOwner>>["send"]
  }) => Promise<void>,
) {
  const { owner, send } = await memberOwner()
  await withNativeTargetPermissionService(
    async (base) => {
      try {
        await run({ base, owner, memberSend: send })
      } finally {
        for (const close of generations.splice(0).reverse()) await close()
      }
    },
    { policyTools: ["task", "task_output", "task_send", "task_cancel", ...NATIVE_TEAM_TOOL_NAMES, "read"] },
  )
}

/** Generation 1: a team whose two members finished their first turn, then alpha reports to the lead
 * and the host dies before that mail is delivered: its reservation and un-ACKed intent stay behind. */
async function reloadedWithPendingReport(
  base: Base,
  owner: TeamMemberOwner,
  memberSend: Awaited<ReturnType<typeof memberOwner>>["send"],
) {
  const { f } = base
  const first = await assemble(base, owner, 0)
  const created = details(await first.call("team_create", TWO_MEMBERS))
  const runId = String(created.team_run_id)
  const taskIds = (created.members as { task_id: string }[]).map((member) => member.task_id)
  const state = await loadRuntimeState(runId, leadTeamConfig(f.dir, first.config))
  const sessions = state.members.map((member) => defined(member.sessionId))
  for (const sessionID of sessions) f.finishChild(sessionID, "member idle")
  for (const id of taskIds) await waitFor(() => record(f.dir, id)?.status === "completed", `member ${id} completed`)
  expect(Exit.isSuccess(await memberSend(defined(sessions[0]), { to: "lead", message: "report before reload" }))).toBe(
    true,
  )
  const [reportId] = inboxIds(f.dir, first.config, runId, "lead")
  if (reportId === undefined) throw Error("Missing pre-reload member report")
  await first.close()
  // The killed host had reserved the report and journaled its intent, but never got the ACK.
  expect(await reserveMessageForDelivery(runId, "lead", reportId, leadTeamConfig(f.dir, first.config))).not.toBeNull()
  const journal = openTeamDeliveryJournal({ path: journalPath(f.dir), namespace: journalNamespace(f.dir) })
  try {
    journal.recordIntent(
      { teamRunId: runId, recipient: "lead", messageId: reportId },
      LEAD,
      teamDeliveryInputId(runId, "lead", reportId),
    )
  } finally {
    journal.close()
  }
  return { runId, taskIds, sessions, reportId, config: first.config }
}

function journalNamespace(directory: string): string {
  return (
    "opencode2-team:" +
    createHash("sha256")
      .update(JSON.stringify([directory, LEAD]))
      .digest("hex")
  )
}
function journalRows(directory: string, runId: string) {
  const journal = openTeamDeliveryJournal({ path: journalPath(directory), namespace: journalNamespace(directory) })
  try {
    return journal.listTeam(runId)
  } finally {
    journal.close()
  }
}

describe("#given a lead team whose host reloaded with an un-ACKed member report", () => {
  test("#when the next plugin generation starts #then the report is re-posted with the same id exactly once and later member mail flows", async () => {
    await withReloadableTeam(async ({ base, owner, memberSend }) => {
      // given
      const { f } = base
      const before = await reloadedWithPendingReport(base, owner, memberSend)
      for (const id of before.taskIds) expect(record(f.dir, id)?.residency_state).toBe("persisted_only")
      const reportInput = teamDeliveryInputId(before.runId, "lead", before.reportId)
      const postedBefore = f.synthetics.filter((entry) => entry.input.id === reportInput).length
      // when
      await assemble(base, owner, 20)
      // then
      await waitFor(
        () => processed(f.dir, before.config, before.runId, "lead", before.reportId),
        "pre-reload report processed",
      )
      await Bun.sleep(100)
      const reposted = f.synthetics.filter((entry) => entry.input.id === reportInput)
      expect(reposted.length - postedBefore).toBe(1)
      expect(reposted.at(-1)?.input.sessionID).toBe(LEAD)
      expect(journalRows(f.dir, before.runId).find((row) => row.messageId === before.reportId)?.phase).toBe("acked")
    })
  })

  test("#when the lead lists and messages after the reload #then the parked member is restored, gets the mail once and can report again", async () => {
    await withReloadableTeam(async ({ base, owner, memberSend }) => {
      // given
      const { f } = base
      const before = await reloadedWithPendingReport(base, owner, memberSend)
      const [alpha, beta] = before.sessions
      expect(owner.isBound(defined(alpha))).toBe(false)
      const next = await assemble(base, owner, 20)
      // when
      const listed = details(await next.call("task_list", { team_run_id: before.runId }))
      const sent = details(await next.call("task_send", { to: "alpha", message: "work after reload" }))
      // then
      expect(listed.kind).toBe("list")
      expect(sent.kind).toBe("team_message")
      expect(owner.isBound(defined(alpha))).toBe(true)
      expect(owner.isBound(defined(beta))).toBe(true)
      // The id comes from the send result: an in-flight delivery is a hidden `.delivering-*` file in the inbox.
      const toAlpha = sentMessageId(sent)
      const alphaInput = teamDeliveryInputId(before.runId, "alpha", defined(toAlpha))
      await waitFor(
        () => processed(f.dir, before.config, before.runId, "alpha", defined(toAlpha)),
        "lead mail delivered to the restored member",
      )
      await Bun.sleep(100)
      expect(
        f.synthetics.filter((entry) => entry.input.id === alphaInput).map((entry) => entry.input.sessionID),
      ).toEqual([defined(alpha)])

      // when: the restored member reports through its rebound producer
      const known = knownMessageIds(f.dir, before.config, before.runId, "lead")
      const reported = await memberSend(defined(alpha), { to: "lead", message: "restored report" })
      // then
      expect(Exit.isSuccess(reported)).toBe(true)
      const fresh = knownMessageIds(f.dir, before.config, before.runId, "lead").filter((id) => !known.includes(id))
      expect(fresh).toHaveLength(1)
      await waitFor(
        () => processed(f.dir, before.config, before.runId, "lead", defined(fresh[0])),
        "restored member report delivered",
      )
      expect(
        f.synthetics
          .filter((entry) => entry.input.id === teamDeliveryInputId(before.runId, "lead", defined(fresh[0])))
          .map((entry) => entry.input.sessionID),
      ).toEqual([LEAD])
    })
  })

  test("#when the lead deletes the team after the reload #then the members are torn down, unbound and the journal rows are dropped", async () => {
    await withReloadableTeam(async ({ base, owner, memberSend }) => {
      // given
      const { f } = base
      const before = await reloadedWithPendingReport(base, owner, memberSend)
      const next = await assemble(base, owner, 20)
      // when
      const deleted = details(await next.call("team_delete", { team_run_id: before.runId }))
      // then
      expect(deleted.kind).toBe("deleted")
      expect(existsSync(join(resolveBaseDir(leadTeamConfig(f.dir, before.config)), "runtime", before.runId))).toBe(
        false,
      )
      for (const id of before.taskIds) expect(record(f.dir, id)?.residency_state).not.toBe("resident")
      expect(before.sessions.some((sessionID) => owner.isBound(sessionID))).toBe(false)
      expect(f.calls.filter((entry) => entry === "remove")).toHaveLength(2)
      await waitFor(() => journalRows(f.dir, before.runId).length === 0, "journal rows of the deleted run dropped")
    })
  })
})
