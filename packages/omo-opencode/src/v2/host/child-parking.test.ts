import { expect, test } from "bun:test"
import { createSessionScopes, type SessionLease } from "./session-state"
import { createSessionBackend, type ChildJournal, type ChildRecord, type SessionBackendApi, type SessionReference } from "./session-backend"
import { withJoinedSessionCancellation } from "./session-cancellation"
import { PARKED_DENY_RULE, PARKING_MARKER_KEY, type SessionRule } from "./child-parking"

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}

const sessionID = (value: string) => value as SessionLease["sessionID"]
type Info = SessionReference & { permissions?: SessionRule[]; metadata?: Record<string, unknown> }
const userRule: SessionRule = { action: "read", resource: "*", effect: "allow" }

/** Controlled UNIT host + journal. Host own-session update replaces permissions/metadata as sent. */
function fixture(options: { join?: () => Promise<void> } = {}) {
  const scopes = createSessionScopes(), parent = scopes.open(sessionID("parent"), { tools: [], authorize: () => {} })
  const events: string[] = [], records = new Map<string, ChildRecord>(), sessions = new Map<string, Info>()
  const hooks: { interrupt?: () => void; wait?: () => void; update?: (input: { permissions?: readonly SessionRule[] }) => void | "drop" } = {}
  sessions.set("parent", { id: sessionID("parent"), location: { directory: "/project" } })
  const writeSync = (previous: ChildRecord, next: ChildRecord): undefined => {
    const old = records.get(previous.key); if (JSON.stringify(old) !== JSON.stringify(previous)) throw Error("stale fence")
    records.set(next.key, structuredClone(next)); return undefined
  }
  const journal: ChildJournal = {
    async claim(key, owner, initial) { const old = records.get(key); const value = old ? { ...old, owner, revision: old.revision + 1 } : initial; if (!value) throw Error("missing"); records.set(key, value); return structuredClone(value) },
    async read(key) { return records.has(key) ? structuredClone(defined(records.get(key))) : undefined },
    writeSync, async write(previous, next) { writeSync(previous, next) },
    assertCurrent(expected) { if (JSON.stringify(records.get(expected.key)) !== JSON.stringify(expected)) throw Error("stale synchronous fence"); return undefined },
  }
  const api: SessionBackendApi = {
    async create(input) { events.push("create"); const value = { id: sessionID(defined(input.id)), parentID: parent.sessionID, location: { directory: "/project" }, agent: "build" }; sessions.set(value.id, value); return value },
    async get({ sessionID }) { const value = sessions.get(sessionID); if (!value) throw Error("not found"); return structuredClone(value) },
    async list() { return { data: [...sessions.values()], cursor: {} } },
    async prompt(input) { events.push("prompt"); return { id: defined(input.id), sessionID: sessionID(input.sessionID) } },
    async synthetic(input) { return { id: defined(input.id), sessionID: sessionID(input.sessionID) } },
    async interrupt() { events.push("interrupt"); hooks.interrupt?.(); return { interrupted: false } },
    async wait() { events.push("wait"); hooks.wait?.() },
    async remove({ sessionID }) { events.push("remove"); sessions.delete(sessionID) }, async context() { return [] },
    instructions: { entry: { async list() { return [] }, async put() {}, async remove() {} } },
    async update(input) {
      events.push("update")
      if (hooks.update?.(input) === "drop") return
      const session = defined(sessions.get(input.sessionID))
      if (input.permissions) session.permissions = structuredClone([...input.permissions])
      if (input.metadata) session.metadata = structuredClone({ ...input.metadata })
    },
  }
  withJoinedSessionCancellation(api, "controlled-test")
  const backendOptions = { backendID: "bound-host", owner: "worker-1", parent, scopes, journal, policy: { tools: [], authorize: () => {} }, gate: { assertActive() {} },
    parking: { async join() { events.push("join"); await options.join?.() } } }
  const host = { app: { name: "opencode", version: "2.2.6", channel: "stable" }, location: { directory: "/project" }, session: api }
  const backend = createSessionBackend(host, backendOptions)
  async function staged() { const child = await backend.stage({ key: "child-task", sessionID: sessionID("child"), agent: "build" }); events.length = 0; return child }
  return { backend, host, backendOptions, events, records, sessions, hooks, staged, child: () => defined(sessions.get("child")), row: () => defined(records.get("child-task")) }
}

