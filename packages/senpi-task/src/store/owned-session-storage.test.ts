import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { createTaskRecord, type TaskRecord } from "../state"
import { parseR0PersistedReasons } from "./__fixtures__/r0-ebd01f84e-reasons"
import { createTaskRecordStore } from "./record-store"
import { parseTaskRecord } from "./record-parse"
import { toStorableTaskRecord } from "./storable-record"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("owned-session-storage-")) {
      throw new Error("Unexpected owned storage fixture cleanup path")
    }
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "owned-session-storage-"))
  roots.push(root)
  const base = createTaskRecord({
    parent_session_id: "owned-parent",
    root_session_id: "owned-parent",
    depth: 1,
    execution_mode: "in-process",
    model: "qa/model",
    notify_on_terminal: false,
  })
  const owned = {
    format: 1 as const,
    backendID: "omo-native-task-opencode",
    location: root,
    hostVersion: "2.2.6",
    parentID: base.parent_session_id,
    sessionID: "owned-child",
    generation: 1,
    journalKey: `${base.task_id}:0`,
    journalOwner: "fixture-owner",
    journalRevision: 2,
    runEpoch: 0,
    residencyClaim: "fixture-claim",
  }
  const record: TaskRecord = {
    ...base,
    runner_kind: "owned-session",
    owned_session: owned,
    residency_claim: owned.residencyClaim,
    child_session_id: owned.sessionID,
  }
  const options = { project_dir: root, task: { state_dir: root } }
  return { root, record, options, path: join(root, "tasks", `${record.task_id}.json`) }
}

test("owned FileStore bytes remain readable by the frozen R0 enum contract without a fake Native endpoint", () => {
  const f = fixture(),
    store = createTaskRecordStore(f.options)
  try {
    store.save(f.record)
    const raw = JSON.parse(readFileSync(f.path, "utf8"))
    expect(raw.runner_kind).toBe("host-session")
    expect(() => parseR0PersistedReasons(raw)).not.toThrow()
    expect(raw.owned_session).toEqual(f.record.owned_session)
    expect(raw.status).toBe(f.record.status)
    expect(raw.pid).toBeUndefined()
    expect(raw.host_session).toBeUndefined()
  } finally {
    store.close()
  }
})

test("reopening and mutating the real store retains the owned runner and exact custody reference", () => {
  const f = fixture(),
    store = createTaskRecordStore(f.options)
  try {
    store.save(f.record)
  } finally {
    store.close()
  }
  const reopened = createTaskRecordStore(f.options)
  try {
    expect(reopened.load(f.record.task_id)?.runner_kind).toBe("owned-session")
    expect(reopened.load(f.record.task_id)?.owned_session).toEqual(f.record.owned_session)
    reopened.mutate(f.record.task_id, (record) => ({ ...record, description: "updated without losing custody" }))
    expect(reopened.load(f.record.task_id)?.owned_session).toEqual(f.record.owned_session)
    const raw = JSON.parse(readFileSync(f.path, "utf8"))
    expect(raw.runner_kind).toBe("host-session")
    expect(() => parseR0PersistedReasons(raw)).not.toThrow()
  } finally {
    reopened.close()
  }
})

test("the current reader decodes the compatible encoding and still reads historical raw owned records", () => {
  const { record } = fixture()
  expect(parseTaskRecord({ ...record, runner_kind: "host-session" }, "encoded.json")).toEqual(record)
  expect(parseTaskRecord(record, "historical.json")).toEqual(record)
  // Compatibility comes from actual storage encoding, never from widening the frozen reader.
  expect(() => parseR0PersistedReasons({ runner_kind: "owned-session" })).toThrow("R0 rejects runner_kind")
})

test("compatible owned encoding preserves all identity and native-mixing refusals", () => {
  const { record } = fixture()
  for (const patch of [
    { pid: 123 },
    { host_session: { socket: "not-an-issued-native-endpoint" } },
    { runner_kind: "child-process" },
    { residency_claim: "foreign" },
    { child_session_id: "foreign" },
    { owned_session: { ...record.owned_session, runEpoch: 1 } },
    { owned_session: { ...record.owned_session, parentID: "foreign" } },
    { owned_session: { ...record.owned_session, fabricatedSocket: "forbidden" } },
  ]) {
    expect(() => parseTaskRecord({ ...record, runner_kind: "host-session", ...patch }, "invalid.json")).toThrow()
  }
})

test("ordinary Native runner storage remains unchanged", () => {
  const { record } = fixture()
  const { owned_session: _owned, residency_claim: _claim, child_session_id: _child, ...fields } = record
  for (const runner_kind of ["child-process", "host-session"] as const) {
    const native = { ...fields, runner_kind }
    expect(JSON.stringify(toStorableTaskRecord(native))).toBe(JSON.stringify(native))
    expect(() => parseR0PersistedReasons(toStorableTaskRecord(native))).not.toThrow()
  }
})

test("encoding cannot disguise a missing owned reference or mixed Native identity as a valid old runner", () => {
  const { record } = fixture()
  for (const patch of [{ owned_session: undefined }, { pid: 123 }, { host_session: {} }]) {
    expect(() => toStorableTaskRecord({ ...record, ...patch } as TaskRecord)).toThrow()
  }
})
