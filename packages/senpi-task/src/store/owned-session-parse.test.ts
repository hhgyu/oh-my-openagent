import { expect, test } from "bun:test"
import { makeRecord } from "../tools/output/__fixtures__/records"
import { parseTaskRecord } from "./record-parse"
import { parseOwnedSession } from "./owned-session-parse"
import { resolve } from "node:path"

const owned = { format: 1 as const, backendID: "oc", location: resolve("."), hostVersion: "2.2.6", parentID: "session-parent", sessionID: "child", generation: 1,
  journalKey: "task:0", journalOwner: "owner", journalRevision: 1, runEpoch: 0, residencyClaim: "claim" }
test("actual Native record parser retains strict owned-session identity without fake pid or socket", () => {
  const record = { ...makeRecord({ task_id: "st_000000ef" }), runner_kind: "owned-session", owned_session: owned, residency_claim: "claim", child_session_id: "child" }
  const parsed = parseTaskRecord(record, "fixture.json")
  expect(parsed.owned_session).toEqual(owned)
  expect(parsed.pid).toBeUndefined(); expect(parsed.host_session).toBeUndefined()
})
test("owned identity rejects mixed native identity, unknown keys and malformed generations", () => {
  for (const patch of [{ pid: 123 }, { runner_kind: "child-process" }, { owned_session: { ...owned, generation: -1 } }, { residency_claim: "other" }, { child_session_id: "other" }, { owned_session: { ...owned, runEpoch: 1 } }]) {
    expect(() => parseTaskRecord({ ...makeRecord({ task_id: "st_000000ef" }), runner_kind: "owned-session", owned_session: owned, residency_claim: "claim", child_session_id: "child", ...patch }, "fixture.json")).toThrow()
  }
  expect(() => parseOwnedSession({ ...owned, fakeSocket: "not-allowed" })).toThrow()
})

test("failed closing owned identity survives roundtrip and refuses mixed or malformed children", () => {
  const record = { ...makeRecord({ task_id: "st_000000ef" }), fallback_closing_child: { owned_session: owned } }
  expect(parseTaskRecord(record, "fixture.json").fallback_closing_child?.owned_session).toEqual(owned)
  for (const closing of [{ owned_session: { ...owned, journalRevision: -1 } }, { owned_session: owned, pid: 123 }]) {
    expect(() => parseTaskRecord({ ...record, fallback_closing_child: closing }, "fixture.json")).toThrow()
  }
})