test("verified park appends deny-last, keeps user rules and metadata, and mints only a backend receipt", async () => {
  // given a staged child with a user rule and an unrelated metadata key
  const f = fixture(), child = await f.staged()
  Object.assign(f.child(), { permissions: [userRule], metadata: { "user.note": "keep" } })
  // when it detaches
  await f.backend.detach(child)
  // then original producers joined before interrupt/wait, one own-session write happened
  expect(f.events).toEqual(["join", "interrupt", "wait", "update"])
  expect(f.child().permissions).toEqual([userRule, PARKED_DENY_RULE])
  expect(f.child().metadata?.["user.note"]).toBe("keep")
  const parking = defined(f.row().parking)
  expect(parking).toMatchObject({ state: "parked", readback: "verified", original: { present: true, rules: [userRule] } })
  expect(f.child().metadata?.[PARKING_MARKER_KEY]).toMatchObject({ parking: parking.id, fingerprint: parking.fingerprint })
  // parked is not closed
  expect(f.row().phase).toBe("staged")
  const receipt = defined(f.backend.parkedReceipt(child))
  expect(() => f.backend.assertParked(receipt, child)).not.toThrow()
  expect(() => f.backend.assertParked({}, child)).toThrow("Unissued")
  expect(() => f.backend.assertParked(receipt, {})).toThrow("foreign")
  // and plain execution recovery stays refused; only a fresh restore approval may reacquire it
  const reload = createSessionBackend(f.host, f.backendOptions)
  await expect(reload.recover("child-task")).rejects.toThrow("only a fresh authorized restore may admit input")
})

test("absent session permissions are recorded as absent and parking adds exactly the deny rule", async () => {
  const f = fixture(), child = await f.staged()
  await f.backend.detach(child)
  expect(f.row().parking?.original).toEqual({ present: false, rules: [] })
  expect(f.child().permissions).toEqual([PARKED_DENY_RULE])
})

test("a rule change observed during quiescence becomes conflict: no write, user rules kept, no receipt, retry refuses", async () => {
  const f = fixture(), child = await f.staged()
  f.hooks.interrupt = () => { f.child().permissions = [userRule] }
  await expect(f.backend.detach(child)).rejects.toThrow("parking conflict")
  expect(f.events).not.toContain("update"); expect(f.child().permissions).toEqual([userRule])
  expect(f.row().parking?.state).toBe("conflict"); expect(f.backend.parkedReceipt(child)).toBeUndefined()
  f.hooks.interrupt = undefined
  await expect(f.backend.detach(child)).rejects.toThrow("conflict"); expect(f.events).not.toContain("update")
})

test("divergence after the intent checkpoint and a mismatched readback both retain conflict custody", async () => {
  const diverged = fixture(), first = await diverged.staged()
  // reads: 1 before quiescence, 2 quiescent snapshot (intent), 3 final pre-write recheck
  const read = diverged.host.session.get
  let reads = 0
  diverged.host.session.get = async input => { if (input.sessionID === "child" && ++reads === 3) diverged.child().permissions = [userRule]; return read(input) }
  await expect(diverged.backend.detach(first)).rejects.toThrow("diverged before write")
  expect(diverged.events).not.toContain("update"); expect(diverged.child().permissions).toEqual([userRule])

  const dropped = fixture(), second = await dropped.staged()
  dropped.hooks.update = () => "drop"
  await expect(dropped.backend.detach(second)).rejects.toThrow("readback differs")
  expect(dropped.row().parking?.state).toBe("conflict"); expect(dropped.backend.parkedReceipt(second)).toBeUndefined()
})

test("failed producer join keeps custody without any host mutation; a healthy retry parks once", async () => {
  let fail = true
  const f = fixture({ join: async () => { if (fail) throw Error("original producer still held") } }), child = await f.staged()
  await expect(f.backend.detach(child)).rejects.toThrow("original producer still held")
  expect(f.events).toEqual(["join"]); expect(f.row().parking).toBeUndefined(); expect(f.child().permissions).toBeUndefined()
  fail = false
  await f.backend.detach(child)
  expect(f.events.filter(event => event === "update")).toHaveLength(1); expect(f.row().parking?.state).toBe("parked")
})

