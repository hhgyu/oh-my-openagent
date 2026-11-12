import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { filterSharedParentTools } from "@oh-my-opencode/senpi-task/task-operations"
import { TeamModeConfigSchema, type TeamModeConfig } from "@oh-my-opencode/team-core/config"
import { getInboxDir, getRuntimeStateDir, resolveBaseDir } from "@oh-my-opencode/team-core/team-registry/paths"
import { saveRuntimeState } from "@oh-my-opencode/team-core/team-state-store"
import { withLock } from "@oh-my-opencode/team-core/team-state-store/locks"
import type { RuntimeState } from "@oh-my-opencode/team-core/types"
import type { PermissionDomain } from "@opencode/plugin/effect/permission"
import type { ToolDomain, ToolEditor } from "@opencode/plugin/effect/tool"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { Effect, Exit, Scope } from "effect"
import { acquireOwnedChildToolGuard } from "../../host/owned-child-tool-guard"
import type { ChildHandle } from "../../host/session-backend"
import { TEAM_MEMBER_SEND_PERMISSION, TEAM_MEMBER_SEND_TOOL_NAME } from "../../tools/team-member-send"
import { createNativeChildGuardBinding } from "./child-guard-binding"
import { childCatalog, hideUnboundTeamMemberSend } from "./component"
import { prepareHostTaskGrant } from "./host-grant"
import { acquireTeamMemberOwner, type MemberChildInput } from "./live-member-owner"

type Info = ReturnType<ToolEditor["list"]>[number]
type Context = Parameters<Info["execute"]>[1]
type MemberScopedTools = NonNullable<Parameters<typeof prepareHostTaskGrant>[0]["spec"]["memberScopedTools"]>

const RUN = "11111111-1111-4111-8111-111111111111"
const LEAD = "ses_lead",
  MEMBER = "ses_member_alpha",
  OTHER = "ses_not_a_member",
  AGENT = "build"
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}

function runtimeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  const member = (name: string): RuntimeState["members"][number] => ({
    name,
    agentType: "general-purpose",
    status: "running",
    pendingInjectedMessageIds: [],
  })
  return {
    version: 1,
    teamRunId: RUN,
    teamName: "unit-team",
    specSource: "project",
    createdAt: 1,
    status: "active",
    leadSessionId: LEAD,
    members: [member("alpha"), member("beta")],
    shutdownRequests: [],
    bounds: {
      maxMembers: 8,
      maxParallelMembers: 4,
      maxMessagesPerRun: 10000,
      maxWallClockMinutes: 120,
      maxMemberTurns: 500,
    },
    ...overrides,
  }
}

/** Controlled UNIT SDK tool domain over REAL team-core state and mailbox files in a temp root. */
async function fixture(options: { readonly guarded?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "omo-v2-member-owner-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const config: TeamModeConfig = TeamModeConfigSchema.parse({ base_dir: root })
  mkdirSync(getRuntimeStateDir(resolveBaseDir(config), RUN), { recursive: true })
  await saveRuntimeState(runtimeState(), config)
  const scope = Scope.makeUnsafe(),
    tools = new Map<string, Info>()
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
  const tool: Pick<ToolDomain, "transform" | "list"> = {
    transform: (callback) =>
      Effect.sync(() => {
        callback(editor)
        return { dispose: Effect.void }
      }),
    list: () => Effect.sync(() => [...tools.values()]),
  }
  let messageCount = 0
  const owner = await Effect.runPromise(
    Effect.provideService(
      acquireTeamMemberOwner({ tool }, { newMessageId: () => `unit-message-${++messageCount}` }),
      Scope.Scope,
      scope,
    ),
  )
  const guardPermission: Pick<PermissionDomain, "hook"> = { hook: () => Effect.sync(() => ({ dispose: Effect.void })) }
  const guard = options.guarded
    ? await Effect.runPromise(
        Effect.provideService(acquireOwnedChildToolGuard({ tool, permission: guardPermission }), Scope.Scope, scope),
      )
    : undefined
  cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))))
  const context = (sessionID = MEMBER, agent = AGENT): Context => ({
    sessionID,
    agent,
    messageID: "unit-message" as Context["messageID"],
    id: "unit-call" as Context["id"],
    progress: () => Effect.void,
  })
  const run = (input: unknown, ctx = context()) =>
    Effect.runPromiseExit(defined(tools.get(TEAM_MEMBER_SEND_TOOL_NAME)).execute(input, ctx))
  const bindChild = (sessionID = MEMBER, appendEvent?: MemberChildInput["appendEvent"]) =>
    owner.bindChild({
      child: {},
      sessionID,
      agent: AGENT,
      taskId: "st_00000001",
      leadSessionID: LEAD,
      team: { runId: RUN, memberName: "alpha" },
      config,
      assertCurrent() {},
      ...(appendEvent && { appendEvent }),
    })
  const leadInbox = getInboxDir(resolveBaseDir(config), RUN, "lead")
  const leadMessages = () =>
    existsSync(leadInbox) ? readdirSync(leadInbox).filter((name) => name.endsWith(".json")) : []
  return { tools, owner, guard, config, run, context, bindChild, leadInbox, leadMessages }
}

