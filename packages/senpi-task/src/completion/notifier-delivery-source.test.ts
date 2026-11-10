import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createTaskRecord } from "../state/record"
import { createTaskRecordStore } from "../store/record-store"
import { taskEventLogPath } from "../store/event-log"
import { createCompletionNotifier } from "./notifier"
import { buildCompletionMessage } from "./notification"

describe("optional completion source custody (actual FileStore)", () => {
  test("queued return is pending, unpersisted and duplicate/reconcile do not redispatch", () => {
    const root = mkdtempSync(join(import.meta.dir, "source-unit-"))
    const store = createTaskRecordStore({ project_dir: root })
    try {
      const record = { ...createTaskRecord({ parent_session_id: "parent", root_session_id: "parent", depth: 0,
        execution_mode: "in-process", model: "unit/model", notify_on_terminal: true, task_seq: 0 }),
        status: "completed" as const, final_response: "done" }
      store.save(record)
      let calls = 0
      const host = { enqueue() { calls++ }, enqueueWithSource() { calls++ } }
      const notifier = createCompletionNotifier({ store, notifier: host, schedule: () => () => {} })
      const input = { record, parentState: { kind: "idle" as const }, runInBackground: true }
      expect(notifier.notifyTerminal(input)).toEqual({ kind: "pending", decision: "wake" })
      expect(present(store.load(record.task_id)).notification.notified_epoch).toBe(-1)
      expect(notifier.notifyTerminal(input)).toEqual({ kind: "pending", decision: "wake" })
      notifier.reconcileUnnotifiedNotifications({ sessionId: "parent", parentState: { kind: "idle" } })
      expect(calls).toBe(1)
    } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
  })
})

import type { TaskRecord } from "../state"
import type { CompletionDeliverySource, CompletionNotifierStore, ParentNotifierMessage } from "./types"

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected value to be present")
  return value
}

type SourceCall = { message: ParentNotifierMessage; sources: readonly CompletionDeliverySource[] }
function withFileStore(run: (h: ReturnType<typeof setup>) => void): void {
  const h = setup()
  try { run(h) } finally { h.store.close(); rmSync(h.root, { recursive: true, force: true }) }
}
function setup() {
  const root = mkdtempSync(join(import.meta.dir, "source-unit-"))
  const store = createTaskRecordStore({ project_dir: root })
  const calls: SourceCall[] = [], timers: { run: () => void; cancelled: boolean }[] = []
  let host: ((call: SourceCall) => void) | undefined
  let scheduling: (() => void) | undefined, cancelling: (() => void) | undefined
  let mutate: CompletionNotifierStore["mutate"] = store.mutate
  let load: CompletionNotifierStore["load"] = store.load
  let append: CompletionNotifierStore["appendEvent"] = store.appendEvent
  const observed: CompletionNotifierStore = { ...store, load: id => load(id),
    mutate: (id, fn) => mutate(id, fn), appendEvent: (id, event) => append(id, event) }
  const notifier = createCompletionNotifier({ store: observed, notifier: {
    enqueue() { throw new Error("optional host must not enter legacy enqueue") },
    enqueueWithSource(message, sources) { const call = { message, sources }; calls.push(call); host?.(call) },
  }, schedule(run) { const timer = { run, cancelled: false }; timers.push(timer); scheduling?.(); return () => { timer.cancelled = true; cancelling?.() } },
    getCurrentSessionId: () => "parent", getParentState: () => ({ kind: "idle" }) })
  function record(seq = 0): TaskRecord {
    const r: TaskRecord = { ...createTaskRecord({ parent_session_id: "parent", root_session_id: "parent", depth: 0,
      execution_mode: "in-process", model: "unit/model", notify_on_terminal: true, task_seq: seq }),
      status: "completed", final_response: `done${seq}` }
    store.save(r); return r
  }
  const notify = (r: TaskRecord, state: "idle" | "streaming" | "compacting" = "idle") =>
    notifier.notifyTerminal({ record: r, parentState: { kind: state }, runInBackground: true })
  return { root, store, notifier, calls, timers, record, notify,
    host: (fn: typeof host) => { host = fn }, mutate: (fn: typeof mutate) => { mutate = fn },
    load: (fn: typeof load) => { load = fn },
    scheduling: (fn: typeof scheduling) => { scheduling = fn }, cancelling: (fn: typeof cancelling) => { cancelling = fn },
    append: (fn: typeof append) => { append = fn } }
}