test("lost update acknowledgement retries idempotently: intent row plus parked host state verifies without rewriting", async () => {
  const f = fixture(), child = await f.staged(); let lose = true
  const update = defined(f.host.session.update)
  f.host.session.update = async (input, options) => { await update(input, options); if (lose) { lose = false; throw Error("update acknowledgement lost") } }
  await expect(f.backend.detach(child)).rejects.toThrow("acknowledgement lost")
  expect(f.row().parking?.state).toBe("intent"); expect(f.backend.parkedReceipt(child)).toBeUndefined()
  await f.backend.detach(child)
  expect(f.events.filter(event => event === "update")).toHaveLength(1)
  expect(f.row().parking?.state).toBe("parked"); expect(f.backend.parkedReceipt(child)).toBeDefined()
})

// Phase R: fresh-action restore of the parked child's OWN session after a reload.
async function parkedThenReloaded(f: ReturnType<typeof fixture>) {
  const child = await f.staged()
  Object.assign(f.child(), { permissions: [userRule], metadata: { "user.note": "keep" } })
  await f.backend.detach(child); f.events.length = 0
  const reload = createSessionBackend(f.host, f.backendOptions)
  return { reload, child: await reload.recover("child-task", { restoreParked: true }) }
}

test("verified restore removes only our deny rule and marker, records restored, and admits input again", async () => {
  // given a parked child reacquired by a reloaded backend under a restore approval
  const f = fixture(), { reload, child } = await parkedThenReloaded(f)
  await expect(reload.begin(child, { id: "msg_refused", text: "before restore" })).rejects.toThrow("only a fresh authorized restore")
  // when the fresh action restores it
  await reload.restoreParked(child, "build")
  // then the exact original rules and unrelated metadata return, and input is admitted
  expect(f.events).toEqual(["update"]); expect(f.child().permissions).toEqual([userRule])
  expect(f.child().metadata).toEqual({ "user.note": "keep" })
  expect(f.row().parking).toMatchObject({ state: "restored", readback: "verified" })
  await reload.begin(child, { id: "msg_after_restore", text: "continue" }); expect(f.events).toContain("prompt")
})

test("rules changed while parked make restore a conflict: no write, user rules kept, input still refused", async () => {
  const f = fixture(), { reload, child } = await parkedThenReloaded(f)
  f.child().permissions = [userRule]
  await expect(reload.restoreParked(child, "build")).rejects.toThrow("parking conflict")
  expect(f.events).not.toContain("update"); expect(f.child().permissions).toEqual([userRule]); expect(f.row().parking?.state).toBe("conflict")
  await expect(reload.begin(child, { id: "msg_conflict", text: "refused" })).rejects.toThrow("parking conflict")
})

test("an approval for a different agent refuses restore before any host write", async () => {
  const f = fixture(), { reload, child } = await parkedThenReloaded(f)
  await expect(reload.restoreParked(child, "other-agent")).rejects.toThrow("agent differs")
  expect(f.events).toEqual([]); expect(f.row().parking?.state).toBe("parked")
})

test("merge-patch host metadata keeps an omitted marker, so restore nulls only that key", async () => {
  const f = fixture(), { reload, child } = await parkedThenReloaded(f)
  f.host.session.update = async input => {
    f.events.push("update")
    const session = f.child()
    if (input.permissions) session.permissions = structuredClone([...input.permissions])
    if (input.metadata) session.metadata = { ...session.metadata, ...structuredClone({ ...input.metadata }) }
  }
  await reload.restoreParked(child, "build")
  expect(f.events).toEqual(["update", "update"]); expect(f.child().metadata).toEqual({ "user.note": "keep", [PARKING_MARKER_KEY]: null })
  expect(f.row().parking?.state).toBe("restored")
})

test("a lost restore acknowledgement retries from restoring without a second write", async () => {
  const f = fixture(), { reload, child } = await parkedThenReloaded(f); let lose = true
  const update = defined(f.host.session.update)
  f.host.session.update = async (input, options) => { await update(input, options); if (lose) { lose = false; throw Error("restore acknowledgement lost") } }
  await expect(reload.restoreParked(child, "build")).rejects.toThrow("acknowledgement lost")
  expect(f.row().parking?.state).toBe("restoring")
  await reload.restoreParked(child, "build")
  expect(f.events.filter(event => event === "update")).toHaveLength(1); expect(f.row().parking?.state).toBe("restored")
})
