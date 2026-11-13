import { expect, test } from "bun:test"
import type { SessionHooks } from "@opencode/plugin/promise/session"
import { createSessionScopes, type SessionLease } from "./session-state"
import { createSettlementCoordinator, type SettlementFact } from "./settlement"
function fixture() {
  const scopes = createSessionScopes()
  const lease = scopes.open("parent" as SessionLease["sessionID"], { tools: [], authorize: () => {} })
  const facts: SettlementFact[] = []
  const hooks = new Map<string, (value: never) => Promise<void> | void>()
  let disposed = 0
  const coordinator = createSettlementCoordinator({
    lease,
    scopes,
    trust: {
      async authorizeResume(token) {
        return token === "real-input"
      },
    },
    publish: async (fact) => {
      facts.push(fact)
    },
  })
  const host = {
    hook: async <N extends keyof SessionHooks>(name: N, callback: (input: SessionHooks[N]) => Promise<void> | void) => {
      hooks.set(name, callback as (input: never) => Promise<void> | void)
      return {
        dispose: async () => {
          hooks.delete(name)
          disposed++
        },
      }
    },
  }
  const idle = (background: SessionHooks["experimental.idle"]["background"] = []) =>
    coordinator.idle({ sessionID: lease.sessionID, background })
  return {
    coordinator,
    lease,
    scopes,
    facts,
    hooks,
    host,
    idle,
    get disposed() {
      return disposed
    },
  }
}
test("successful idle is claimed once for the same explicit execution/turn", async () => {
  const f = fixture()
  f.coordinator.begin({ executionID: "e1", turn: 1, kind: "primary" })
  await f.idle()
  await f.idle()
  expect(f.facts.filter((x) => x.eligible)).toHaveLength(1)
  expect(f.facts[0]).toMatchObject({ executionID: "e1", turn: 1, generation: f.lease.generation })
  expect(() => f.coordinator.begin({ executionID: "e1", turn: 1, kind: "primary" })).toThrow()
})
test("owned background defers; descendant work is informational and does not independently wake parent", async () => {
  const f = fixture()
  f.coordinator.begin({ executionID: "e1", turn: 1, kind: "primary" })
  await f.idle([{ kind: "shell", sessionID: f.lease.sessionID, shellID: "s", command: "sleep" }])
  expect(f.facts.at(-1)?.eligible).toBe(false)
  await f.idle([
    { kind: "shell", sessionID: "descendant" as SessionLease["sessionID"], shellID: "d", command: "sleep" },
  ])
  expect(f.facts.at(-1)).toMatchObject({ eligible: true, descendantBackground: 1 })
})
test("failure,interruption,retry and control-only work never become settled success", async () => {
  for (const outcome of ["failed", "interrupted", "retrying", "control"] as const) {
    const f = fixture()
    f.coordinator.begin({ executionID: "e", turn: 1, kind: "primary" })
    f.coordinator.end({ executionID: "e", turn: 1, outcome })
    await f.idle()
    expect(f.facts).toEqual([])
  }
})
test("pause resets only with verified real user input; late prior turn cannot settle new turn", async () => {
  const f = fixture()
  f.coordinator.begin({ executionID: "e", turn: 1, kind: "primary" })
  f.coordinator.pause()
  await expect(f.coordinator.resume("model says resume")).rejects.toThrow()
  expect(() => f.coordinator.assertActive(f.lease)).toThrow()
  await f.coordinator.resume("real-input")
  f.coordinator.begin({ executionID: "e", turn: 2, kind: "primary" })
  f.coordinator.end({ executionID: "e", turn: 1, outcome: "failed" })
  await f.idle()
  expect(f.facts.at(-1)?.turn).toBe(2)
})
test("scope retirement rejects new work and prevents idle publications", async () => {
  const f = fixture()
  f.coordinator.begin({ executionID: "e", turn: 1, kind: "primary" })
  f.scopes.retire(f.lease)
  await f.idle()
  expect(f.facts).toEqual([])
  expect(() => f.coordinator.begin({ executionID: "next", turn: 1, kind: "primary" })).toThrow()
})
test("hooks install and fully dispose exactly once", async () => {
  const f = fixture()
  await f.coordinator.install(f.host)
  await f.coordinator.install(f.host)
  expect([...f.hooks.keys()]).toEqual(["experimental.idle", "retry", "compaction"])
  await f.coordinator.dispose()
  await f.coordinator.dispose()
  expect(f.disposed).toBe(3)
  expect(f.hooks.size).toBe(0)
})
test("uncertain arbiter publication cannot emit the same eligible edge again", async () => {
  const f = fixture()
  let calls = 0
  const coordinator = createSettlementCoordinator({
    lease: f.lease,
    scopes: f.scopes,
    trust: {
      async authorizeResume() {
        return false
      },
    },
    publish: async () => {
      calls++
      throw Error("receipt lost")
    },
  })
  coordinator.begin({ executionID: "e", turn: 1, kind: "primary" })
  await expect(coordinator.idle({ sessionID: f.lease.sessionID, background: [] })).rejects.toThrow()
  await coordinator.idle({ sessionID: f.lease.sessionID, background: [] })
  expect(calls).toBe(1)
})

test("dispose during asynchronous hook installation retires the late registration", async () => {
  const f = fixture()
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let retired = 0
  const installing = f.coordinator.install({
    hook: async () => {
      await pending
      return {
        dispose: async () => {
          retired++
        },
      }
    },
  })
  const disposed = f.coordinator.dispose()
  release()
  await expect(installing).rejects.toThrow()
  await disposed
  expect(retired).toBe(1)
})
test("synchronous arbiter failure is uncertain and never publishes twice", async () => {
  const f = fixture()
  let calls = 0
  const c = createSettlementCoordinator({
    lease: f.lease,
    scopes: f.scopes,
    trust: {
      async authorizeResume() {
        return false
      },
    },
    publish: () => {
      calls++
      throw Error("sync")
    },
  })
  c.begin({ executionID: "e", turn: 1, kind: "primary" })
  await expect(c.idle({ sessionID: f.lease.sessionID, background: [] })).rejects.toThrow()
  await c.idle({ sessionID: f.lease.sessionID, background: [] })
  expect(calls).toBe(1)
})

test("a newer Stop invalidates an asynchronous trusted resume verification", async () => {
  const f = fixture()
  let release!: (value: boolean) => void
  const proof = new Promise<boolean>((resolve) => {
    release = resolve
  })
  const c = createSettlementCoordinator({
    lease: f.lease,
    scopes: f.scopes,
    trust: { authorizeResume: async () => proof },
    publish: async () => {},
  })
  c.pause()
  const resume = c.resume("old-real-input")
  c.pause()
  release(true)
  await expect(resume).rejects.toThrow("newer Stop")
  expect(() => c.assertActive(f.lease)).toThrow()
})

test("pause aborts an in-flight arbiter publication and disposal joins it", async () => {
  const f = fixture()
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  const c = createSettlementCoordinator({
    lease: f.lease,
    scopes: f.scopes,
    trust: {
      async authorizeResume() {
        return false
      },
    },
    publish: async (_fact, lifetime) => {
      started()
      await new Promise<void>((_resolve, reject) =>
        lifetime.signal.addEventListener("abort", () => reject(lifetime.signal.reason), { once: true }),
      )
    },
  })
  c.begin({ executionID: "e", turn: 1, kind: "primary" })
  const idle = c.idle({ sessionID: f.lease.sessionID, background: [] })
  await entered
  c.pause()
  await expect(idle).rejects.toThrow()
  await c.dispose()
})