describe("deferred source lifecycle", () => {
  test("accepted only commits once; contradictory and duplicate callbacks are inert", () => withFileStore(h => {
    const r = h.record(); h.notify(r)
    const s = present(present(h.calls[0]).sources[0])
    expect(Object.isFrozen(s)).toBe(true)
    expect([s.taskId, s.runEpoch, s.parentSessionId]).toEqual([r.task_id, 0, "parent"])
    s.accepted(); s.notDelivered(Error("contradictory")); s.accepted()
    expect(present(h.store.load(r.task_id)).notification.notified_epoch).toBe(0)
    expect(h.timers).toHaveLength(0)
    expect(h.notify(r)).toEqual({ kind: "skipped", reason: "already-notified" })
  }))
  test("reentrant accepted is latched until host returns; original message and receiver", () => withFileStore(h => {
    const r = h.record()
    h.host(call => { present(call.sources[0]).accepted(); expect(present(h.store.load(r.task_id)).notification.notified_epoch).toBe(-1) })
    expect(h.notify(r)).toEqual({ kind: "delivered", decision: "wake" })
    expect(present(h.store.load(r.task_id)).notification.notified_epoch).toBe(0)
  }))
  test("reentrant failure is latched and falsey original errors remain failures", () => withFileStore(h => {
    const r = h.record(); h.host(call => present(call.sources[0]).notDelivered(undefined))
    expect(h.notify(r)).toEqual({ kind: "failed" })
    expect(present(h.store.load(r.task_id)).notification.notified_epoch).toBe(-1)
    expect(present(h.store.load(r.task_id)).notification.notification_failed_epoch).toBe(0)
    expect(h.timers).toHaveLength(1)
  }))
  test("physical accepted CAS write then throw retains pending ahead of notified skip", () => withFileStore(h => {
    const r = h.record(); h.notify(r); const s = present(present(h.calls[0]).sources[0])
    let once = true
    h.mutate((id, fn) => { const result = h.store.mutate(id, fn); if (once) { once = false; throw Error("after actual write") }; return result })
    expect(() => s.accepted()).toThrow("after actual write")
    expect(present(h.store.load(r.task_id)).notification.notified_epoch).toBe(0)
    expect(h.notify(r)).toEqual({ kind: "pending", decision: "wake" })
    h.notifier.reconcileUnnotifiedNotifications({ sessionId: "parent", parentState: { kind: "idle" } })
    s.notDelivered(Error("cannot undo known acceptance")); s.accepted()
    expect(h.calls).toHaveLength(1)
    expect(h.notify(r).kind).toBe("skipped")
  }))
  test("accepted CAS before-write failure propagates, then retries only bookkeeping", () => withFileStore(h => {
    const r = h.record(); h.notify(r); const s = present(present(h.calls[0]).sources[0])
    h.mutate(() => { throw Error("commit blocked") })
    expect(() => s.accepted()).toThrow("commit blocked")
    s.notDelivered(Error("contradiction"))
    h.mutate(h.store.mutate); s.accepted()
    expect(h.calls).toHaveLength(1); expect(present(h.store.load(r.task_id)).notification.notified_epoch).toBe(0)
  }))
  for (const change of ["epoch", "parent", "running", "notifying"] as const) test(`atomic ${change} fence inside actual mutate`, () => withFileStore(h => {
    const r = h.record(); h.notify(r); const s = present(present(h.calls[0]).sources[0])
    h.mutate((id, fn) => {
      h.store.mutate(id, current => change === "epoch" ? { ...current, notification: { ...current.notification, run_epoch: 1 } }
        : change === "parent" ? { ...current, parent_session_id: "other" }
        : change === "running" ? { ...current, status: "running" } : { ...current, status: "cancelled" })
      return h.store.mutate(id, fn)
    })
    s.accepted()
    expect(present(h.store.load(r.task_id)).notification.notified_epoch).toBe(-1)
    expect(h.calls).toHaveLength(1)
  }))
  test("delayed old epoch and same-epoch superseded failure cannot mutate accepted run", () => withFileStore(h => {
    const r = h.record(); h.notify(r); const old = present(present(h.calls[0]).sources[0])
    old.notDelivered(Error("definite")); present(h.timers[0]).run()
    const next = present(present(h.calls[1]).sources[0]); next.accepted(); old.notDelivered(Error("late")); old.accepted()
    expect(present(h.store.load(r.task_id)).notification.notified_epoch).toBe(0)
    h.store.mutate(r.task_id, x => ({ ...x, notification: { ...x.notification, run_epoch: 1, notified_epoch: 0 } }))
    h.notify(present(h.store.load(r.task_id))); const newer = present(present(h.calls[2]).sources[0]); newer.accepted(); next.notDelivered(Error("old epoch"))
    expect(present(h.store.load(r.task_id)).notification.notified_epoch).toBe(1)
    expect(h.calls).toHaveLength(3)
  }))
  test("failure audit fault retains mutationDone; retry never mutates new epoch", () => withFileStore(h => {
    const r = h.record(); h.notify(r); const s = present(present(h.calls[0]).sources[0])
    h.append(() => { throw Error("audit blocked") })
    expect(() => s.notDelivered("original")).toThrow("audit blocked")
    expect(h.notify(r).kind).toBe("pending")
    h.store.mutate(r.task_id, x => ({ ...x, notification: { run_epoch: 1, notified_epoch: 1 } }))
    let writes = 0; h.mutate((id, fn) => h.store.mutate(id, current => { const next = fn(current); if (next !== current) writes++; return next }))
    let event: unknown
    h.append((id, value) => { event = value.payload; return h.store.appendEvent(id, value) })
    s.notDelivered("replacement must not replace original")
    expect(event).toMatchObject({ epoch: 0, parent_session_id: "parent", error: "original" })
    expect(writes).toBe(0); expect(h.timers).toHaveLength(0)
    expect(present(h.store.load(r.task_id)).notification).toEqual({ run_epoch: 1, notified_epoch: 1 })
  }))
  test("unfinished audit across removal is retained and never recreates log", () => withFileStore(h => {
    const r = h.record(); h.notify(r); const s = present(present(h.calls[0]).sources[0])
    h.append(() => { throw Error("audit blocked") }); expect(() => s.notDelivered(null)).toThrow()
    h.store.remove(r.task_id); let appends = 0
    h.append((id, event) => { appends++; return h.store.appendEvent(id, event) })
    expect(() => s.notDelivered(null)).toThrow("audit remains pending")
    expect(appends).toBe(0); expect(h.store.load(r.task_id)).toBeNull(); expect(h.timers).toHaveLength(0)
    expect(h.notify(r).kind).toBe("pending")
  }))
  test("failure bookkeeping retry preserves original error and schedules only after audit", () => withFileStore(h => {
    const r = h.record(); h.notify(r); const s = present(present(h.calls[0]).sources[0])
    h.append(() => { throw Error("audit fault") }); expect(() => s.notDelivered("original")).toThrow()
    expect(h.timers).toHaveLength(0)
    let error: unknown
    h.append((id, event) => { if (typeof event.payload === "object" && event.payload !== null && "error" in event.payload) error = event.payload.error; return h.store.appendEvent(id, event) })
    s.notDelivered("different"); expect(error).toBe("original"); expect(h.timers).toHaveLength(1)
    expect(h.calls).toHaveLength(1)
  }))
  test("missing actual source fails with zero host; removed receipt settles stale", () => withFileStore(h => {
    const r = h.record(); h.store.remove(r.task_id); expect(h.notify(r)).toEqual({ kind: "failed" }); expect(h.calls).toHaveLength(0)
    h.store.save(r); h.notify(r); h.store.remove(r.task_id); present(present(h.calls[0]).sources[0]).accepted()
    expect(h.store.load(r.task_id)).toBeNull(); expect(h.timers).toHaveLength(0)
  }))
  test("buffer transfer excludes stale entries, latches reentrant reconcile and counts actual handoff", () => withFileStore(h => {
    const a = h.record(1), b = h.record(2)
    h.notify(a, "compacting"); h.notify(a, "compacting"); h.notify(b, "compacting")
    expect(h.notifier.bufferedCount("parent")).toBe(2)
    h.store.remove(a.task_id)
    h.host(() => h.notifier.reconcileUnnotifiedNotifications({ sessionId: "parent", parentState: { kind: "idle" } }))
    expect(h.notifier.flushBuffered({ sessionId: "parent", replaced: false })).toEqual({ kind: "pending", count: 1 })
    expect(h.calls).toHaveLength(1); expect(present(h.calls[0]).sources.map(s => s.taskId)).toEqual([b.task_id])
    expect(present(h.calls[0]).message.details.map(d => d.task_id)).toEqual([b.task_id])
    present(present(h.calls[0]).sources[0]).accepted()
  }))
  test("all stale buffer flush returns empty; replacement drop never dispatches", () => withFileStore(h => {
    const a = h.record(1); h.notify(a, "compacting"); h.store.remove(a.task_id)
    expect(h.notifier.flushBuffered({ sessionId: "parent", replaced: false })).toEqual({ kind: "empty" })
    const b = h.record(2); h.notify(b, "compacting")
    expect(h.notifier.flushBuffered({ sessionId: "parent", replaced: true })).toEqual({ kind: "dropped", count: 1 })
    expect(h.calls).toHaveLength(0)
  }))
  test("partial batch accepted retains remaining pending; both reentrant accepted returns flushed", () => withFileStore(h => {
    const a = h.record(1), b = h.record(2); h.notify(a, "compacting"); h.notify(b, "compacting")
    h.host(call => present(call.sources[0]).accepted())
    expect(h.notifier.flushBuffered({ sessionId: "parent", replaced: false })).toEqual({ kind: "pending", count: 2 })
    expect(present(h.store.load(a.task_id)).notification.notified_epoch).toBe(0)
    expect(present(h.store.load(b.task_id)).notification.notified_epoch).toBe(-1)
    present(present(h.calls[0]).sources[1]).accepted()
    const c = h.record(3); h.notify(c, "compacting"); h.host(call => call.sources.forEach(s => s.accepted()))
    expect(h.notifier.flushBuffered({ sessionId: "parent", replaced: false })).toEqual({ kind: "flushed", count: 1 })
  }))
  test("two immediate preadmission throws preserve message/receiver and falsey failure", () => withFileStore(h => {
    const r = h.record(); h.host(() => { throw undefined })
    expect(h.notify(r)).toEqual({ kind: "failed" }); expect(h.calls).toHaveLength(2)
    expect(present(h.calls[0]).message).toBe(present(h.calls[1]).message)
    expect(present(h.calls[0]).sources[0]).not.toBe(present(h.calls[1]).sources[0])
    expect(h.timers).toHaveLength(1)
  }))
  test("accepted then host throw never triggers immediate resend", () => withFileStore(h => {
    const r = h.record(); h.host(call => { present(call.sources[0]).accepted(); throw Error("illegal host throw") })
    expect(() => h.notify(r)).toThrow("illegal host throw"); expect(h.calls).toHaveLength(1)
    expect(present(h.store.load(r.task_id)).notification.notified_epoch).toBe(0)
  }))
  test("queued custody retains retry counts; uncertain callbacks do not dispatch", () => withFileStore(h => {
    const r = h.record(); h.notify(r)
    h.notifier.reconcileUnnotifiedNotifications({ sessionId: "parent", parentState: { kind: "idle" } })
    expect(h.calls).toHaveLength(1); expect(h.timers).toHaveLength(0)
    for (let i = 0; i < 9; i++) {
      present(present(h.calls.at(-1)).sources[0]).notDelivered(`failure${i}`)
      if (i < 8) present(h.timers[i]).run()
    }
    expect(h.calls).toHaveLength(9); expect(h.timers).toHaveLength(8)
  }))
  test("reconcile sources are canonical and duplicate pending is suppressed", () => withFileStore(h => {
    const r = h.record(); h.notifier.reconcileUnnotifiedNotifications({ sessionId: "parent", parentState: { kind: "streaming" } })
    expect(present(present(h.calls[0]).sources[0]).runEpoch).toBe(r.notification.run_epoch)
    expect(h.notify(r)).toEqual({ kind: "pending", decision: "deliver_streaming" })
  }))
})

