import { expect, test } from "bun:test"
import { projectOwnedChildOutcome } from "./owned-child-outcome"
import type { ObservationRecord, ObservationSnapshot, SafeChildEvent } from "./owned-child-observation-types"

function fixture(name: keyof typeof captured = "success"): ObservationSnapshot {
  const events: SafeChildEvent[] = structuredClone(captured[name])
  const inputs: ObservationRecord[] = events.filter(event => event.type === "session.inbox.enqueued" && event.data.inputKind !== "compact")
    .map(event => ({ kind: "input", id: `local:${event.data.inboxID}`, inboxID: event.data.inboxID! }))
  return {
    binding: { key: "task-fixture", token: "observation-binding", locator: {
      format: 1, backendID: "actual-host", location: "/isolated/fixture", hostVersion: "2.2.6",
      parentID: "parent" as never, sessionID: events[0]!.sessionID as never, generation: 1,
    } },
    records: [...inputs, ...events.map(event => ({ kind: "host" as const, id: event.id, event }))], uncertainty: [],
  }
}
function events(snapshot: ObservationSnapshot) {
  return snapshot.records.filter((record): record is Extract<ObservationRecord, { kind: "host" }> => record.kind === "host")
}
function revise(snapshot: ObservationSnapshot, filter: (record: ObservationRecord) => boolean): ObservationSnapshot {
  const records = structuredClone(snapshot.records.filter(filter))
  let seq = 0
  for (const record of records) if (record.kind === "host" && record.event.durable) record.event.durable.seq = seq++
  return { ...snapshot, records }
}
function host(type: string, seq: number, data: SafeChildEvent["data"] = {}, sessionID = "ses_owned_probe_success"): ObservationRecord {
  const id = `event:${seq}:${type}`
  return { kind: "host", id, event: { id, type, created: seq, sessionID, durable: { aggregateID: sessionID, seq, version: 1 }, data } }
}
function retryFixture(): ObservationSnapshot {
  const records = structuredClone(actualRetryRecords) as ObservationRecord[]
  const retry = records.find(record => record.kind === "host" && record.event.type === "session.retry.scheduled") as Extract<ObservationRecord, { kind: "host" }>
  // The first capture omitted attempt. The later actual capture proves the first retry is attempt 2;
  // missing it is separately tested as uncertain, never inferred by the projector.
  retry.event.data.attempt = 2
  const snapshot = fixture()
  return { ...snapshot, binding: { ...snapshot.binding, locator: { ...snapshot.binding.locator,
    sessionID: events({ ...snapshot, records })[0]!.event.sessionID as never } }, records }
}

test("actual captured completed step returns exact full text, actual model, and only observed usage", () => {
  const result = projectOwnedChildOutcome(fixture())
  expect(result).toMatchObject({ status: "completed", text: "FINAL_SUCCESS_MARKER", consumption: "unconfirmed",
    model: { providerID: "qa-local", id: "gpt-qa", variant: "default" }, observedSteps: 1,
    tokens: { input: 7, output: 3, reasoning: 0 }, cost: 0 })
  expect(result.startEventID).toBe("evt_1b77e360d001rxwI81iHn0s9f9")
  expect(result).not.toHaveProperty("executionID")
  expect(result).not.toHaveProperty("observedToolCalls")
  expect(result.tokens).not.toHaveProperty("cacheRead")
})
test("actual same-execution synthetic continuation returns the final step, never concatenated turns", () => {
  const result = projectOwnedChildOutcome(fixture("continuation"))
  expect(result).toMatchObject({ status: "completed", text: "CONTINUED_FINAL_MARKER", observedSteps: 2,
    tokens: { input: 14, output: 6, reasoning: 0 }, cost: 0 })
  expect(result.delivered).toHaveLength(2)
  expect(result.text).not.toContain("FINAL_CONTINUATION_MARKER")
})
test("actual empty success is an explicit task output error", () => {
  expect(projectOwnedChildOutcome(fixture("empty"))).toMatchObject({ status: "error", reason: "empty-assistant-output" })
})

test("explicit Native turn policy accepts a positively observed empty assistant turn", () => {
  expect(projectOwnedChildOutcome(fixture("empty"), "turn")).toMatchObject({ status: "completed", text: "", observedSteps: 1, consumption: "unconfirmed" })
  expect(projectOwnedChildOutcome(fixture("empty"), "final-text").status).toBe("error")
  expect(projectOwnedChildOutcome(fixture(), "unknown" as never)).toMatchObject({ status: "uncertain", reason: "invalid-completion-policy" })
})

test("Native turn retains last nonempty current-turn text across an empty final step without changing default", () => {
  const snapshot = fixture("tool")
  for (const row of events(snapshot)) if (row.event.type === "session.text.ended") row.event.data.text = ""
  const firstEnd = events(snapshot).find(row => row.event.type === "session.step.ended")!
  const start = events(snapshot).find(row => row.event.type === "session.step.started")!
  const index = snapshot.records.indexOf(firstEnd)
  const records = [...snapshot.records]
  records.splice(index, 0,
    host("session.text.started", 900, { assistantMessageID: start.event.data.assistantMessageID, ordinal: 42 }, start.event.sessionID),
    host("session.text.ended", 901, { assistantMessageID: start.event.data.assistantMessageID, ordinal: 42, text: "current tool-stage verdict" }, start.event.sessionID))
  const complete = revise({ ...snapshot, records }, () => true)
  expect(projectOwnedChildOutcome(complete).status).toBe("error")
  expect(projectOwnedChildOutcome(complete, "final-text")).toMatchObject({ status: "completed", text: "current tool-stage verdict" })
  expect(projectOwnedChildOutcome(complete, "turn")).toMatchObject({ status: "completed", text: "current tool-stage verdict", observedToolCalls: 1, observedSteps: 2 })
})

test("turn policy preserves failure Stop delivery cursor retry and tool coverage gates", () => {
  for (const name of ["error", "interrupt"] as const) expect(projectOwnedChildOutcome(fixture(name), "turn").status).not.toBe("completed")
  const empty = fixture("empty")
  expect(projectOwnedChildOutcome({ ...empty, records: [...empty.records, { kind: "stop", id: "stop:policy" }] }, "turn").status).toBe("pending")
  expect(projectOwnedChildOutcome({ ...empty, records: empty.records.filter(row => row.kind !== "input") }, "turn").status).toBe("control-only")
  expect(projectOwnedChildOutcome(revise(empty, row => row.kind !== "host" || !row.event.type.startsWith("session.step.") && !row.event.type.startsWith("session.text.")), "turn").status).toBe("uncertain")
  const gap = fixture("empty"); events(gap).at(-1)!.event.durable!.seq += 1
  expect(projectOwnedChildOutcome(gap, "turn").status).toBe("uncertain")
  const retry = retryFixture()
  expect(projectOwnedChildOutcome(revise(retry, row => row.kind !== "host" || row.event.type !== "session.retry.scheduled"), "turn").status).toBe("uncertain")
  const tool = fixture("tool")
  expect(projectOwnedChildOutcome(revise(tool, row => row.kind !== "host" || !["session.tool.success", "session.tool.failed"].includes(row.event.type)), "turn").status).toBe("uncertain")
})

test("explicit Native policies never borrow nonempty text from an earlier execution frame", () => {
  const prior = fixture(), next = fixture("empty")
  // Same owned session, but fresh assistant/input/event identities and a new actual frame.
  for (const row of next.records) {
    row.id = `next:${row.id}`
    if (row.kind === "input") row.inboxID = `next:${row.inboxID}`
    if (row.kind === "host") {
      row.event.id = row.id; row.event.sessionID = prior.binding.locator.sessionID
      row.event.durable!.aggregateID = prior.binding.locator.sessionID
      if (row.event.data.inboxID) row.event.data.inboxID = `next:${row.event.data.inboxID}`
      if (row.event.data.assistantMessageID) row.event.data.assistantMessageID = `next:${row.event.data.assistantMessageID}`
    }
  }
  const snapshot = revise({ ...prior, records: [...prior.records, ...next.records] }, () => true)
  expect(projectOwnedChildOutcome(snapshot, "turn")).toMatchObject({ status: "completed", text: "" })
  expect(projectOwnedChildOutcome(snapshot, "final-text")).toMatchObject({ status: "error", reason: "empty-assistant-output" })
})