function failureMessage(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) throw Error("Expected a failed tool call")
  const error = exit.cause.reasons
    .map((reason) => (reason._tag === "Fail" ? reason.error : undefined))
    .find((value) => value instanceof ToolError)
  if (!(error instanceof ToolError)) throw Error(`Expected a typed tool error, got ${String(exit.cause)}`)
  return error.message
}

function text(exit: Exit.Exit<unknown, unknown>): string {
  if (!Exit.isSuccess(exit)) throw Error(`Expected a successful tool call, got ${String(exit.cause)}`)
  const value = exit.value
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content))
    throw Error("Expected tool content")
  return value.content
    .map((part: unknown) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
    .join("")
}

describe("#given the dedicated team member send registration", () => {
  test("#then it is a codemode:false SDK tool with its own permission action", async () => {
    // given
    const f = await fixture()
    // when
    const info = defined(f.tools.get(TEAM_MEMBER_SEND_TOOL_NAME))
    // then
    expect(f.owner.hostID).toBe(TEAM_MEMBER_SEND_TOOL_NAME)
    expect(info.options).toEqual({ codemode: false, permission: TEAM_MEMBER_SEND_PERMISSION })
    expect(info.description).toContain("task_send")
  })

  test("#when the lead or an unbound session calls it #then it refuses and nothing is enqueued", async () => {
    // given
    const f = await fixture()
    f.bindChild()
    // when
    const lead = await f.run({ to: "lead", message: "spoof" }, f.context(LEAD))
    const other = await f.run({ to: "lead", message: "spoof" }, f.context(OTHER))
    // then
    expect(failureMessage(lead)).toContain("available only to an in-process team member")
    expect(failureMessage(other)).toContain("available only to an in-process team member")
    expect(f.leadMessages()).toEqual([])
  })
})

describe("#given a bound in-process member", () => {
  test("#when audit append fails after enqueue #then the successful send is retained and no retryable tool failure is returned", async () => {
    const f = await fixture()
    const producer = f.bindChild(MEMBER, () => {
      throw Error("audit disk unavailable")
    })
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const exit = await f.run({ to: "lead", message: "report" })
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(f.leadMessages()).toHaveLength(1)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
      await producer.join()
    }
  })
  test("#when it sends to the lead #then exactly one message lands in the team-core lead inbox", async () => {
    // given
    const f = await fixture()
    const producer = f.bindChild()
    // when
    const exit = await f.run({ to: "lead", message: "report", summary: "done" })
    // then
    expect(text(exit)).toContain("Message enqueued to lead")
    const files = f.leadMessages()
    expect(files).toHaveLength(1)
    const message: unknown = JSON.parse(readFileSync(join(f.leadInbox, defined(files[0])), "utf8"))
    expect(message).toMatchObject({
      from: "alpha",
      to: "lead",
      body: "report",
      summary: "done",
      messageId: "unit-message-1",
    })
    await producer.join()
  })

  test("#when the call carries a different agent #then custody refuses and nothing is enqueued", async () => {
    // given
    const f = await fixture()
    const producer = f.bindChild()
    // when
    const exit = await f.run({ to: "lead", message: "report" }, f.context(MEMBER, "other-agent"))
    // then
    expect(failureMessage(exit)).toContain("custody mismatch")
    expect(f.leadMessages()).toEqual([])
    await producer.join()
  })

  test("#when the member is removed from the team #then its send is refused and nothing is enqueued", async () => {
    // given
    const f = await fixture()
    const producer = f.bindChild()
    await saveRuntimeState(
      runtimeState({ members: runtimeState().members.filter((member) => member.name !== "alpha") }),
      f.config,
    )
    // when
    const exit = await f.run({ to: "lead", message: "late report" })
    // then
    expect(failureMessage(exit)).toContain("no longer in team")
    expect(f.leadMessages()).toEqual([])
    await producer.join()
  })

  test("#when the team is deleted #then its send is refused and nothing is enqueued", async () => {
    // given
    const f = await fixture()
    const producer = f.bindChild()
    await saveRuntimeState(runtimeState({ status: "deleted" }), f.config)
    // when
    const exit = await f.run({ to: "lead", message: "late report" })
    // then
    expect(failureMessage(exit)).toContain("is not active")
    expect(f.leadMessages()).toEqual([])
    await producer.join()
  })

  test("#when the producer is revoked #then its send is refused, the session is unbound and nothing is enqueued", async () => {
    // given
    const f = await fixture()
    const producer = f.bindChild()
    // when
    producer.revoke()
    const exit = await f.run({ to: "lead", message: "after revoke" })
    // then
    expect(failureMessage(exit)).toContain("available only to an in-process team member")
    expect(f.owner.isBound(MEMBER)).toBe(false)
    expect(f.leadMessages()).toEqual([])
    await producer.join()
  })

  test("#when the producer is joined during an in-flight send #then join waits for the send to settle", async () => {
    // given
    const f = await fixture()
    const producer = f.bindChild()
    const release: PromiseWithResolvers<void> = Promise.withResolvers(),
      held: PromiseWithResolvers<void> = Promise.withResolvers()
    // The REAL team-core inbox lock is held, so the original send blocks inside sendMessage.
    mkdirSync(f.leadInbox, { recursive: true })
    const lock = withLock(`${f.leadInbox}.lock`, async () => {
      held.resolve()
      await release.promise
    })
    await held.promise
    const send = f.run({ to: "lead", message: "in flight" })
    await Bun.sleep(150)
    // when
    let joined = false
    const join = producer.join().then(() => {
      joined = true
    })
    await Bun.sleep(150)
    // then
    expect(joined).toBe(false)
    release.resolve()
    await lock
    const exit = await send
    await join
    expect(joined).toBe(true)
    expect(text(exit)).toContain("Message enqueued to lead")
    expect(f.leadMessages()).toHaveLength(1)
    expect(f.owner.isBound(MEMBER)).toBe(false)
  })
})