test("optional task-ID-only failure rejects without any store or transport side effect", () => withFileStore(h => {
  const r = h.record(); h.notify(r)
  let mutations = 0, events = 0
  h.mutate((id, fn) => { mutations++; return h.store.mutate(id, fn) })
  h.append((id, event) => { events++; return h.store.appendEvent(id, event) })
  expect(() => h.notifier.recordDeliveryFailure({ taskIds: [r.task_id], error: "no provenance" })).toThrow("issued source receipt")
  expect([mutations, events, h.timers.length, h.calls.length]).toEqual([0, 0, 0, 1])
  expect(present(h.store.load(r.task_id)).notification.notified_epoch).toBe(-1)
}))
test("audit refuses detectable task reincarnation and retains original obligation", () => withFileStore(h => {
  const r = h.record(); h.notify(r); const s = present(present(h.calls[0]).sources[0])
  h.append(() => { throw Error("audit first failed") }); expect(() => s.notDelivered("original")).toThrow()
  h.store.remove(r.task_id); h.store.save({ ...r, created_at: "2026-11-09T00:00:00.000Z" })
  let appends = 0; h.append((id, event) => { appends++; return h.store.appendEvent(id, event) })
  expect(() => s.notDelivered("ignored")).toThrow("replaced source")
  expect(appends).toBe(0); expect(h.timers).toHaveLength(0)
}))
test("legacy absence retains one-argument receiver, exact message and immediate second attempt", () => withFileStore(h => {
  const r = h.record(), messages: ParentNotifierMessage[] = [], receivers: unknown[] = [], arities: number[] = []
  const host = { enqueue(message: ParentNotifierMessage) { messages.push(message); receivers.push(this); arities.push(arguments.length); if (messages.length === 1) throw false } }
  const n = createCompletionNotifier({ store: h.store, notifier: host })
  expect(n.notifyTerminal({ record: r, parentState: { kind: "idle" }, runInBackground: true })).toEqual({ kind: "delivered", decision: "wake" })
  expect(messages[0]).toBe(messages[1]); expect(receivers).toEqual([host, host]); expect(arities).toEqual([1, 1])
}))