test("both Native policies keep unknown version missing delivery and unfinished assistant gates", () => {
  for (const policy of ["turn", "final-text"] as const) {
    const version = fixture("empty"); events(version).at(-1)!.event.durable!.version = 99
    expect(projectOwnedChildOutcome(version, policy).status).toBe("uncertain")
    const delivery = fixture("empty")
    expect(projectOwnedChildOutcome(revise(delivery, row => row.kind !== "host" || row.event.type !== "session.inbox.delivered"), policy).status).toBe("control-only")
    const unfinished = fixture("empty")
    events(unfinished).find(row => row.event.type === "session.step.ended")!.event.data.finish = "tool-calls"
    expect(projectOwnedChildOutcome(unfinished, policy)).toMatchObject({ status: "uncertain", reason: "unfinished-assistant-turn" })
    const pending = fixture("empty")
    expect(projectOwnedChildOutcome({ ...pending, records: [...pending.records, { kind: "input", id: "next:undelivered", inboxID: "undelivered" }] }, policy).status).toBe("pending")
  }
})

test("Native policy cannot borrow pre-delivery control steps in the same execution", () => {
  const snapshot = fixture("empty"), sessionID = snapshot.binding.locator.sessionID
  const at = snapshot.records.findIndex(row => row.kind === "host" && row.event.type === "session.inbox.delivered")
  const records = [...snapshot.records]
  records.splice(at, 0,
    host("session.step.started", 800, { assistantMessageID: "control-before-input", model: { providerID: "qa-local", id: "control" } }, sessionID),
    host("session.text.started", 801, { assistantMessageID: "control-before-input", ordinal: 0 }, sessionID),
    host("session.text.ended", 802, { assistantMessageID: "control-before-input", ordinal: 0, text: "CONTROL_TEXT_MUST_NOT_BORROW" }, sessionID),
    host("session.step.ended", 803, { assistantMessageID: "control-before-input", finish: "stop" }, sessionID))
  const complete = revise({ ...snapshot, records }, () => true)
  expect(projectOwnedChildOutcome(complete, "turn")).toMatchObject({ status: "completed", text: "" })
  expect(projectOwnedChildOutcome(complete, "final-text")).toMatchObject({ status: "error", reason: "empty-assistant-output" })
  const noOwnedStep = revise(complete, row => row.kind !== "host" || !row.event.data.assistantMessageID || row.event.data.assistantMessageID === "control-before-input")
  for (const policy of ["turn", "final-text"] as const) expect(projectOwnedChildOutcome(noOwnedStep, policy))
    .toMatchObject({ status: "uncertain", reason: "missing-owned-assistant-step" })
})
test("actual provider failure and interrupted text cannot project completed", () => {
  expect(projectOwnedChildOutcome(fixture("error"))).toMatchObject({ status: "error", reason: "provider.invalid-request" })
  expect(projectOwnedChildOutcome(fixture("interrupt"))).toMatchObject({ status: "interrupted", reason: "host-interrupted" })
})
test("actual failed tool attempt is counted as observed, not a successful execution or known total", () => {
  const result = projectOwnedChildOutcome(fixture("tool"))
  expect(result).toMatchObject({ status: "completed", text: "FINAL_TOOL_MARKER", observedToolCalls: 1, observedSteps: 2 })
  expect(result).not.toHaveProperty("toolCalls")
})
test("request-kind metadata cannot invent an assistant step or override its observed model", () => {
  const snapshot = fixture()
  const records: ObservationRecord[] = [{ kind: "primary", id: "hook:primary", model: { providerID: "wrong", id: "planned" } },
    { kind: "auxiliary", id: "hook:title", requestKind: "title" }, ...snapshot.records]
  expect(projectOwnedChildOutcome({ ...snapshot, records }).model?.providerID).toBe("qa-local")
  const control = revise(snapshot, record => record.kind === "host" && !record.event.type.startsWith("session.step.") && !record.event.type.startsWith("session.text."))
  expect(projectOwnedChildOutcome({ ...control, records: [...records.slice(0, 2), ...control.records] }).status).toBe("control-only")
})
test("unowned or locally unrecorded input in a real execution is control-only", () => {
  const snapshot = fixture()
  expect(projectOwnedChildOutcome({ ...snapshot, records: snapshot.records.filter(record => record.kind !== "input") }).status).toBe("control-only")
  const input = snapshot.records.find(record => record.kind === "input")!
  expect(projectOwnedChildOutcome({ ...snapshot, records: [...snapshot.records.filter(record => record.kind !== "input"), input] }).status).toBe("control-only")
})
test("own delivery from a preceding frame cannot authorize control-only compaction success", () => {
  const snapshot = fixture()
  const seq = events(snapshot).at(-1)!.event.durable!.seq + 1
  const records = [...snapshot.records, { kind: "auxiliary" as const, id: "hook:compact", requestKind: "compaction" as const },
    host("session.execution.started", seq), host("session.compaction.started", seq + 1),
    host("session.compaction.failed", seq + 2, { errorType: "provider.invalid-request" }), host("session.execution.succeeded", seq + 3)]
  expect(projectOwnedChildOutcome({ ...snapshot, records })).toMatchObject({ status: "control-only", delivered: [] })
})
test("Stop intent suppresses pending/stale success without fabricating a host acknowledgement", () => {
  for (const snapshot of [fixture(), { ...fixture(), records: [] }, fixture("empty")]) {
    const result = projectOwnedChildOutcome({ ...snapshot, records: [...snapshot.records, { kind: "stop", id: "local:stop" }] })
    expect(result).toMatchObject({ status: "pending", reason: "stop-pending" })
  }
  const interrupted = fixture("interrupt")
  expect(projectOwnedChildOutcome({ ...interrupted, records: [{ kind: "stop", id: "local:stop" }, ...interrupted.records] }).status).toBe("interrupted")
})
test("a new expected input cannot reuse an older completed result", () => {
  const snapshot = fixture()
  expect(projectOwnedChildOutcome({ ...snapshot, records: [...snapshot.records, { kind: "input", id: "local:next", inboxID: "next" }] }))
    .toMatchObject({ status: "pending", reason: "input-not-delivered" })
})
test("cursor version is event schema version, not a monotonic aggregate counter", () => {
  const snapshot = fixture()
  expect(events(snapshot).some(record => record.event.durable?.version === 2)).toBe(true)
  expect(projectOwnedChildOutcome(snapshot).status).toBe("completed")
  events(snapshot).at(-1)!.event.durable!.version = 3
  expect(projectOwnedChildOutcome(snapshot)).toMatchObject({ status: "uncertain", reason: "unknown-event-version" })
})
test("gap/reordering/missing cursor are insufficient coverage, not asserted transport loss", () => {
  for (const mutate of [
    (rows: ReturnType<typeof events>) => { rows[5]!.event.durable!.seq += 1 },
    (rows: ReturnType<typeof events>) => { rows[5]!.event.durable = undefined },
    (rows: ReturnType<typeof events>) => { rows[5]!.event.durable!.seq = rows[4]!.event.durable!.seq },
  ]) {
    const snapshot = fixture(); mutate(events(snapshot))
    expect(projectOwnedChildOutcome(snapshot).status).toBe("uncertain")
    expect(projectOwnedChildOutcome(snapshot).reason).not.toContain("transport")
  }
})
test("duplicate IDs, conflicting IDs, foreign sessions and malformed records fail closed", () => {
  const snapshot = fixture()
  const first = events(snapshot)[0]!
  expect(projectOwnedChildOutcome({ ...snapshot, records: [...snapshot.records, first] }).status).toBe("uncertain")
  expect(projectOwnedChildOutcome({ ...snapshot, records: [...snapshot.records, { ...first, event: { ...first.event, type: "session.execution.succeeded" } }] }).status).toBe("uncertain")
  first.event.sessionID = "foreign"
  expect(projectOwnedChildOutcome(snapshot).status).toBe("uncertain")
  expect(projectOwnedChildOutcome({ ...snapshot, records: [{ kind: "stop", id: "s", auth: "forbidden" } as never] }).status).toBe("uncertain")
})
test("rebind/lost observation/local invalidation cannot expose historic success or stats", () => {
  const snapshot = fixture()
  for (const uncertainty of [["rebound"], ["stream-ended"], ["overflow"]]) {
    expect(projectOwnedChildOutcome({ ...snapshot, uncertainty })).toEqual({ status: "uncertain", reason: "observation-invalidated", delivered: [], consumption: "unconfirmed" })
  }
  expect(projectOwnedChildOutcome({ ...snapshot, records: [...snapshot.records, { kind: "uncertain", id: "local:uncertain", reason: "gap" }] }).status).toBe("uncertain")
})
test("unmatched text/step/model/terminal cannot manufacture output", () => {
  for (const modify of [
    (snapshot: ObservationSnapshot) => revise(snapshot, record => record.kind !== "host" || record.event.type !== "session.step.started"),
    (snapshot: ObservationSnapshot) => { events(snapshot).find(record => record.event.type === "session.step.started")!.event.data.model = undefined; return snapshot },
    (snapshot: ObservationSnapshot) => { events(snapshot).find(record => record.event.type === "session.text.ended")!.event.data.assistantMessageID = "unmatched"; return snapshot },
    (snapshot: ObservationSnapshot) => revise(snapshot, record => record.kind !== "host" || record.event.type !== "session.step.ended"),
    (snapshot: ObservationSnapshot) => { events(snapshot).find(record => record.event.type === "session.step.ended")!.event.data.finish = "new-unknown-finish"; return snapshot },
  ]) expect(projectOwnedChildOutcome(modify(fixture())).status).toBe("uncertain")
})
test("full text ordinal parts join within a step with matched starts; reasoning ordinal gaps are valid", () => {
  const snapshot = fixture()
  const records = [...structuredClone(snapshot.records)]
  const index = records.findIndex(record => record.kind === "host" && record.event.type === "session.text.ended")
  const original = records[index] as Extract<ObservationRecord, { kind: "host" }>
  original.event.data.text = "first "
  const second = structuredClone(original)
  second.id = second.event.id = "actual-part-two"
  second.event.data = { ...second.event.data, ordinal: 1, text: "second" }
  const start = structuredClone(second)
  start.id = start.event.id = "actual-part-two-start"
  start.event.type = "session.text.started"
  delete start.event.data.text
  records.splice(index + 1, 0, start, second)
  const modified = revise({ ...snapshot, records }, () => true)
  expect(projectOwnedChildOutcome(modified)).toMatchObject({ status: "completed", text: "first second" })
  events(modified).find(record => record.id === "actual-part-two")!.event.data.ordinal = 3
  expect(projectOwnedChildOutcome(modified).status).toBe("uncertain")
  events(modified).find(record => record.id === "actual-part-two-start")!.event.data.ordinal = 3
  expect(projectOwnedChildOutcome(modified)).toMatchObject({ status: "completed", text: "first second" })
  events(modified).find(record => record.id === "actual-part-two")!.event.data.ordinal = 0
  expect(projectOwnedChildOutcome(modified).status).toBe("uncertain")
})
test("thinking part ordinals do not require reading or retaining reasoning text", () => {
  const snapshot = fixture()
  for (const record of events(snapshot)) if (record.event.type.startsWith("session.text.")) record.event.data.ordinal = 1
  const rows = [...snapshot.records]
  const index = rows.findIndex(record => record.kind === "host" && record.event.type === "session.text.started")
  const step = events(snapshot).find(record => record.event.type === "session.step.started")!.event.data.assistantMessageID!
  rows.splice(index, 0, host("session.reasoning.started", 0, { assistantMessageID: step, ordinal: 0 }),
    host("session.reasoning.ended", 0, { assistantMessageID: step, ordinal: 0 }))
  expect(projectOwnedChildOutcome(revise({ ...snapshot, records: rows }, () => true))).toMatchObject({ status: "completed", text: "FINAL_SUCCESS_MARKER" })
})
test("missing text starts or ends remain uncertain even with complete durable cursor envelopes", () => {
  for (const type of ["session.text.started", "session.text.ended"]) {
    expect(projectOwnedChildOutcome(revise(fixture(), record => record.kind !== "host" || record.event.type !== type)).status).toBe("uncertain")
  }
})
test("the public session.tool.success terminal is accepted; invented succeeded spelling is uncertain", () => {
  const snapshot = fixture("tool")
  const tool = events(snapshot).find(record => record.event.type === "session.tool.failed")!
  tool.event.type = "session.tool.success"
  delete tool.event.data.errorType
  expect(projectOwnedChildOutcome(snapshot)).toMatchObject({ status: "completed", observedToolCalls: 1 })
  tool.event.type = "session.tool.succeeded"
  expect(projectOwnedChildOutcome(snapshot).status).toBe("uncertain")
})
test("no missing usage field is inferred as zero; only complete per-key step coverage is aggregated", () => {
  const snapshot = fixture("continuation")
  const first = events(snapshot).find(record => record.event.type === "session.step.ended")!
  first.event.data.tokens = { input: 7 }
  first.event.data.cost = undefined
  const result = projectOwnedChildOutcome(snapshot)
  expect(result.tokens).toEqual({ input: 14 })
  expect(result).not.toHaveProperty("cost")
  expect(result).not.toHaveProperty("observedToolCalls")
})
test("no terminal yet stays pending even after receiving full assistant text", () => {
  const snapshot = fixture()
  expect(projectOwnedChildOutcome(revise(snapshot, record => record.kind !== "host" || record.event.type !== "session.execution.succeeded")).status).toBe("pending")
})
test("an unknown execution transition cannot leave an earlier completed result live", () => {
  const snapshot = fixture()
  const seq = events(snapshot).at(-1)!.event.durable!.seq + 1
  expect(projectOwnedChildOutcome({ ...snapshot, records: [...snapshot.records, host("session.execution.unknown", seq)] }))
    .toMatchObject({ status: "uncertain", reason: "unknown-execution-event" })
})
test("real failure before the first assistant step still terminalizes an owned input", () => {
  const snapshot = revise(fixture("error"), record => record.kind !== "host" || !record.event.type.startsWith("session.step."))
  expect(projectOwnedChildOutcome(snapshot)).toMatchObject({ status: "error", reason: "provider.invalid-request" })
})
test("real interruption before the first assistant step still terminalizes an owned input", () => {
  const snapshot = revise(fixture("interrupt"), record => record.kind !== "host"
    || !record.event.type.startsWith("session.step.") && !record.event.type.startsWith("session.text."))
  expect(projectOwnedChildOutcome(snapshot)).toMatchObject({ status: "interrupted", reason: "host-interrupted" })
})
test("success without a concrete assistant step is uncertain when owned input was delivered", () => {
  const snapshot = revise(fixture(), record => record.kind !== "host"
    || !record.event.type.startsWith("session.step.") && !record.event.type.startsWith("session.text."))
  expect(projectOwnedChildOutcome(snapshot)).toMatchObject({ status: "uncertain", reason: "missing-assistant-step" })
})
test("actual retry sequence reuses one assistant step only after a matching scheduled attempt", () => {
  const result = projectOwnedChildOutcome(retryFixture())
  expect(result).toMatchObject({ status: "completed", text: "FINAL_RETRY_MARKER", observedSteps: 1,
    tokens: { input: 7, output: 3, reasoning: 0 }, cost: 0 })
  expect(result.assistantMessageID).toBe("msg_1b78b8c870016nZqys37n3WhfN")
})
test("retry schedule is pending evidence, not a successful retry or completed task", () => {
  const snapshot = retryFixture()
  const index = snapshot.records.findIndex(record => record.kind === "host" && record.event.type === "session.retry.scheduled")
  expect(projectOwnedChildOutcome({ ...snapshot, records: snapshot.records.slice(0, index + 1) }).status).toBe("pending")
})
test("actual next-attempt 2 capture remains pending rather than rejected or declared recovered", () => {
  const snapshot = fixture()
  const records = structuredClone(actualAttemptTwoRecords) as ObservationRecord[]
  const sessionID = records.find(record => record.kind === "host")! as Extract<ObservationRecord, { kind: "host" }>
  const result = projectOwnedChildOutcome({ ...snapshot, records,
    binding: { ...snapshot.binding, locator: { ...snapshot.binding.locator, sessionID: sessionID.event.sessionID as never } } })
  expect(result).toMatchObject({ status: "pending", observedSteps: 1 })
  expect(result).not.toHaveProperty("reason")
})
test("a later witnessed retry advances from attempt 2 to 3 without duplicating the assistant step", () => {
  const snapshot = retryFixture()
  const records = [...snapshot.records]
  const starts = events(snapshot).filter(record => record.event.type === "session.step.started")
  const second = starts[1]!
  const index = records.findIndex(record => record.id === second.id)
  const nextRetry = structuredClone(events(snapshot).find(record => record.event.type === "session.retry.scheduled")!)
  nextRetry.id = nextRetry.event.id = "retry-attempt-3"
  nextRetry.event.data.attempt = 3
  const restart = structuredClone(second)
  restart.id = restart.event.id = "step-attempt-3"
  records.splice(index + 1, 0, nextRetry, restart)
  expect(projectOwnedChildOutcome(revise({ ...snapshot, records }, () => true)))
    .toMatchObject({ status: "completed", text: "FINAL_RETRY_MARKER", observedSteps: 1, tokens: { input: 7, output: 3, reasoning: 0 } })
})
test("unwitnessed duplicate start, missing attempt, mismatched assistant or repeated attempt is uncertain", () => {
  for (const mutate of [
    (snapshot: ObservationSnapshot) => revise(snapshot, record => record.kind !== "host" || record.event.type !== "session.retry.scheduled"),
    (snapshot: ObservationSnapshot) => { events(snapshot).find(record => record.event.type === "session.retry.scheduled")!.event.data.attempt = undefined; return snapshot },
    (snapshot: ObservationSnapshot) => { events(snapshot).find(record => record.event.type === "session.retry.scheduled")!.event.data.assistantMessageID = "other-step"; return snapshot },
    (snapshot: ObservationSnapshot) => { events(snapshot).find(record => record.event.type === "session.retry.scheduled")!.event.data.attempt = 1; return snapshot },
    (snapshot: ObservationSnapshot) => { events(snapshot).find(record => record.event.type === "session.retry.scheduled")!.event.data.attempt = 3; return snapshot },
    (snapshot: ObservationSnapshot) => { events(snapshot).filter(record => record.event.type === "session.step.started")[1]!.event.data.assistantMessageID = "other-step"; return snapshot },
  ]) expect(projectOwnedChildOutcome(mutate(retryFixture())).status).toBe("uncertain")
})
test("an unmatched retry witness cannot be silently consumed by execution success or failure", () => {
  for (const terminalType of ["session.execution.succeeded", "session.execution.failed"]) {
    const snapshot = retryFixture()
    const retryIndex = snapshot.records.findIndex(record => record.kind === "host" && record.event.type === "session.retry.scheduled")
    const terminal = structuredClone(events(snapshot).at(-1)!)
    terminal.event.type = terminalType
    if (terminalType.endsWith("failed")) terminal.event.data.errorType = "provider.internal"
    const records = [...snapshot.records.slice(0, retryIndex + 1), terminal]
    expect(projectOwnedChildOutcome(revise({ ...snapshot, records }, () => true))).toMatchObject({ status: "uncertain", reason: "retry-not-restarted" })
  }
})
test("a witnessed retry discards failed-attempt partial text and records the new actual model", () => {
  const snapshot = retryFixture()
  const records = [...snapshot.records]
  const index = records.findIndex(record => record.kind === "host" && record.event.type === "session.retry.scheduled")
  const retry = records[index] as Extract<ObservationRecord, { kind: "host" }>
  const start = host("session.text.started", 0, { assistantMessageID: retry.event.data.assistantMessageID, ordinal: 0 }, retry.event.sessionID)
  const end = host("session.text.ended", 1, { assistantMessageID: retry.event.data.assistantMessageID, ordinal: 0, text: "discarded failed-attempt text" }, retry.event.sessionID)
  records.splice(index, 0, start, end)
  const modified = revise({ ...snapshot, records }, () => true)
  events(modified).filter(record => record.event.type === "session.step.started")[1]!.event.data.model = { providerID: "actual-retry", id: "observed" }
  expect(projectOwnedChildOutcome(modified)).toMatchObject({ status: "completed", text: "FINAL_RETRY_MARKER", observedSteps: 1, model: { providerID: "actual-retry", id: "observed" } })
})
test("a retry witness is single-use and cannot authorize a third start without a new schedule", () => {
  const snapshot = retryFixture()
  const records = [...snapshot.records]
  const index = records.findIndex((record, i) => record.kind === "host" && record.event.type === "session.step.started" && i > 8)
  const duplicate = structuredClone(records[index]!) as Extract<ObservationRecord, { kind: "host" }>
  duplicate.id = duplicate.event.id = "unwitnessed-third-start"
  records.splice(index + 1, 0, duplicate)
  expect(projectOwnedChildOutcome(revise({ ...snapshot, records }, () => true)).status).toBe("uncertain")
})
test("public ephemeral tool.progress is safe observation, not another tool attempt", () => {
  const snapshot = fixture("tool")
  const records = [...snapshot.records]
  const index = records.findIndex(record => record.kind === "host" && record.event.type === "session.tool.called")
  const call = records[index] as Extract<ObservationRecord, { kind: "host" }>
  const progress = host("session.tool.progress", 0, { assistantMessageID: call.event.data.assistantMessageID, callID: call.event.data.callID }, call.event.sessionID) as Extract<ObservationRecord, { kind: "host" }>
  progress.event.durable = undefined
  records.splice(index + 1, 0, progress)
  expect(projectOwnedChildOutcome({ ...snapshot, records })).toMatchObject({ status: "completed", observedToolCalls: 1 })
})
test("missing call or terminal, mismatched call/assistant and duplicate tool terminal are uncertain", () => {
  for (const mutate of [
    (snapshot: ObservationSnapshot) => revise(snapshot, record => record.kind !== "host" || record.event.type !== "session.tool.called"),
    (snapshot: ObservationSnapshot) => revise(snapshot, record => record.kind !== "host" || record.event.type !== "session.tool.failed"),
    (snapshot: ObservationSnapshot) => { events(snapshot).find(record => record.event.type === "session.tool.failed")!.event.data.callID = "unknown-call"; return snapshot },
    (snapshot: ObservationSnapshot) => { events(snapshot).find(record => record.event.type === "session.tool.failed")!.event.data.assistantMessageID = "unknown-assistant"; return snapshot },
    (snapshot: ObservationSnapshot) => {
      const records = [...snapshot.records]
      const index = records.findIndex(record => record.kind === "host" && record.event.type === "session.tool.failed")
      const duplicate = structuredClone(records[index]!) as Extract<ObservationRecord, { kind: "host" }>
      duplicate.id = duplicate.event.id = "duplicate-tool-terminal"
      records.splice(index + 1, 0, duplicate)
      return revise({ ...snapshot, records }, () => true)
    },
  ]) expect(projectOwnedChildOutcome(mutate(fixture("tool"))).status).toBe("uncertain")
})
test("tool progress must reference an active observed call in the same assistant step", () => {
  const snapshot = fixture("tool")
  const records = [...snapshot.records]
  const index = records.findIndex(record => record.kind === "host" && record.event.type === "session.tool.called")
  const call = records[index] as Extract<ObservationRecord, { kind: "host" }>
  const progress = host("session.tool.progress", 0, { assistantMessageID: call.event.data.assistantMessageID, callID: "unknown" }, call.event.sessionID) as Extract<ObservationRecord, { kind: "host" }>
  progress.event.durable = undefined
  records.splice(index + 1, 0, progress)
  expect(projectOwnedChildOutcome({ ...snapshot, records })).toMatchObject({ status: "uncertain", reason: "unmatched-tool-event" })
})

