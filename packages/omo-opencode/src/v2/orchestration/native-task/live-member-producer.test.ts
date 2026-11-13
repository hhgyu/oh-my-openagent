import { expect, test, onTestFinished } from "bun:test"
import { mkdtempSync, rmSync, lstatSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, relative } from "node:path"
import { TeamModeConfigSchema } from "@oh-my-opencode/team-core/config"
import { listUnreadMessages } from "@oh-my-opencode/team-core/team-mailbox"
import { createMemberTaskSendTool, createWorkpoolWorkerTool } from "@oh-my-opencode/senpi-task/task-operations"
import { createTeamMemberProducer, createWorkpoolMemberProducer } from "./live-member-producer"
import { fixture, poolInput } from "../../../../../senpi-task/src/workpool/__fixtures__/admission"
import { createMemberTaskSendTool as originalTeamFactory } from "../../../../../senpi-task/src/team/member-extension/tools"
import { createWorkpoolWorkerTool as originalWorkerFactory } from "../../../../../senpi-task/src/tools/workpool"

function privateRoot(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  onTestFinished(() => {
    const rel = relative(resolve(tmpdir()), resolve(root))
    if (!rel || rel.startsWith("..") || lstatSync(root).isSymbolicLink()) throw Error("Unsafe test cleanup")
    rmSync(root, { recursive: true, force: true })
  })
  return root
}

function custody() {
  let owner = true,
    registered = true
  const call = { child: {}, sessionID: "actual-child-session", agent: "approved-child-agent", registration: {} }
  return {
    call,
    owner: () => {
      if (!owner) throw Error("membership revoked")
    },
    binding: {
      ...call,
      assertCurrent: () => {
        if (!registered) throw Error("registration revoked")
      },
    },
    revokeOwner: () => {
      owner = false
    },
    revokeRegistration: () => {
      registered = false
    },
  }
}