test("optional source method retains original receiver and two-argument shape", () => withFileStore(h => {
  const r = h.record(); let receiver: unknown, argc = 0
  const host = { enqueue() { throw Error("legacy") }, enqueueWithSource(_m: ParentNotifierMessage, sources: readonly CompletionDeliverySource[]) {
    receiver = this; argc = arguments.length; present(sources[0]).accepted()
  } }
  const notifier = createCompletionNotifier({ store: h.store, notifier: host })
  expect(notifier.notifyTerminal({ record: r, parentState: { kind: "streaming" }, runInBackground: true })).toEqual({ kind: "delivered", decision: "deliver_streaming" })
  expect(receiver).toBe(host); expect(argc).toBe(2)
}))
test("old refused same-epoch attempt cannot accept/fail the replacement", () => withFileStore(h => {
  const r = h.record(); h.host(() => { if (h.calls.length === 1) throw Error("before admission") })
  expect(h.notify(r).kind).toBe("pending")
  const old = present(present(h.calls[0]).sources[0]), current = present(present(h.calls[1]).sources[0])
  old.accepted(); old.notDelivered("stale")
  expect(present(h.store.load(r.task_id)).notification.notified_epoch).toBe(-1)
  current.accepted(); expect(present(h.store.load(r.task_id)).notification.notified_epoch).toBe(0)
  expect(h.timers).toHaveLength(0)
}))
test("pending old epoch callbacks cannot affect independently accepted new epoch", () => withFileStore(h => {
  const r = h.record(); h.notify(r); const old = present(present(h.calls[0]).sources[0])
  h.store.mutate(r.task_id, x => ({ ...x, notification: { ...x.notification, run_epoch: 1 } }))
  const newRecord = present(h.store.load(r.task_id)); h.notify(newRecord); present(present(h.calls[1]).sources[0]).accepted()
  old.notDelivered("old epoch definitive failure")
  expect(present(h.store.load(r.task_id)).notification).toEqual({ run_epoch: 1, notified_epoch: 1 })
  expect(h.timers).toHaveLength(0)
}))
test("failure before mutation remains retryable, then stale settles without audit", () => withFileStore(h => {
  const r = h.record(); h.notify(r); const source = present(present(h.calls[0]).sources[0])
  h.mutate(() => { throw Error("before mutation") }); expect(() => source.notDelivered("failure")).toThrow("before mutation")
  expect(h.notify(r).kind).toBe("pending")
  h.store.mutate(r.task_id, x => ({ ...x, parent_session_id: "new-parent" }))
  let audits = 0; h.mutate(h.store.mutate); h.append((id, event) => { audits++; return h.store.appendEvent(id, event) })
  source.notDelivered("different"); expect(audits).toBe(0); expect(h.timers).toHaveLength(0)
  expect(present(h.store.load(r.task_id)).notification.notification_failed_epoch).toBeUndefined()
}))
test("failed replacement drop retains buffered custody until actual audit succeeds", () => withFileStore(h => {
  const r = h.record(); h.notify(r, "compacting")
  h.append(() => { throw Error("drop audit") })
  expect(() => h.notifier.flushBuffered({ sessionId: "parent", replaced: true })).toThrow("drop audit")
  expect(h.notifier.bufferedCount("parent")).toBe(1); expect(h.calls).toHaveLength(0)
  h.append(h.store.appendEvent)
  expect(h.notifier.flushBuffered({ sessionId: "parent", replaced: true })).toEqual({ kind: "dropped", count: 1 })
}))
test("fresh process executes optional and absent notifier through support entry with SDK/UI/adapter poison", () => {
  const url = new URL("../tools/task/operations.ts", import.meta.url).href
  const script = `
let forbidden=0;
Bun.plugin({name:"a6b-cold",setup(b){b.onResolve({filter:/^(@code-yeongyu\\/senpi|@earendil-works\\/pi-tui|@oh-my-opencode\\/omo-senpi)(\\/|$)/},a=>{forbidden++;throw Error("FORBIDDEN:"+a.path)});b.onLoad({filter:/[\\\\/]packages[\\\\/](omo-senpi|omo-opencode)[\\\\/]/},()=>{forbidden++;throw Error("FORBIDDEN_ADAPTER")})}});
const ops=await import(${JSON.stringify(url)});
let r={task_id:"st_cold",name:"cold",parent_session_id:"p",root_session_id:"p",depth:0,execution_mode:"in-process",model:"unit",status:"completed",residency_state:"resident",created_at:"2026-11-09T00:00:00.000Z",updated_at:"2026-11-09T00:00:00.000Z",final_response:"done",notify_on_terminal:true,notification:{run_epoch:0,notified_epoch:-1}};
const store={load(){return r},list(){return{records:[r],diagnostics:[]}},replace(x){r=x},mutate(id,fn){return r=fn(r)},appendEvent(){return "unit-event"}};
let source,calls=0;
const optional=ops.createCompletionNotifier({store,notifier:{enqueue(){throw Error("legacy")},enqueueWithSource(m,s){source=s[0];calls++}}});
const request={record:r,parentState:{kind:"idle"},runInBackground:true};if(optional.notifyTerminal(request).kind!=="pending"||r.notification.notified_epoch!==-1)throw Error("Premature persistence");source.accepted();if(r.notification.notified_epoch!==0)throw Error("Missing accepted CAS");
r={...r,notification:{run_epoch:1,notified_epoch:0}};const legacy=ops.createCompletionNotifier({store,notifier:{enqueue(){calls++}}});if(legacy.notifyTerminal({...request,record:r}).kind!=="delivered"||r.notification.notified_epoch!==1)throw Error("Legacy changed");if(forbidden||calls!==2)throw Error("Cold failure");console.log(JSON.stringify({forbidden,calls,executedOptional:true,executedAbsent:true}));`
  const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 5000 })
  expect(new TextDecoder().decode(child.stderr)).toBe(""); expect(child.exitCode).toBe(0)
  expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({ forbidden: 0, calls: 2, executedOptional: true, executedAbsent: true })
})