// Safe envelopes copied from the actual isolated 2.2.6 observations.json capture (2026-11-08).
// No ignored evidence file, provider, running host or credentials are needed to replay these tests.
const captured = {"success":[{"id":"evt_1b77e3608001b0Ntjzj8iiNrwp","type":"session.created","created":1794079864328,"sessionID":"ses_owned_probe_success","durable":{"aggregateID":"ses_owned_probe_success","seq":0,"version":1},"data":{"model":{"id":"gpt-qa","providerID":"qa-local"},"title":"Probe success"}},{"id":"evt_1b77e360c001UkKV7E6MNVA1XE","type":"session.inbox.enqueued","created":1794079864332,"sessionID":"ses_owned_probe_success","durable":{"aggregateID":"ses_owned_probe_success","seq":1,"version":1},"data":{"inboxID":"msg_1b77e360b001Lc4hC55p73PCtm","inputKind":"user"}},{"id":"evt_1b77e360d001rxwI81iHn0s9f9","type":"session.execution.started","created":1794079864333,"sessionID":"ses_owned_probe_success","durable":{"aggregateID":"ses_owned_probe_success","seq":2,"version":1},"data":{}},{"id":"evt_1b77e36190013c4vvZ0wTkLU4q","type":"session.instructions.updated","created":1794079864345,"sessionID":"ses_owned_probe_success","durable":{"aggregateID":"ses_owned_probe_success","seq":3,"version":2},"data":{}},{"id":"evt_1b77e361a001CKeZZ5pOYyB0Vo","type":"session.inbox.delivered","created":1794079864346,"sessionID":"ses_owned_probe_success","durable":{"aggregateID":"ses_owned_probe_success","seq":4,"version":1},"data":{"inboxID":"msg_1b77e360b001Lc4hC55p73PCtm"}},{"id":"evt_1b77e3647001QF5A1A6lGw6ghg","type":"session.step.started","created":1794079864391,"sessionID":"ses_owned_probe_success","durable":{"aggregateID":"ses_owned_probe_success","seq":5,"version":1},"data":{"assistantMessageID":"msg_1b77e361f001l8nkWrNWKB5SGQ","model":{"id":"gpt-qa","providerID":"qa-local","variant":"default"},"agent":"build"}},{"id":"evt_1b77e3649001zpHQ1OUBTsi7nt","type":"session.text.started","created":1794079864393,"sessionID":"ses_owned_probe_success","durable":{"aggregateID":"ses_owned_probe_success","seq":6,"version":1},"data":{"assistantMessageID":"msg_1b77e361f001l8nkWrNWKB5SGQ","ordinal":0}},{"id":"evt_1b77e364b002jg8HkE753IzTtw","type":"session.text.ended","created":1794079864395,"sessionID":"ses_owned_probe_success","durable":{"aggregateID":"ses_owned_probe_success","seq":7,"version":1},"data":{"assistantMessageID":"msg_1b77e361f001l8nkWrNWKB5SGQ","ordinal":0,"text":"FINAL_SUCCESS_MARKER"}},{"id":"evt_1b77e364c001MkYaIehvgxSfhj","type":"session.step.streamed","created":1794079864396,"sessionID":"ses_owned_probe_success","durable":{"aggregateID":"ses_owned_probe_success","seq":8,"version":1},"data":{"assistantMessageID":"msg_1b77e361f001l8nkWrNWKB5SGQ"}},{"id":"evt_1b77e364d001u0kQbVNs8aBwpR","type":"session.step.ended","created":1794079864397,"sessionID":"ses_owned_probe_success","durable":{"aggregateID":"ses_owned_probe_success","seq":9,"version":1},"data":{"assistantMessageID":"msg_1b77e361f001l8nkWrNWKB5SGQ","finish":"stop","cost":0,"tokens":{"input":7,"output":3,"reasoning":0}}},{"id":"evt_1b77e364f001nkQOSDa7kZEP14","type":"session.execution.succeeded","created":1794079864399,"sessionID":"ses_owned_probe_success","durable":{"aggregateID":"ses_owned_probe_success","seq":10,"version":1},"data":{}}],"empty":[{"id":"evt_1b77e36ed001238J717uZggg5x","type":"session.created","created":1794079864557,"sessionID":"ses_owned_probe_empty","durable":{"aggregateID":"ses_owned_probe_empty","seq":0,"version":1},"data":{"model":{"id":"gpt-qa","providerID":"qa-local"},"title":"Probe empty"}},{"id":"evt_1b77e36f0001v9Q488MLjo7Yuq","type":"session.inbox.enqueued","created":1794079864560,"sessionID":"ses_owned_probe_empty","durable":{"aggregateID":"ses_owned_probe_empty","seq":1,"version":1},"data":{"inboxID":"msg_1b77e36ef001yPmFDghZ9bYdM6","inputKind":"user"}},{"id":"evt_1b77e36f1001tPdTT8Qh8q0wnT","type":"session.execution.started","created":1794079864561,"sessionID":"ses_owned_probe_empty","durable":{"aggregateID":"ses_owned_probe_empty","seq":2,"version":1},"data":{}},{"id":"evt_1b77e36f3001rjx2k3PnJNOFJ7","type":"session.instructions.updated","created":1794079864563,"sessionID":"ses_owned_probe_empty","durable":{"aggregateID":"ses_owned_probe_empty","seq":3,"version":2},"data":{}},{"id":"evt_1b77e36f4001cdxbbGLhdyCRCI","type":"session.inbox.delivered","created":1794079864564,"sessionID":"ses_owned_probe_empty","durable":{"aggregateID":"ses_owned_probe_empty","seq":4,"version":1},"data":{"inboxID":"msg_1b77e36ef001yPmFDghZ9bYdM6"}},{"id":"evt_1b77e36fb001ipPKlyPG8PTUOE","type":"session.step.started","created":1794079864571,"sessionID":"ses_owned_probe_empty","durable":{"aggregateID":"ses_owned_probe_empty","seq":5,"version":1},"data":{"assistantMessageID":"msg_1b77e36f60014PiRrQzGW6I6bQ","model":{"id":"gpt-qa","providerID":"qa-local","variant":"default"},"agent":"build"}},{"id":"evt_1b77e36fd001RyoF9E5JTxKRf0","type":"session.step.streamed","created":1794079864573,"sessionID":"ses_owned_probe_empty","durable":{"aggregateID":"ses_owned_probe_empty","seq":6,"version":1},"data":{"assistantMessageID":"msg_1b77e36f60014PiRrQzGW6I6bQ"}},{"id":"evt_1b77e36fd002U0XgKizQBRnr08","type":"session.step.ended","created":1794079864573,"sessionID":"ses_owned_probe_empty","durable":{"aggregateID":"ses_owned_probe_empty","seq":7,"version":1},"data":{"assistantMessageID":"msg_1b77e36f60014PiRrQzGW6I6bQ","finish":"stop","cost":0,"tokens":{"input":7,"output":3,"reasoning":0}}},{"id":"evt_1b77e36ff001tiR9jgsqHhmlVn","type":"session.execution.succeeded","created":1794079864575,"sessionID":"ses_owned_probe_empty","durable":{"aggregateID":"ses_owned_probe_empty","seq":8,"version":1},"data":{}}],"error":[{"id":"evt_1b77e37ad001xFdyxmeyxJ1q1P","type":"session.created","created":1794079864749,"sessionID":"ses_owned_probe_error","durable":{"aggregateID":"ses_owned_probe_error","seq":0,"version":1},"data":{"model":{"id":"gpt-qa","providerID":"qa-local"},"title":"Probe error"}},{"id":"evt_1b77e37b0002QsvV5aYl0UTmCi","type":"session.inbox.enqueued","created":1794079864752,"sessionID":"ses_owned_probe_error","durable":{"aggregateID":"ses_owned_probe_error","seq":1,"version":1},"data":{"inboxID":"msg_1b77e37b0001PzLJ6KRQ1Mq1pp","inputKind":"user"}},{"id":"evt_1b77e37b1001ww4perU1m0hh0Z","type":"session.execution.started","created":1794079864753,"sessionID":"ses_owned_probe_error","durable":{"aggregateID":"ses_owned_probe_error","seq":2,"version":1},"data":{}},{"id":"evt_1b77e37b4001G2pfy1Xl98L6SS","type":"session.instructions.updated","created":1794079864756,"sessionID":"ses_owned_probe_error","durable":{"aggregateID":"ses_owned_probe_error","seq":3,"version":2},"data":{}},{"id":"evt_1b77e37b4002FO0AjuoA9Cyoyk","type":"session.inbox.delivered","created":1794079864756,"sessionID":"ses_owned_probe_error","durable":{"aggregateID":"ses_owned_probe_error","seq":4,"version":1},"data":{"inboxID":"msg_1b77e37b0001PzLJ6KRQ1Mq1pp"}},{"id":"evt_1b77e37bc001WUFr4mwI1dxqi9","type":"session.step.started","created":1794079864764,"sessionID":"ses_owned_probe_error","durable":{"aggregateID":"ses_owned_probe_error","seq":5,"version":1},"data":{"assistantMessageID":"msg_1b77e37b6001ATN72Rd5YnPBGa","model":{"id":"gpt-qa","providerID":"qa-local","variant":"default"},"agent":"build"}},{"id":"evt_1b77e37bd001ZEslvjVbO3XenW","type":"session.step.failed","created":1794079864765,"sessionID":"ses_owned_probe_error","durable":{"aggregateID":"ses_owned_probe_error","seq":6,"version":1},"data":{"assistantMessageID":"msg_1b77e37b6001ATN72Rd5YnPBGa","errorType":"provider.invalid-request"}},{"id":"evt_1b77e37bf001eipzSK9ude3s8n","type":"session.execution.failed","created":1794079864767,"sessionID":"ses_owned_probe_error","durable":{"aggregateID":"ses_owned_probe_error","seq":7,"version":1},"data":{"errorType":"provider.invalid-request"}}],"interrupt":[{"id":"evt_1b77e394c001n0nEF68r07DkZ3","type":"session.created","created":1794079865164,"sessionID":"ses_owned_probe_interrupt","durable":{"aggregateID":"ses_owned_probe_interrupt","seq":0,"version":1},"data":{"model":{"id":"gpt-qa","providerID":"qa-local"},"title":"Probe interrupt"}},{"id":"evt_1b77e394f0024717FA9Iju0IKO","type":"session.inbox.enqueued","created":1794079865167,"sessionID":"ses_owned_probe_interrupt","durable":{"aggregateID":"ses_owned_probe_interrupt","seq":1,"version":1},"data":{"inboxID":"msg_1b77e394f0013qsGT0QotqQY4r","inputKind":"user"}},{"id":"evt_1b77e3950001R6jC0Pv87gH1LD","type":"session.execution.started","created":1794079865168,"sessionID":"ses_owned_probe_interrupt","durable":{"aggregateID":"ses_owned_probe_interrupt","seq":2,"version":1},"data":{}},{"id":"evt_1b77e3952001090mGm1yAN7s4i","type":"session.instructions.updated","created":1794079865170,"sessionID":"ses_owned_probe_interrupt","durable":{"aggregateID":"ses_owned_probe_interrupt","seq":3,"version":2},"data":{}},{"id":"evt_1b77e3953001EKkaVVSewcckrH","type":"session.inbox.delivered","created":1794079865171,"sessionID":"ses_owned_probe_interrupt","durable":{"aggregateID":"ses_owned_probe_interrupt","seq":4,"version":1},"data":{"inboxID":"msg_1b77e394f0013qsGT0QotqQY4r"}},{"id":"evt_1b77e395a001o2leh1jgfJOje7","type":"session.step.started","created":1794079865178,"sessionID":"ses_owned_probe_interrupt","durable":{"aggregateID":"ses_owned_probe_interrupt","seq":5,"version":1},"data":{"assistantMessageID":"msg_1b77e3955001TChfxnTbiXy37N","model":{"id":"gpt-qa","providerID":"qa-local","variant":"default"},"agent":"build"}},{"id":"evt_1b77e395b001xvz8mjIDQWruuI","type":"session.text.started","created":1794079865179,"sessionID":"ses_owned_probe_interrupt","durable":{"aggregateID":"ses_owned_probe_interrupt","seq":6,"version":1},"data":{"assistantMessageID":"msg_1b77e3955001TChfxnTbiXy37N","ordinal":0}},{"id":"evt_1b77e395d002JTG2aHEbPLgNeG","type":"session.text.ended","created":1794079865181,"sessionID":"ses_owned_probe_interrupt","durable":{"aggregateID":"ses_owned_probe_interrupt","seq":7,"version":1},"data":{"assistantMessageID":"msg_1b77e3955001TChfxnTbiXy37N","ordinal":0,"text":"FINAL_INTERRUPT_MARKER"}},{"id":"evt_1b77e395e001uWnrRgp56fIIpd","type":"session.step.streamed","created":1794079865182,"sessionID":"ses_owned_probe_interrupt","durable":{"aggregateID":"ses_owned_probe_interrupt","seq":8,"version":1},"data":{"assistantMessageID":"msg_1b77e3955001TChfxnTbiXy37N"}},{"id":"evt_1b77e395f001xAJQ8XQa4wUY9J","type":"session.step.failed","created":1794079865183,"sessionID":"ses_owned_probe_interrupt","durable":{"aggregateID":"ses_owned_probe_interrupt","seq":9,"version":1},"data":{"assistantMessageID":"msg_1b77e3955001TChfxnTbiXy37N","errorType":"aborted"}},{"id":"evt_1b77e3960001RA6XTw6nHvprRg","type":"session.execution.interrupted","created":1794079865184,"sessionID":"ses_owned_probe_interrupt","durable":{"aggregateID":"ses_owned_probe_interrupt","seq":10,"version":1},"data":{}}],"tool":[{"id":"evt_1b77e3a16001t3aTxjmGsx7sIa","type":"session.created","created":1794079865366,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":0,"version":1},"data":{"model":{"id":"gpt-qa","providerID":"qa-local"},"title":"Probe tool"}},{"id":"evt_1b77e3a19001pjeU9qYJwEC45Z","type":"session.inbox.enqueued","created":1794079865369,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":1,"version":1},"data":{"inboxID":"msg_1b77e3a18001MDPF2hqToTcEEM","inputKind":"user"}},{"id":"evt_1b77e3a19002yHuhOuU3nGa9UX","type":"session.execution.started","created":1794079865369,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":2,"version":1},"data":{}},{"id":"evt_1b77e3a1c001U8K22RiShfszzr","type":"session.instructions.updated","created":1794079865372,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":3,"version":2},"data":{}},{"id":"evt_1b77e3a1c002nPUg2TnZd05OJT","type":"session.inbox.delivered","created":1794079865372,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":4,"version":1},"data":{"inboxID":"msg_1b77e3a18001MDPF2hqToTcEEM"}},{"id":"evt_1b77e3a23001b3LYjcKIyLckX0","type":"session.step.started","created":1794079865379,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":5,"version":1},"data":{"assistantMessageID":"msg_1b77e3a1e001fkNnt7uvSDLnZt","model":{"id":"gpt-qa","providerID":"qa-local","variant":"default"},"agent":"build"}},{"id":"evt_1b77e3a24001Z0ic73w2tvmCfV","type":"session.tool.input.started","created":1794079865380,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":6,"version":1},"data":{"assistantMessageID":"msg_1b77e3a1e001fkNnt7uvSDLnZt","callID":"call_observed_tool"}},{"id":"evt_1b77e3a26001iM7BOBV7LWt8I4","type":"session.tool.input.ended","created":1794079865382,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":7,"version":1},"data":{"assistantMessageID":"msg_1b77e3a1e001fkNnt7uvSDLnZt","callID":"call_observed_tool"}},{"id":"evt_1b77e3a27001vu6js7rn2WWL5U","type":"session.tool.called","created":1794079865383,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":8,"version":1},"data":{"assistantMessageID":"msg_1b77e3a1e001fkNnt7uvSDLnZt","callID":"call_observed_tool"}},{"id":"evt_1b77e3a27002b5WTq4XwntGXzA","type":"session.step.streamed","created":1794079865383,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":9,"version":1},"data":{"assistantMessageID":"msg_1b77e3a1e001fkNnt7uvSDLnZt"}},{"id":"evt_1b77e3a29001BNpflk1KhQc1JN","type":"session.tool.failed","created":1794079865385,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":10,"version":2},"data":{"assistantMessageID":"msg_1b77e3a1e001fkNnt7uvSDLnZt","errorType":"tool.execution","callID":"call_observed_tool"}},{"id":"evt_1b77e3a2a0019QG4AlMjUodKGk","type":"session.step.ended","created":1794079865386,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":11,"version":1},"data":{"assistantMessageID":"msg_1b77e3a1e001fkNnt7uvSDLnZt","finish":"tool-calls","cost":0,"tokens":{"input":0,"output":0,"reasoning":0}}},{"id":"evt_1b77e3a32001OWLSCjtGvhTJPZ","type":"session.step.started","created":1794079865394,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":12,"version":1},"data":{"assistantMessageID":"msg_1b77e3a2d001DV6XXJEZqoCObE","model":{"id":"gpt-qa","providerID":"qa-local","variant":"default"},"agent":"build"}},{"id":"evt_1b77e3a340015LXb4KGtidkdDy","type":"session.text.started","created":1794079865396,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":13,"version":1},"data":{"assistantMessageID":"msg_1b77e3a2d001DV6XXJEZqoCObE","ordinal":0}},{"id":"evt_1b77e3a35002Cv8jzBDW74EEmd","type":"session.text.ended","created":1794079865397,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":14,"version":1},"data":{"assistantMessageID":"msg_1b77e3a2d001DV6XXJEZqoCObE","ordinal":0,"text":"FINAL_TOOL_MARKER"}},{"id":"evt_1b77e3a36001RGsd71r2DAmNEt","type":"session.step.streamed","created":1794079865398,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":15,"version":1},"data":{"assistantMessageID":"msg_1b77e3a2d001DV6XXJEZqoCObE"}},{"id":"evt_1b77e3a36002jJMD16PITttnpk","type":"session.step.ended","created":1794079865398,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":16,"version":1},"data":{"assistantMessageID":"msg_1b77e3a2d001DV6XXJEZqoCObE","finish":"stop","cost":0,"tokens":{"input":7,"output":3,"reasoning":0}}},{"id":"evt_1b77e3a3800153KdT99zpOmQVm","type":"session.execution.succeeded","created":1794079865400,"sessionID":"ses_owned_probe_tool","durable":{"aggregateID":"ses_owned_probe_tool","seq":17,"version":1},"data":{}}],"continuation":[{"id":"evt_1b77e3adf001w32e3rcAXx3n6D","type":"session.created","created":1794079865567,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":0,"version":1},"data":{"model":{"id":"gpt-qa","providerID":"qa-local"},"title":"Probe continuation"}},{"id":"evt_1b77e3ae2002LJsSY6h48QaWFM","type":"session.inbox.enqueued","created":1794079865570,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":1,"version":1},"data":{"inboxID":"msg_1b77e3ae20015yP1I3thDq82sJ","inputKind":"user"}},{"id":"evt_1b77e3ae3001K5wb6L3IFH5gWt","type":"session.execution.started","created":1794079865571,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":2,"version":1},"data":{}},{"id":"evt_1b77e3ae5001X2KJqGSRt8vmRt","type":"session.instructions.updated","created":1794079865573,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":3,"version":2},"data":{}},{"id":"evt_1b77e3ae6001cdAPlldIRhPuNx","type":"session.inbox.delivered","created":1794079865574,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":4,"version":1},"data":{"inboxID":"msg_1b77e3ae20015yP1I3thDq82sJ"}},{"id":"evt_1b77e3aef001Glf0IlmQBI0nM7","type":"session.step.started","created":1794079865583,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":5,"version":1},"data":{"assistantMessageID":"msg_1b77e3ae80019kkWhA8g9PKygj","model":{"id":"gpt-qa","providerID":"qa-local","variant":"default"},"agent":"build"}},{"id":"evt_1b77e3af0001HJvL3kUh4sX2WX","type":"session.text.started","created":1794079865584,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":6,"version":1},"data":{"assistantMessageID":"msg_1b77e3ae80019kkWhA8g9PKygj","ordinal":0}},{"id":"evt_1b77e3af10023FV2pyDpGc4eW3","type":"session.text.ended","created":1794079865585,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":7,"version":1},"data":{"assistantMessageID":"msg_1b77e3ae80019kkWhA8g9PKygj","ordinal":0,"text":"FINAL_CONTINUATION_MARKER"}},{"id":"evt_1b77e3af2001hDbiPSMo7RPm70","type":"session.step.streamed","created":1794079865586,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":8,"version":1},"data":{"assistantMessageID":"msg_1b77e3ae80019kkWhA8g9PKygj"}},{"id":"evt_1b77e3af3001szlxYKtan2pwtW","type":"session.step.ended","created":1794079865587,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":9,"version":1},"data":{"assistantMessageID":"msg_1b77e3ae80019kkWhA8g9PKygj","finish":"stop","cost":0,"tokens":{"input":7,"output":3,"reasoning":0}}},{"id":"evt_1b77e3af4002L0V3tGCU07Idx8","type":"session.inbox.enqueued","created":1794079865588,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":10,"version":1},"data":{"inboxID":"msg_1b77e3af40015Ge5gS8y1stGG9","inputKind":"synthetic"}},{"id":"evt_1b77e3af6001pNIEPO0m4ZRYvV","type":"session.inbox.delivered","created":1794079865590,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":11,"version":1},"data":{"inboxID":"msg_1b77e3af40015Ge5gS8y1stGG9"}},{"id":"evt_1b77e3afd001U8Nq3ROt3ZXREI","type":"session.step.started","created":1794079865597,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":12,"version":1},"data":{"assistantMessageID":"msg_1b77e3af9001A99nDFjN90rAKd","model":{"id":"gpt-qa","providerID":"qa-local","variant":"default"},"agent":"build"}},{"id":"evt_1b77e3afe001vNbNIjPVdjDY6J","type":"session.text.started","created":1794079865599,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":13,"version":1},"data":{"assistantMessageID":"msg_1b77e3af9001A99nDFjN90rAKd","ordinal":0}},{"id":"evt_1b77e3b00002ZA6W0mC3ya17Og","type":"session.text.ended","created":1794079865600,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":14,"version":1},"data":{"assistantMessageID":"msg_1b77e3af9001A99nDFjN90rAKd","ordinal":0,"text":"CONTINUED_FINAL_MARKER"}},{"id":"evt_1b77e3b01001nZNfjvBdeCVlgd","type":"session.step.streamed","created":1794079865601,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":15,"version":1},"data":{"assistantMessageID":"msg_1b77e3af9001A99nDFjN90rAKd"}},{"id":"evt_1b77e3b01002syxyuW4GEWWX2N","type":"session.step.ended","created":1794079865601,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":16,"version":1},"data":{"assistantMessageID":"msg_1b77e3af9001A99nDFjN90rAKd","finish":"stop","cost":0,"tokens":{"input":7,"output":3,"reasoning":0}}},{"id":"evt_1b77e3b03001xO1InKoaaZ9VaW","type":"session.execution.succeeded","created":1794079865603,"sessionID":"ses_owned_probe_continuation","durable":{"aggregateID":"ses_owned_probe_continuation","seq":17,"version":1},"data":{}}]}