describe("#given the owned-child tool guard acquired after the member owner", () => {
  test("#then the guard admits the member send only for the bound member through its task_send slot", async () => {
    // given
    const f = await fixture({ guarded: true })
    const guard = defined(f.guard)
    const catalog = [{ id: "read", name: "read", options: { codemode: false as const } }]
    const members = [{ name: "task_send" }] as unknown as MemberScopedTools
    const selection = prepareHostTaskGrant({
      spec: { prompt: "unit", parent_session_id: LEAD, depth: 1, memberScopedTools: members },
      plan: { model: "unit/model", agentType: "sisyphus-junior" },
      includeTaskTools: true,
      nativeTools: [{ name: "read" }],
      catalog,
      canonical: { filterSharedParentTools },
    })
    const producer = createNativeChildGuardBinding({
      assertGeneration() {},
      member: { owner: f.owner, teamConfigFor: () => f.config },
    })(
      {
        taskId: "st_00000001",
        cwd: "/project",
        stateDir: "/state",
        prompt: "unit",
        depth: 1,
        parentSessionId: LEAD,
        rootSessionId: LEAD,
        agentType: "sisyphus-junior",
      },
      { buildAgentID: AGENT, selection },
      { team: { runId: RUN, memberName: "alpha" } },
    )
    const stage = guard.beginStage(
      guard.approve({}, { selection, buildAgentID: AGENT, assertCurrent() {} }),
      MEMBER,
      () => {},
    )
    const child = { locator: { sessionID: MEMBER }, lease: {} } as unknown as ChildHandle
    // when
    guard.bind(
      stage,
      producer.bind(child, () => {}),
    )
    const allowed = await f.run({ to: "lead", message: "guarded report" })
    const lead = await f.run({ to: "lead", message: "spoof" }, f.context(LEAD))
    // then
    expect(text(allowed)).toContain("Message enqueued to lead")
    expect(failureMessage(lead)).toContain("available only to an in-process team member")
    expect(f.leadMessages()).toHaveLength(1)
    await Effect.runPromise(guard.join(stage))
    expect(f.owner.isBound(MEMBER)).toBe(false)
    guard.release(stage, () => {})
  })
})

describe("#given model request contexts", () => {
  test("#then only a session with a live bound member producer keeps the member send", async () => {
    // given
    const f = await fixture()
    const producer = f.bindChild()
    const tools = () => ({ read: {}, [TEAM_MEMBER_SEND_TOOL_NAME]: {} })
    const parent = { sessionID: LEAD, tools: tools() },
      other = { sessionID: OTHER, tools: tools() },
      member = { sessionID: MEMBER, tools: tools() }
    // when
    hideUnboundTeamMemberSend(parent, f.owner)
    hideUnboundTeamMemberSend(other, f.owner)
    hideUnboundTeamMemberSend(member, f.owner)
    // then
    expect(Object.keys(parent.tools)).toEqual(["read"])
    expect(Object.keys(other.tools)).toEqual(["read"])
    expect(Object.keys(member.tools)).toEqual(["read", TEAM_MEMBER_SEND_TOOL_NAME])
    producer.revoke()
    const revoked = { sessionID: MEMBER, tools: tools() }
    hideUnboundTeamMemberSend(revoked, f.owner)
    expect(Object.keys(revoked.tools)).toEqual(["read"])
    await producer.join()
  })

  test("#then the member send is never a catalog grant", async () => {
    // given
    const f = await fixture()
    // when
    const ids = childCatalog([...f.tools.values()]).map((tool) => tool.id)
    // then
    expect(ids).not.toContain(TEAM_MEMBER_SEND_TOOL_NAME)
  })
})