test("definitive refusal must revalidate original source before immediate attempt2", () => withFileStore(h => {
  const r = h.record()
  h.host(() => { h.store.mutate(r.task_id, x => ({ ...x, parent_session_id: "new-parent", notification: { ...x.notification, run_epoch: 1 } })); throw Error("refused before admission") })
  expect(h.notify(r)).toEqual({ kind: "failed" })
  expect(h.calls).toHaveLength(1)
  expect(present(h.store.load(r.task_id)).notification).toEqual({ run_epoch: 1, notified_epoch: -1 })
  expect(h.timers).toHaveLength(0)
}))
test("custom scheduler cancellation reentrant flush cannot replace reserved batch custody", () => withFileStore(h => {
  const r = h.record(); h.notify(r)
  // Explicit synchronous scheduling seam: buffer before schedule() returns its cancellation.
  // No claim that the default timer invokes synchronously; the public schedule contract permits it.
  h.scheduling(() => { h.scheduling(undefined); h.notify(r, "compacting") })
  present(present(h.calls[0]).sources[0]).notDelivered("definitive")
  expect(h.notifier.bufferedCount("parent")).toBe(1)
  h.cancelling(() => { h.cancelling(undefined); h.notifier.flushBuffered({ sessionId: "parent", replaced: false }) })
  expect(h.notifier.flushBuffered({ sessionId: "parent", replaced: false })).toEqual({ kind: "pending", count: 1 })
  expect(h.calls).toHaveLength(2) // original failed send plus exactly ONE batch handoff
  present(present(h.calls[1]).sources[0]).accepted()
  expect(present(h.store.load(r.task_id)).notification.notified_epoch).toBe(0)
}))