// Actual integrated retry sequence; the original safe capture predates attempt-field retention.
const actualRetryRecords = [{"kind":"host","id":"evt_1b78b8c7a001NYCnc4h1GMya6f","event":{"id":"evt_1b78b8c7a001NYCnc4h1GMya6f","type":"session.renamed","created":1794080738426,"sessionID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","durable":{"aggregateID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","seq":1,"version":1},"data":{"title":"Actual task retry"}}},{"kind":"input","id":"input:msg_own_8f66103d342d4d5984e89c4aefea1ae7","inboxID":"msg_own_8f66103d342d4d5984e89c4aefea1ae7"},{"kind":"host","id":"evt_1b78b8c7f001dlrJLCFFwaVPYx","event":{"id":"evt_1b78b8c7f001dlrJLCFFwaVPYx","type":"session.inbox.enqueued","created":1794080738431,"sessionID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","durable":{"aggregateID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","seq":2,"version":1},"data":{"inboxID":"msg_own_8f66103d342d4d5984e89c4aefea1ae7","inputKind":"user"}}},{"kind":"host","id":"evt_1b78b8c81001jaTnp7SQBYpi5g","event":{"id":"evt_1b78b8c81001jaTnp7SQBYpi5g","type":"session.execution.started","created":1794080738433,"sessionID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","durable":{"aggregateID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","seq":3,"version":1},"data":{}}},{"kind":"primary","id":"c441f59d-a79a-4a13-8da0-42fd2f202f88","model":{"providerID":"qa-local","id":"gpt-qa","variant":"default"}},{"kind":"host","id":"evt_1b78b8c84001arpLQv9SGLLH4Y","event":{"id":"evt_1b78b8c84001arpLQv9SGLLH4Y","type":"session.instructions.updated","created":1794080738436,"sessionID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","durable":{"aggregateID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","seq":4,"version":2},"data":{}}},{"kind":"host","id":"evt_1b78b8c85001iAEuwwSoYcHBOT","event":{"id":"evt_1b78b8c85001iAEuwwSoYcHBOT","type":"session.inbox.delivered","created":1794080738437,"sessionID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","durable":{"aggregateID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","seq":5,"version":1},"data":{"inboxID":"msg_own_8f66103d342d4d5984e89c4aefea1ae7"}}},{"kind":"host","id":"evt_1b78b8c8e001sDvwoZDmVTdROS","event":{"id":"evt_1b78b8c8e001sDvwoZDmVTdROS","type":"session.step.started","created":1794080738446,"sessionID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","durable":{"aggregateID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","seq":6,"version":1},"data":{"assistantMessageID":"msg_1b78b8c870016nZqys37n3WhfN","model":{"providerID":"qa-local","id":"gpt-qa","variant":"default"},"agent":"build"}}},{"kind":"host","id":"evt_1b78b8c8f001t9UyrcHbllY1fG","event":{"id":"evt_1b78b8c8f001t9UyrcHbllY1fG","type":"session.retry.scheduled","created":1794080738447,"sessionID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","durable":{"aggregateID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","seq":7,"version":1},"data":{"assistantMessageID":"msg_1b78b8c870016nZqys37n3WhfN","errorType":"provider.internal"}}},{"kind":"primary","id":"265ea86f-a964-4f3f-b435-6bbce0892b14","model":{"providerID":"qa-local","id":"gpt-qa","variant":"default"}},{"kind":"host","id":"evt_1b78b9539001DLVK17RXH55Io5","event":{"id":"evt_1b78b9539001DLVK17RXH55Io5","type":"session.step.started","created":1794080740665,"sessionID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","durable":{"aggregateID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","seq":8,"version":1},"data":{"assistantMessageID":"msg_1b78b8c870016nZqys37n3WhfN","model":{"providerID":"qa-local","id":"gpt-qa","variant":"default"},"agent":"build"}}},{"kind":"host","id":"evt_1b78b953a001dnDnFwSbuPR94s","event":{"id":"evt_1b78b953a001dnDnFwSbuPR94s","type":"session.text.started","created":1794080740666,"sessionID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","durable":{"aggregateID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","seq":9,"version":1},"data":{"assistantMessageID":"msg_1b78b8c870016nZqys37n3WhfN","ordinal":0}}},{"kind":"host","id":"evt_1b78b953b002zFM8jP28POCq0B","event":{"id":"evt_1b78b953b002zFM8jP28POCq0B","type":"session.text.ended","created":1794080740667,"sessionID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","durable":{"aggregateID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","seq":10,"version":1},"data":{"assistantMessageID":"msg_1b78b8c870016nZqys37n3WhfN","ordinal":0,"text":"FINAL_RETRY_MARKER"}}},{"kind":"host","id":"evt_1b78b953c001zQ9dtJvgLPrCn8","event":{"id":"evt_1b78b953c001zQ9dtJvgLPrCn8","type":"session.step.streamed","created":1794080740668,"sessionID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","durable":{"aggregateID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","seq":11,"version":1},"data":{"assistantMessageID":"msg_1b78b8c870016nZqys37n3WhfN"}}},{"kind":"host","id":"evt_1b78b953d001uekgaD4Lod9Fkx","event":{"id":"evt_1b78b953d001uekgaD4Lod9Fkx","type":"session.step.ended","created":1794080740669,"sessionID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","durable":{"aggregateID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","seq":12,"version":1},"data":{"assistantMessageID":"msg_1b78b8c870016nZqys37n3WhfN","finish":"stop","tokens":{"input":7,"output":3,"reasoning":0},"cost":0}}},{"kind":"host","id":"evt_1b78b953e001pr2KhUVWgr95b4","event":{"id":"evt_1b78b953e001pr2KhUVWgr95b4","type":"session.usage.updated","created":1794080740670,"sessionID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","data":{"tokens":{"input":7,"output":3,"reasoning":0},"cost":0}}},{"kind":"host","id":"evt_1b78b9540001kIr2c1RIhA4Aa9","event":{"id":"evt_1b78b9540001kIr2c1RIhA4Aa9","type":"session.execution.succeeded","created":1794080740672,"sessionID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","durable":{"aggregateID":"ses_owned_318ff658bc20499d9a06028ebaf2cf4e","seq":13,"version":1},"data":{}}}]