test("actual worker factory retains native identities and delegates original call arguments/results", async () => {
  expect(createMemberTaskSendTool).toBe(originalTeamFactory)
  expect(createWorkpoolWorkerTool).toBe(originalWorkerFactory)
  const c = custody()
  let epoch = 3
  const calls: unknown[][] = []
  const native = {
    taskId: "st_00000001",
    runEpoch: () => epoch,
    workpools: {
      yieldResults: (
        ...args: Parameters<Parameters<typeof createWorkpoolWorkerTool>[0]["workpools"]["yieldResults"]>
      ) => {
        calls.push(args)
        return { pool_id: "wp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const, generation: 1, results: [] }
      },
    },
  }
  const p = createWorkpoolMemberProducer({ native, assertCurrent: c.owner })
  expect(p.execute).toBe(p.nativeTool.execute)
  expect(p.parameters).toBe(p.nativeTool.parameters)
  const input = { op: "yield" as const, results: [] }
  expect(() => p.invoke(c.call, "call", input)).toThrow("unbound")
  p.bind(c.binding)
  for (const bad of [{ child: {} }, { sessionID: "unrelated" }, { agent: "other" }, { registration: {} }]) {
    expect(() => p.invoke({ ...c.call, ...bad }, "call", input)).toThrow("custody")
  }
  expect(calls).toHaveLength(0)
  const result = await p.invoke(c.call, "call", input)
  expect(result.details).toEqual({ pool_id: "wp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", generation: 1, results: [] })
  expect(calls).toEqual([[native.taskId, 3, input]])
  epoch++
  expect(() => p.invoke(c.call, "call", input)).toThrow("epoch")
  expect(calls).toHaveLength(1)
  await p.join()
})

test("actual team factory writes original durable mailbox result; live membership and registration gate new calls", async () => {
  const c = custody()
  const root = privateRoot("v2-member-producer-")
  const config = TeamModeConfigSchema.parse({ base_dir: join(root, "teams") })
  const native = {
    teamRunId: "66666666-6666-4666-8666-666666666666",
    memberName: "alice",
    taskId: "st_00000001",
    members: ["alice", "bob"],
    config,
    newMessageId: () => "99999999-9999-4999-8999-999999999999",
    now: () => 1,
  }
  const p = createTeamMemberProducer({ native, assertCurrent: c.owner })
  expect(p.parameters).toBe(p.nativeTool.parameters)
  expect(p.execute).toBe(p.nativeTool.execute)
  expect(p.nativeTool.parameters).toBe(createMemberTaskSendTool(native).parameters)
  p.bind(c.binding)
  expect(() => p.bind(c.binding)).toThrow("bound")
  const result = await p.invoke(c.call, "call", { to: "bob", message: "original durable mail" })
  expect(result.details).toEqual({ kind: "team_message", to: "bob", message_id: native.newMessageId() })
  expect((await listUnreadMessages(native.teamRunId, "bob", config)).map((x) => x.body)).toEqual([
    "original durable mail",
  ])
  c.revokeRegistration()
  expect(() => p.invoke(c.call, "call", { to: "bob", message: "blocked" })).toThrow("registration revoked")
  await p.join()
  const other = custody()
  const second = createTeamMemberProducer({ native, assertCurrent: other.owner })
  second.bind(other.binding)
  other.revokeOwner()
  expect(() => second.invoke(other.call, "call", { to: "bob", message: "blocked" })).toThrow("membership revoked")
  await second.join()
  expect((await listUnreadMessages(native.teamRunId, "bob", config)).map((x) => x.body)).toEqual([
    "original durable mail",
  ])
})

test("revocation retains original uncancellable mailbox promise until physical completion without redelivery", async () => {
  const c = custody()
  let completed = false
  const root = privateRoot("v2-member-join-")
  const p = createTeamMemberProducer({
    assertCurrent: c.owner,
    native: {
      teamRunId: "77777777-7777-4777-8777-777777777777",
      memberName: "alice",
      taskId: "st_00000001",
      members: ["alice", "bob"],
      config: TeamModeConfigSchema.parse({ base_dir: join(root, "teams") }),
      appendEvent: () => {
        completed = true
      },
    },
  })
  p.bind(c.binding)
  const original = p.invoke(c.call, "original", { to: "bob", message: "one enqueue" })
  expect(completed).toBe(false)
  p.revoke()
  expect(() => p.invoke(c.call, "late", { to: "bob", message: "late" })).toThrow("revoked")
  await p.join()
  expect(completed).toBe(true)
  expect((await original).details.kind).toBe("team_message")
})

test("genuine Workpool owner preserves original unassigned-worker refusal", async () => {
  const f = fixture(),
    c = custody()
  const p = createWorkpoolMemberProducer({
    assertCurrent: c.owner,
    native: {
      workpools: f.manager.workpools,
      taskId: "st_00000001",
      runEpoch: () => 1,
    },
  })
  p.bind(c.binding)
  const result = await p.invoke(c.call, "call", { op: "yield", results: [] })
  expect(result.isError).toBe(true)
  expect(result.details.error).toMatchObject({ code: "worker_unassigned" })
  await p.join()
})

test("genuine assigned Workpool accepts original yield and retains idempotence/conflict refusals", async () => {
  const f = fixture(),
    c = custody()
  const pool = f.manager.workpools.create(f.caller, poolInput)
  const dispatched = f.manager.workpools.waitForEvent(pool.pool_id, "dispatched", AbortSignal.timeout(5000))
  f.manager.workpools.push(f.caller, pool.pool_id, [{ key: "a", input: 1 }])
  const event = await dispatched
  if (!event.task_id) throw Error("Missing real assignment")
  const p = createWorkpoolMemberProducer({
    assertCurrent: c.owner,
    native: {
      workpools: f.manager.workpools,
      taskId: event.task_id,
      runEpoch: () => 0,
    },
  })
  p.bind(c.binding)
  const input = { op: "yield", results: [{ key: "a", data: 42 }] }
  const accepted = await p.invoke(c.call, "first", input)
  expect(accepted.isError).toBeUndefined()
  expect(accepted.details).toMatchObject({ pool_id: pool.pool_id, results: [{ key: "a", status: "accepted" }] })
  expect((await p.invoke(c.call, "repeat", input)).isError).toBeUndefined()
  const conflict = await p.invoke(c.call, "conflict", { op: "yield", results: [{ key: "a", data: 43 }] })
  expect(conflict.isError).toBe(true)
  expect(conflict.details).toMatchObject({ results: [{ key: "a", status: "refused" }] })
  await p.join()
})

test("synchronous original team dependency reenters join before real mailbox promise is returned", async () => {
  const c = custody(),
    root = privateRoot("v2-member-reentrant-")
  let completed = false,
    joined: Promise<void> | undefined
  const p = createTeamMemberProducer({
    assertCurrent: c.owner,
    native: {
      teamRunId: "88888888-8888-4888-8888-888888888888",
      memberName: "alice",
      taskId: "st_00000001",
      members: ["alice", "bob"],
      config: TeamModeConfigSchema.parse({ base_dir: join(root, "teams") }),
      newMessageId: () => {
        joined = p.join()
        return "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      },
      appendEvent: () => {
        completed = true
      },
    },
  })
  p.bind(c.binding)
  const original = p.invoke(c.call, "original", { to: "bob", message: "reentrant original enqueue" })
  try {
    expect(joined).toBeDefined()
    expect(completed).toBe(false)
    await joined
    expect(completed).toBe(true)
  } finally {
    await original
  }
})

for (const fence of ["owner", "registration"] as const) {
  test(`${fence} final fence revokes synchronously before original engine yield starts`, async () => {
    const f = fixture(),
      c = custody()
    let armed = false,
      yields = 0
    const revoke = () => {
      if (armed) p.revoke()
    }
    const p = createWorkpoolMemberProducer({
      assertCurrent: fence === "owner" ? revoke : c.owner,
      native: {
        taskId: "st_00000001",
        runEpoch: () => 1,
        workpools: {
          yieldResults: (...args) => {
            yields++
            return f.manager.workpools.yieldResults(...args)
          },
        },
      },
    })
    p.bind({ ...c.binding, assertCurrent: fence === "registration" ? revoke : c.binding.assertCurrent })
    armed = true
    expect(() => p.invoke(c.call, "revoked-in-final-fence", { op: "yield", results: [] })).toThrow("revoked")
    expect(yields).toBe(0)
    await p.join()
  })
}

test("trusted owner and registration checks retain original receivers and captured methods", async () => {
  const c = custody(),
    root = privateRoot("v2-member-receivers-")
  const owner = {
    current: true,
    native: {
      teamRunId: "99999999-9999-4999-8999-999999999999",
      memberName: "alice",
      taskId: "st_00000001",
      members: ["alice", "bob"],
      config: TeamModeConfigSchema.parse({ base_dir: join(root, "teams") }),
    },
    assertCurrent() {
      expect(this).toBe(owner)
      if (!this.current) throw Error("owner stale")
    },
  }
  const binding = {
    ...c.call,
    current: true,
    assertCurrent() {
      expect(this).toBe(binding)
      if (!this.current) throw Error("registration stale")
    },
  }
  const p = createTeamMemberProducer(owner)
  p.bind(binding)
  owner.assertCurrent = () => {
    throw Error("Replaced owner method must not be used")
  }
  binding.assertCurrent = () => {
    throw Error("Replaced registration method must not be used")
  }
  const result = await p.invoke(c.call, "original-receivers", { to: "bob", message: "receivers retained" })
  expect(result.details.to).toBe("bob")
  binding.current = false
  expect(() => p.invoke(c.call, "stale-original-receiver", { to: "bob", message: "blocked" })).toThrow(
    "registration stale",
  )
  await p.join()
})