test("throwing retry canceller retains cleanup handle without inaccessible pending source", () => withFileStore(h => {
  const r = h.record(); h.notify(r); present(present(h.calls[0]).sources[0]).notDelivered("definitive")
  let attempts = 0
  h.cancelling(() => { attempts++; if (attempts === 1) throw Error("cancel cleanup failed") })
  expect(() => h.notify(r)).toThrow("cancel cleanup failed")
  expect(h.calls).toHaveLength(1)
  expect(h.notify(r)).toEqual({ kind: "pending", decision: "wake" })
  expect(h.calls).toHaveLength(2); expect(attempts).toBe(2)
  present(present(h.calls[1]).sources[0]).accepted()
}))

test("refused batch attempt2 filters stale sources AND canonical details with actual handoff count", () => withFileStore(h => {
  const a = h.record(1), b = h.record(2), c = h.record(3)
  for (const r of [a,b,c]) h.notify(r, "compacting")
  h.host(call => {
    if (h.calls.length === 1) { h.store.mutate(a.task_id, x => ({ ...x, notification: { ...x.notification, run_epoch: 1 } })); throw Error("refused before admission") }
    call.sources.forEach(s => s.accepted())
  })
  expect(h.notifier.flushBuffered({ sessionId: "parent", replaced: false })).toEqual({ kind: "flushed", count: 2 })
  expect(h.calls).toHaveLength(2)
  expect(present(h.calls[1]).sources.map(s => s.taskId)).toEqual([b.task_id,c.task_id])
  expect(present(h.calls[1]).message.details.map(d => d.task_id)).toEqual([b.task_id,c.task_id])
  expect(present(h.calls[1]).message.content).toBe(buildCompletionMessage(present(h.calls[1]).message.details).content)
  expect(present(h.store.load(a.task_id)).notification.notified_epoch).toBe(-1)
}))
test("all batch sources stale after first refusal means empty not flushed0 or retry", () => withFileStore(h => {
  const r = h.record(); h.notify(r, "compacting")
  h.host(() => { h.store.mutate(r.task_id, x => ({ ...x, parent_session_id: "changed" })); throw Error("refused") })
  expect(h.notifier.flushBuffered({ sessionId: "parent", replaced: false })).toEqual({ kind: "empty" })
  expect(h.calls).toHaveLength(1); expect(h.timers).toHaveLength(0)
  expect(present(h.store.load(r.task_id)).notification.notified_epoch).toBe(-1)
}))
test("partial batch cancellation failure rolls back all unpublished owners, preserves buffer and failed handle", () => withFileStore(h => {
  const a = h.record(1), b = h.record(2)
  for (const r of [a,b]) {
    h.notify(r); h.scheduling(() => { h.scheduling(undefined); h.notify(r, "compacting") })
    present(present(h.calls.at(-1)).sources[0]).notDelivered("definitive")
  }
  let cancellations = 0
  h.cancelling(() => { cancellations++; if (cancellations === 2) throw Error("second cleanup failed") })
  expect(() => h.notifier.flushBuffered({ sessionId: "parent", replaced: false })).toThrow("second cleanup failed")
  expect(h.calls).toHaveLength(2); expect(h.notifier.bufferedCount("parent")).toBe(2)
  expect(h.notifier.flushBuffered({ sessionId: "parent", replaced: false })).toEqual({ kind: "pending", count: 2 })
  expect(h.calls).toHaveLength(3); expect(cancellations).toBe(3)
  present(h.calls[2]).sources.forEach(s => s.accepted())
}))