// Second actual integrated RED capture retained next-attempt metadata: first retry is attempt 2.
const actualAttemptTwoRecords = [{"kind":"host","id":"evt_1b790090d001nzNlFaOFhqaqCk","event":{"id":"evt_1b790090d001nzNlFaOFhqaqCk","type":"session.renamed","created":1794081032461,"sessionID":"ses_owned_f2e8a49d56704a8aa6e1d17559153134","durable":{"aggregateID":"ses_owned_f2e8a49d56704a8aa6e1d17559153134","seq":1,"version":1},"data":{"title":"Actual task retry"}}},{"kind":"input","id":"input:msg_own_36722d8351bd4c98b4a9dcae22d5dae7","inboxID":"msg_own_36722d8351bd4c98b4a9dcae22d5dae7"},{"kind":"host","id":"evt_1b7900929001A8irFcEksBCpNN","event":{"id":"evt_1b7900929001A8irFcEksBCpNN","type":"session.inbox.enqueued","created":1794081032489,"sessionID":"ses_owned_f2e8a49d56704a8aa6e1d17559153134","durable":{"aggregateID":"ses_owned_f2e8a49d56704a8aa6e1d17559153134","seq":2,"version":1},"data":{"inboxID":"msg_own_36722d8351bd4c98b4a9dcae22d5dae7","inputKind":"user"}}},{"kind":"host","id":"evt_1b790092b001Udt2WQ22S1wjGh","event":{"id":"evt_1b790092b001Udt2WQ22S1wjGh","type":"session.execution.started","created":1794081032491,"sessionID":"ses_owned_f2e8a49d56704a8aa6e1d17559153134","durable":{"aggregateID":"ses_owned_f2e8a49d56704a8aa6e1d17559153134","seq":3,"version":1},"data":{}}},{"kind":"primary","id":"c63d3a92-ff90-4d7c-806f-1745cc232909","model":{"providerID":"qa-local","id":"gpt-qa","variant":"default"}},{"kind":"host","id":"evt_1b790092e001Rdp0dbbQItGisY","event":{"id":"evt_1b790092e001Rdp0dbbQItGisY","type":"session.instructions.updated","created":1794081032494,"sessionID":"ses_owned_f2e8a49d56704a8aa6e1d17559153134","durable":{"aggregateID":"ses_owned_f2e8a49d56704a8aa6e1d17559153134","seq":4,"version":2},"data":{}}},{"kind":"host","id":"evt_1b790092e002d4tEHNSZ78acgF","event":{"id":"evt_1b790092e002d4tEHNSZ78acgF","type":"session.inbox.delivered","created":1794081032494,"sessionID":"ses_owned_f2e8a49d56704a8aa6e1d17559153134","durable":{"aggregateID":"ses_owned_f2e8a49d56704a8aa6e1d17559153134","seq":5,"version":1},"data":{"inboxID":"msg_own_36722d8351bd4c98b4a9dcae22d5dae7"}}},{"kind":"host","id":"evt_1b79009380013WbUOWMMYb1Hxr","event":{"id":"evt_1b79009380013WbUOWMMYb1Hxr","type":"session.step.started","created":1794081032504,"sessionID":"ses_owned_f2e8a49d56704a8aa6e1d17559153134","durable":{"aggregateID":"ses_owned_f2e8a49d56704a8aa6e1d17559153134","seq":6,"version":1},"data":{"assistantMessageID":"msg_1b79009310010sP8z9E9HRPuFb","model":{"providerID":"qa-local","id":"gpt-qa","variant":"default"},"agent":"build"}}},{"kind":"host","id":"evt_1b7900939001l6bW7fGzBVk1j8","event":{"id":"evt_1b7900939001l6bW7fGzBVk1j8","type":"session.retry.scheduled","created":1794081032505,"sessionID":"ses_owned_f2e8a49d56704a8aa6e1d17559153134","durable":{"aggregateID":"ses_owned_f2e8a49d56704a8aa6e1d17559153134","seq":7,"version":1},"data":{"assistantMessageID":"msg_1b79009310010sP8z9E9HRPuFb","errorType":"provider.internal","attempt":2}}}]
