import { expect, test } from "bun:test"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTaskRecordStore, ChildObservationUncertain } from "@oh-my-opencode/senpi-task/manager-kernel"
import { createOwnedEventProjection } from "./owned-events"
import type { OwnedChildObservationView, ObservationRecord } from "../../host/owned-child-observation-types"

function view(): OwnedChildObservationView {
  let seq = 0
  const event = (type: string, data: object = {}): ObservationRecord => ({
    kind: "host",
    id: `event:${seq}`,
    event: {
      id: `event:${seq}`,
      type,
      created: seq,
      sessionID: "child",
      durable: { aggregateID: "child", seq: seq++, version: 1 },
      data,
    },
  })
  return {
    uncertainty: [],
    toolMetadata: { scope: "model-loop-outer-calls", coverage: "partial", reasons: [], joined: [] },
    records: [
      { kind: "input", id: "own", inboxID: "inbox" },
      event("session.execution.started"),
      event("session.step.started", { assistantMessageID: "control", model: { providerID: "p", id: "control" } }),
      event("session.text.ended", { assistantMessageID: "control", ordinal: 0, text: "not-owned" }),
      event("session.step.ended", { assistantMessageID: "control", finish: "stop" }),
      event("session.inbox.delivered", { inboxID: "inbox" }),
      event("session.step.started", { assistantMessageID: "actual", model: { providerID: "p", id: "actual" } }),
      event("session.text.ended", { assistantMessageID: "actual", ordinal: 0, text: "owned" }),
      event("session.step.ended", { assistantMessageID: "actual", finish: "stop" }),
      event("session.execution.succeeded"),
    ],
  }
}
test("real own-log frames survive lost acknowledgement without duplicating and exclude pre-delivery text", () => {
  const dir = mkdtempSync(join(tmpdir(), "omo-owned-frame-"))
  mkdirSync(join(dir, "tasks"))
  const store = createTaskRecordStore({ project_dir: dir, task: { state_dir: dir } })
  try {
    for (let crash = 0; crash < 2; crash++) {
      const projection = createOwnedEventProjection("st_000000ef", 0, dir, () => {})
      for (const event of projection.events(view())) projection.persist(store, event)
    }
    const lines = readFileSync(join(dir, "logs/st_000000ef.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect(lines).toHaveLength(1)
    expect(lines[0].payload.text).toBe("owned")
    expect(lines[0].payload.__omo_projection).toBeString()
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
test("a run the session starts on its own after the owned run is shown as part of the turn", () => {
  // given: the owned run, then a wake run started by a background job's notice (no own input)
  const base = view()
  const wake = (type: string, seq: number, data: object = {}): ObservationRecord => ({
    kind: "host",
    id: `wake:${seq}`,
    event: {
      id: `wake:${seq}`,
      type,
      created: 100 + seq,
      sessionID: "child",
      durable: { aggregateID: "child", seq: 100 + seq, version: 1 },
      data,
    },
  })
  const records = [
    ...base.records,
    wake("session.execution.started", 0),
    wake("session.inbox.delivered", 1, { inboxID: "notice" }),
    wake("session.step.started", 2, { assistantMessageID: "woken", model: { providerID: "p", id: "actual" } }),
    wake("session.text.ended", 3, { assistantMessageID: "woken", ordinal: 0, text: "after wake" }),
    wake("session.step.ended", 4, { assistantMessageID: "woken", finish: "stop" }),
    wake("session.execution.succeeded", 5),
  ]

  // when
  const texts = createOwnedEventProjection("st_000000f0", 0, tmpdir(), () => {})
    .events({ ...base, records })
    .map((event) => (event.message as { content?: { text: string }[] } | undefined)?.content?.[0]?.text)
    .filter((text) => text !== undefined)

  // then
  expect(texts).toEqual(["owned", "after wake"])
})

test("torn own frame and explicit log bound refuse before further append", () => {
  const dir = mkdtempSync(join(tmpdir(), "omo-owned-torn-"))
  mkdirSync(join(dir, "tasks"))
  mkdirSync(join(dir, "logs"))
  const store = createTaskRecordStore({ project_dir: dir, task: { state_dir: dir } })
  try {
    const path = join(dir, "logs/st_000000ef.jsonl")
    for (const [text, reason] of [
      ["{torn", "torn-own-log-frame"],
      ["x".repeat(101), "own-log-capacity-exceeded"],
    ] as const) {
      writeFileSync(path, text)
      const projection = createOwnedEventProjection("st_000000ef", 0, dir, () => {}, 100)
      expect(() => {
        for (const event of projection.events(view())) projection.persist(store, event)
      }).toThrow(ChildObservationUncertain)
      try {
        for (const event of projection.events(view())) projection.persist(store, event)
      } catch (error) {
        expect((error as ChildObservationUncertain).reason).toBe(reason)
      }
      expect(readFileSync(path, "utf8")).toBe(text)
    }
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