test("two-entry batch reserves ALL custody before first cancellation reenters flush", () => withFileStore(h => {
  const a = h.record(1), b = h.record(2)
  for (const r of [a,b]) {
    h.notify(r); h.scheduling(() => { h.scheduling(undefined); h.notify(r, "compacting") })
    present(present(h.calls.at(-1)).sources[0]).notDelivered("definitive")
  }
  h.cancelling(() => { h.cancelling(undefined); h.notifier.flushBuffered({ sessionId: "parent", replaced: false }) })
  expect(h.notifier.flushBuffered({ sessionId: "parent", replaced: false })).toEqual({ kind: "pending", count: 2 })
  expect(h.calls).toHaveLength(3)
  expect(h.calls.slice(2).flatMap(call => call.sources.map(source => source.taskId))).toEqual([a.task_id,b.task_id])
  present(h.calls[2]).sources.forEach(source => source.accepted())
  expect(present(h.store.load(a.task_id)).notification.notified_epoch).toBe(0)
  expect(present(h.store.load(b.task_id)).notification.notified_epoch).toBe(0)
}))

test("stale buffer cleanup reentry cannot steal previously selected fresh source custody", () => withFileStore(h => {
  const fresh = h.record(1), stale = h.record(2)
  for (const r of [fresh,stale]) {
    h.notify(r); h.scheduling(() => { h.scheduling(undefined); h.notify(r, "compacting") })
    present(present(h.calls.at(-1)).sources[0]).notDelivered("definitive")
  }
  h.store.mutate(stale.task_id, x => ({ ...x, notification: { ...x.notification, run_epoch: 1 } }))
  h.cancelling(() => { h.cancelling(undefined); h.notifier.flushBuffered({ sessionId: "parent", replaced: false }) })
  expect(h.notifier.flushBuffered({ sessionId: "parent", replaced: false })).toEqual({ kind: "empty" })
  expect(h.calls).toHaveLength(3)
  expect(present(h.calls[2]).sources.map(s => s.taskId)).toEqual([fresh.task_id])
  present(present(h.calls[2]).sources[0]).accepted()
  expect(present(h.store.load(fresh.task_id)).notification.notified_epoch).toBe(0)
  expect(present(h.store.load(stale.task_id)).notification.notified_epoch).toBe(-1)
}))

