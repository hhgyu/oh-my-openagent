import { describe, expect, test } from "bun:test"
import { filterSharedParentTools } from "@oh-my-opencode/senpi-task/task-operations"
import type { ManagedStartSpec } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { ChildHandle } from "../../host/session-backend"
import { createNativeChildGuardBinding } from "./child-guard-binding"
import { checkHostGrantTarget, prepareHostTaskGrant, type PreparedHostTaskGrant } from "./host-grant"
import type { ReadonlyBrokerOwner } from "./live-readonly-producer"

const BROKER_ID = "omo_native_readonly"
const catalog = [
  { id: "read", name: "read", options: { codemode: false as const } },
  { id: "grep", name: "grep", options: { codemode: false as const } },
  { id: "glob", name: "glob", options: { codemode: false as const } },
  { id: "shell", name: "shell", options: { codemode: false as const } },
]
const nativeTools = ["read", "find", "grep", "bash", "edit"].map(name => ({ name }))

function grantFor(agentType: string): PreparedHostTaskGrant {
  return prepareHostTaskGrant({ spec: { prompt: "unit", parent_session_id: "ses_parent", depth: 1 }, plan: { model: "unit/model", agentType },
    includeTaskTools: true, nativeTools, catalog, canonical: { filterSharedParentTools } })
}
function spec(agentType: string): ManagedStartSpec {
  return { taskId: "st_00000001", cwd: "/project", stateDir: "/state", prompt: "unit", depth: 1, parentSessionId: "ses_parent", rootSessionId: "ses_parent", agentType }
}
function child(sessionID: string): ChildHandle {
  return { locator: { sessionID }, lease: {} } as unknown as ChildHandle
}
/** The SAME completeness decision `owned-runner.ts` applies before staging a guarded child. */
function runnerRefuses(selection: PreparedHostTaskGrant, coverage: { readonly boundRequirements: readonly string[]; readonly targets?: readonly { readonly requirement: string; readonly nativeName: string; readonly hostID: string }[] } | undefined): boolean {
  const covered = new Set(coverage?.boundRequirements)
  const targets = [...selection.selected.map(pair => pair.hostID), ...(coverage?.targets ?? []).map(pair => pair.hostID)]
  const typed = coverage as Parameters<typeof checkHostGrantTarget>[2]
  const missing = selection.requirements.some(requirement => !covered.has(requirement)) || selection.bindingSlots.some(slot =>
    !(coverage?.targets ?? []).some(target => target.requirement === slot.requirement && target.nativeName === slot.nativeName && target.hostID))
  return missing || targets.some(id => checkHostGrantTarget(selection, id, typed) !== "selected")
}
function fakeOwner(events: string[]): ReadonlyBrokerOwner {
  return {
    hostID: BROKER_ID,
    isBound: () => false,
    bindChild(input) {
      events.push(`bind:${input.sessionID}:${input.agent}:${input.cwd}`)
      return { assertCurrent() { events.push("producer-current") }, revoke() { events.push("revoke") }, async join() { events.push("join") } }
    },
  }
}

describe("#given a curated explore child whose Native floor allows bash", () => {
  test("#when the component binds the approved grant #then the broker is bound to the bash slot and the runner no longer refuses", () => {
    // given
    const selection = grantFor("explore"), events: string[] = []
    expect(selection.requirements).toContain("curated-readonly-broker")
    const binder = createNativeChildGuardBinding({ assertGeneration() {}, readonly: fakeOwner(events) })
    // when
    const producer = binder(spec("explore"), { buildAgentID: "build", selection })
    // then
    expect(producer.coverage).toEqual({ boundRequirements: ["curated-readonly-broker"], targets: [{ requirement: "curated-readonly-broker", nativeName: "bash", hostID: BROKER_ID }] })
    expect(runnerRefuses(selection, producer.coverage)).toBe(false)
    expect(checkHostGrantTarget(selection, BROKER_ID, producer.coverage)).toBe("selected")
    expect(checkHostGrantTarget(selection, "shell", producer.coverage)).toBe("denied")
  })

  test("#when the child is bound #then one producer is bound to the actual child session and its custody joins the guard binding", async () => {
    // given
    const selection = grantFor("librarian"), events: string[] = []
    const binder = createNativeChildGuardBinding({ assertGeneration() { events.push("generation") }, readonly: fakeOwner(events) })
    const producer = binder(spec("librarian"), { buildAgentID: "build", selection })
    // when
    const binding = producer.bind(child("ses_child"), () => { events.push("backend") })
    binding.assertCurrent()
    binding.producers?.revoke()
    await binding.producers?.join()
    // then
    expect(events[0]).toBe("bind:ses_child:build:/project")
    expect(events).toContain("producer-current")
    expect(events.slice(-2)).toEqual(["revoke", "join"])
    expect(binding.coverage).toBe(producer.coverage)
  })
})

describe("#given a non-curated child", () => {
  test("#then no broker requirement is claimed and no producer is bound", () => {
    // given
    const selection = grantFor("sisyphus-junior"), events: string[] = []
    const binder = createNativeChildGuardBinding({ assertGeneration() {}, readonly: fakeOwner(events) })
    // when
    const producer = binder(spec("sisyphus-junior"), { buildAgentID: "build", selection })
    const binding = producer.bind(child("ses_plain"), () => {})
    // then
    expect(selection.requirements).not.toContain("curated-readonly-broker")
    expect(producer.coverage).toEqual({ boundRequirements: [] })
    expect(checkHostGrantTarget(selection, BROKER_ID, producer.coverage)).toBe("denied")
    expect(binding.producers).toBeUndefined()
    expect(events).toEqual([])
  })
})

describe("#given no live readonly owner", () => {
  test("#then a curated selection stays unbound and the runner refuses it", () => {
    // given
    const selection = grantFor("explore")
    // when
    const producer = createNativeChildGuardBinding({ assertGeneration() {} })(spec("explore"), { buildAgentID: "build", selection })
    // then
    expect(runnerRefuses(selection, producer.coverage)).toBe(true)
  })
})
