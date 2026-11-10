import { expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { createTaskRecord } from "@oh-my-opencode/senpi-task"
import type { ManagedStartSpec, TaskRecord } from "@oh-my-opencode/senpi-task/manager-kernel"
import { filterSharedParentTools } from "@oh-my-opencode/senpi-task/task-operations"
import { acquireOwnedChildToolGuard } from "../../host/owned-child-tool-guard"
import { createOwnedTaskRecovery } from "./owned-recovery"
import { createFreshRecoveryApprovals } from "./parked-recovery"
import { prepareRecoveryHostGrant } from "./host-grant"
import type { OwnedTaskControl } from "./owned-handle"

/** A parked Native record as persisted before a reload (owned journal reference + v1 spawn spec). */
function parkedRecord(): TaskRecord {
  const base = createTaskRecord({ task_id: "st_unit_parked", parent_session_id: "ses_parent", root_session_id: "ses_parent", depth: 1, model: "qa/model", agent_type: "explore", tool_allow: ["read"] })
  return { ...base, status: "completed", residency_state: "persisted_only", child_session_id: "ses_child", spawn_spec: { version: 1, cwd: "/unit", prompt: "persisted original prompt" },
    owned_session: { format: 1, backendID: "omo-native-task-opencode", location: "/unit", hostVersion: "2.2.6", parentID: "ses_parent", sessionID: "ses_child", generation: 1,
      journalKey: "st_unit_parked:0", journalOwner: "owner", journalRevision: 4, runEpoch: 0, residencyClaim: "claim" } }
}
const unitControl = { handle: { task_id: "st_unit_parked" } } as unknown as OwnedTaskControl

test("owned recovery verifies the EXACT rebuilt spec before beforeLaunch and before the runner claim", async () => {
  // given a recovery runtime whose verifier and runner record what they receive
  const order: string[] = [], seen: ManagedStartSpec[] = []
  const recovery = createOwnedTaskRecovery({ async recover(spec) { order.push("recover"); seen.push(spec); return unitControl } }, "/state",
    { async verifyRecord(_record, spec) { order.push("verify"); seen.push(spec) } })
  // when it respawns the parked record
  const result = await recovery.respawn({ record: parkedRecord(), sessionPath: undefined, beforeLaunch: () => { order.push("beforeLaunch") } }, undefined as never, () => 0)
  // then the SAME rebuilt object reaches verification first and the claim last, with no prompt replay path
  expect(result.ok).toBe(true); expect(order).toEqual(["verify", "beforeLaunch", "recover"]); expect(seen[0]).toBe(seen[1])
})

test("a failed verification admits neither beforeLaunch nor the runner claim", async () => {
  const order: string[] = []
  const recovery = createOwnedTaskRecovery({ async recover() { order.push("recover"); return unitControl } }, "/state",
    { async verifyRecord() { throw Error("no fresh approval") } })
  await expect(recovery.respawn({ record: parkedRecord(), sessionPath: undefined, beforeLaunch: () => { order.push("beforeLaunch") } }, undefined as never, () => 0)).rejects.toThrow("no fresh approval")
  expect(order).toEqual([])
})

async function approvals(options: { authorize?: boolean; current?: () => void } = {}) {
  const scope = Scope.makeUnsafe()
  const guard = await Effect.runPromise(Effect.provideService(acquireOwnedChildToolGuard({ tool: { transform: () => Effect.succeed({ dispose: Effect.void }) }, permission: { hook: () => Effect.succeed({ dispose: Effect.void }) } }), Scope.Scope, scope))
  const authorized: ManagedStartSpec[] = []
  const fresh = createFreshRecoveryApprovals({ guard, stateDir: "/state", capture: () => ({ assertAdmission: options.current ?? (() => {}), assertLifetime() {} }),
    ...(options.authorize !== false && { authorize: async (spec: ManagedStartSpec) => { authorized.push(spec); return { buildAgentID: "build", authorityIssued: false as const,
      selection: prepareRecoveryHostGrant({ spec, nativeTools: [{ name: "read" }], catalog: [{ id: "read", name: "read", options: { codemode: false } }], includeTaskTools: true, canonical: { filterSharedParentTools } }) } } }) })
  return { fresh, authorized, close: () => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))) }
}

test("a fresh approval binds only inside its own recovery scope and only to an identical rebuilt spec", async () => {
  const f = await approvals(), record = parkedRecord()
  try {
    const approval = await f.fresh.approve(record)
    expect(f.authorized).toHaveLength(1)
    const rebuilt = { ...defined(f.authorized[0]) }
    expect(() => f.fresh.verify(record, rebuilt)).toThrow("no fresh approval")
    await f.fresh.run(approval, async () => {
      expect(() => f.fresh.verify(record, { ...rebuilt, agentType: "oracle" })).toThrow("no fresh approval")
      f.fresh.verify(record, rebuilt)
    })
    expect(f.fresh.forSpec(rebuilt)).toBe(approval); expect(f.fresh.forSpec({ ...rebuilt })).toBeUndefined()
  } finally { await f.close() }
})

test("without a genuine current call or an authorization port no recovery approval is minted", async () => {
  const noCall = await approvals({ current: () => { throw Error("no current tool call") } })
  try { await expect(noCall.fresh.approve(parkedRecord())).rejects.toThrow("no current tool call"); expect(noCall.authorized).toHaveLength(0) } finally { await noCall.close() }
  const noPort = await approvals({ authorize: false })
  try { await expect(noPort.fresh.approve(parkedRecord())).rejects.toThrow("fresh current-call authorization") } finally { await noPort.close() }
})
function defined<T>(value: T | null | undefined): T { if (value === undefined || value === null) throw new Error("expected a defined value"); return value }