test("actual FileStore removal at audit boundary cannot recreate its removed event log", () => withFileStore(h => {
  const r = h.record(); h.notify(r); const source = present(present(h.calls[0]).sources[0])
  let calls = 0
  // The old load+append path exposes a post-read removal window. The guarded path must instead
  // see removal before acquiring its audit lock; never invoke remove recursively INSIDE a lock.
  h.load(id => {
    const record = h.store.load(id)
    if (record?.notification.notification_failed_epoch === 0) h.store.remove(id)
    return record
  })
  h.mutate((id, fn) => { calls++; if (calls === 2) h.store.remove(id); return h.store.mutate(id, fn) })
  let failure: unknown
  try { source.notDelivered("definitive") } catch (error) { failure = error }
  expect(h.store.load(r.task_id)).toBeNull()
  expect(existsSync(taskEventLogPath(h.store.stateDir, r.task_id))).toBe(false)
  expect(String(failure)).toContain("audit remains pending")
  expect(h.timers).toHaveLength(0)
}))

test("audit append success followed by store-return throw retains cleanup without duplicate audit", () => withFileStore(h => {
  const r = h.record(); h.notify(r); const source = present(present(h.calls[0]).sources[0])
  let mutations = 0, appends = 0
  h.mutate((id, fn) => { mutations++; const result = h.store.mutate(id, fn); if (mutations === 2) throw Error("after actual audit append"); return result })
  h.append((id, event) => { appends++; return h.store.appendEvent(id, event) })
  expect(() => source.notDelivered("original")).toThrow("after actual audit append")
  expect(h.notify(r).kind).toBe("pending"); expect(h.timers).toHaveLength(0)
  source.notDelivered("must not replace original")
  expect(appends).toBe(1); expect(mutations).toBe(2)
  expect(h.timers).toHaveLength(1); expect(h.calls).toHaveLength(1)
}))
