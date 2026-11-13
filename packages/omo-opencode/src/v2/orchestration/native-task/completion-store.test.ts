import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTaskRecordStore } from "@oh-my-opencode/senpi-task/manager-kernel"
import { createCompletionNotifier, createTaskTerminalObservers } from "@oh-my-opencode/senpi-task/task-operations"
import { createTaskRecord } from "../../../../../senpi-task/src/state/record"
import { createSessionScopes, type SessionLease } from "../../host/session-state"
import { createParentBindings } from "./parent-binding"
import { createOwnedCompletionStore, type ParentCompletionChannel } from "./completion-store"
import type { CompletionParentState, OpenStartCreationScope, TaskBirth } from "./completion-store"
import type { TaskRecord, TaskRecordStore } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { CompletionDeliverySource, ParentNotifierMessage } from "@oh-my-opencode/senpi-task/task-operations"
import {
  createSessionBackend,
  type ChildJournal,
  type ChildRecord,
  type SessionBackendApi,
} from "../../host/session-backend"
import { withJoinedSessionCancellation } from "../../host/session-cancellation"

test("owned unknown state commits real FileStore terminal, preserves liveness/ledger and never samples state or mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "omo-C2S-")),
    backing = createTaskRecordStore({ project_dir: dir, task: { state_dir: join(dir, "state") } })
  const scopes = createSessionScopes(),
    policy = { tools: [], authorize() {} }
  const root = scopes.open("unit-parent" as SessionLease["sessionID"], policy)
  const bindings = createParentBindings(root, policy, () => scopes.assert(root))
  let state = 0,
    mode = 0,
    live = 0,
    edges = 0,
    mutations = 0,
    enqueues = 0
  const notifier = createCompletionNotifier({
    store: backing,
    notifier: {
      enqueue() {
        enqueues++
      },
    },
  })
  // Real bindings and canonical notifier. These policy callbacks are controlled unit ports,
  // not genuine Native acceptance/SDK state/authority evidence.
  const channel: ParentCompletionChannel = {
    binding: bindings.root,
    parentSessionId: root.sessionID,
    rootSessionId: root.sessionID,
    notifier,
    parentState() {
      state++
      throw Error("controlled unknown state must not be sampled")
    },
    ownsTerminal: () => true,
    notificationReady: () => false,
    onTerminal() {
      live++
    },
  }
  const observers = createTaskTerminalObservers()
  observers.subscribe(() => edges++)
  const chain = createOwnedCompletionStore({
    baseStore: backing,
    bindings,
    channels: new Map([[bindings.root, channel]]),
    wasBackground() {
      mode++
      return true
    },
    currentGeneration: () => undefined,
    terminalObservers: observers,
  })
  chain.onMutation(() => mutations++)
  try {
    const record = {
      ...createTaskRecord({
        parent_session_id: root.sessionID,
        root_session_id: root.sessionID,
        depth: 1,
        execution_mode: "in-process",
        model: "controlled-unit",
        notify_on_terminal: true,
      }),
      status: "running" as const,
    }
    backing.save(record)
    let threw = false
    try {
      chain.store.mutate(record.task_id, (current) => ({
        ...current,
        status: "completed",
        final_response: "unit result",
      }))
    } catch {
      threw = true
    }
    expect(defined(backing.load(record.task_id)).status).toBe("completed")
    console.info(
      "C2S_REALSTORE_READY_FALSE",
      JSON.stringify({ committed: true, threw, state, mode, live, edges, mutations, enqueues }),
    )
    expect({ threw, state, mode, live, edges, mutations, enqueues }).toEqual({
      threw: false,
      state: 0,
      mode: 0,
      live: 1,
      edges: 1,
      mutations: 1,
      enqueues: 0,
    })
    expect(defined(backing.load(record.task_id)).notification.notified_epoch).toBe(-1)
  } finally {
    backing.close()
    scopes.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omo-C2S-matrix-")),
    backing = createTaskRecordStore({ project_dir: dir, task: { state_dir: join(dir, "state") } })
  const scopes = createSessionScopes(),
    policy = { tools: [], authorize() {} }
  const root = scopes.open("unit-root" as SessionLease["sessionID"], policy)
  let rootFault: unknown,
    rootFails = false
  const bindings = createParentBindings(root, policy, () => {
    if (rootFails) throw rootFault
    scopes.assert(root)
  })
  const channels = new Map<Parameters<typeof bindings.info>[0], ParentCompletionChannel>()
  const trace: string[] = [],
    births: Readonly<TaskBirth>[] = []
  const calls: { method: string; receiver: unknown; args: unknown[]; result: unknown }[] = []
  let scope: OpenStartCreationScope | undefined, generation: number | undefined
  let afterSave: ((record: TaskRecord) => void) | undefined
  let afterTransition: ((result: ReturnType<TaskRecordStore["transition"]>) => void) | undefined
  const base = new Proxy(backing, {
    get(target, key, receiver) {
      const original = Reflect.get(target, key, receiver)
      if (typeof original !== "function") return original
      if (key === "transition")
        return new Proxy(target.transition, {
          apply(fn, thisArg, args: Parameters<typeof target.transition>) {
            const result = fn.apply(target, args)
            calls.push({ method: "transition", receiver: thisArg, args, result })
            afterTransition?.(result)
            return result
          },
        })
      return new Proxy(original, {
        apply(fn, thisArg, args) {
          const result = Reflect.apply(fn, target, args)
          calls.push({ method: String(key), receiver: thisArg, args, result })
          if (key === "save") afterSave?.(args[0])
          return result
        },
      })
    },
  })
  const observers = createTaskTerminalObservers()
  observers.subscribe((edge) => trace.push("edge:" + edge.record.task_id))
  const chain = createOwnedCompletionStore({
    baseStore: base,
    bindings,
    channels,
    wasBackground() {
      trace.push("mode")
      return true
    },
    currentGeneration: () => generation,
    terminalObservers: observers,
    creationScope: () => scope,
  })
  chain.onMutation((change) => trace.push("mutation:" + change.taskId))
  function draft(parentSessionId: string = root.sessionID, extra: Partial<TaskRecord> = {}): TaskRecord {
    return {
      ...createTaskRecord({
        parent_session_id: parentSessionId,
        root_session_id: root.sessionID,
        depth: 1,
        execution_mode: "in-process",
        model: "controlled-unit",
        notify_on_terminal: true,
      }),
      status: "running",
      ...extra,
    }
  }
  function channel(binding = bindings.root) {
    const parent = bindings.info(binding),
      messages: ParentNotifierMessage[] = [],
      sources: CompletionDeliverySource[] = []
    const control: {
      state: CompletionParentState | undefined
      ready: boolean
      owns(record: TaskRecord): boolean
      onState?: () => void
      onReady?: (record: TaskRecord) => void
      onEnqueue?: () => void
      deferred: boolean
    } = {
      state: { kind: "idle" },
      ready: true,
      owns: () => true,
      deferred: false,
    }
    // Actual full canonical notifier, bookkeeping on SAME raw base. Transport callbacks and
    // cached state/private ownership readers are explicitly controlled unit ports.
    const notifier = createCompletionNotifier({
      store: backing,
      schedule: () => () => undefined,
      notifier: {
        enqueue(message) {
          trace.push("notify:" + parent.lease.sessionID)
          messages.push(message)
          control.onEnqueue?.()
        },
      },
    })
    const deferredNotifier = createCompletionNotifier({
      store: backing,
      schedule: () => () => undefined,
      notifier: {
        enqueue() {
          throw Error("deferred source path required")
        },
        enqueueWithSource(message, issued) {
          trace.push("source:" + parent.lease.sessionID)
          messages.push(message)
          sources.push(...issued)
        },
      },
    })
    const value: ParentCompletionChannel = {
      binding,
      parentSessionId: parent.lease.sessionID,
      rootSessionId: parent.rootSessionId,
      get notifier() {
        return control.deferred ? deferredNotifier : notifier
      },
      parentState() {
        trace.push("state:" + parent.lease.sessionID)
        control.onState?.()
        return control.state
      },
      ownsTerminal(record) {
        return control.owns(record)
      },
      notificationReady(record) {
        control.onReady?.(record)
        return control.ready
      },
      onTerminal(record) {
        trace.push("live:" + record.task_id)
      },
    }
    channels.set(binding, value)
    return { value, control, notifier, deferredNotifier, messages, sources }
  }
  async function childBinding() {
    // Actual backend-issued borrower; deterministic transport/journal doubles only.
    // This unit fixture is NOT real SDK/Native acceptance or OS custody evidence.
    const rows = new Map<string, ChildRecord>()
    const write = (before: ChildRecord, next: ChildRecord): undefined => {
      if (JSON.stringify(rows.get(before.key)) !== JSON.stringify(before)) throw Error("controlled CAS stale")
      rows.set(next.key, structuredClone(next))
      return undefined
    }
    const journal: ChildJournal = {
      async claim(key, _owner, initial) {
        if (!initial) throw Error("controlled initial only")
        rows.set(key, structuredClone(initial))
        return initial
      },
      async read(key) {
        return rows.get(key)
      },
      async write(before, next) {
        write(before, next)
      },
      writeSync: write,
      assertCurrent(row) {
        if (JSON.stringify(rows.get(row.key)) !== JSON.stringify(row)) throw Error("controlled row changed")
        return undefined
      },
    }
    const api = {
      async get({ sessionID }: { sessionID: string }) {
        return {
          id: sessionID,
          parentID: sessionID === root.sessionID ? undefined : root.sessionID,
          location: { directory: dir },
        }
      },
      async create(input: { id: string }) {
        return { id: input.id, parentID: root.sessionID, location: { directory: dir } }
      },
      async interrupt() {
        return { interrupted: true }
      },
      async wait() {},
      async remove() {},
    } as unknown as SessionBackendApi
    withJoinedSessionCancellation(api, "controlled-test")
    const backend = createSessionBackend(
      { app: { name: "opencode", version: "2.2.6", channel: "stable" }, location: { directory: dir }, session: api },
      {
        backendID: "C2S-unit",
        owner: "unit-owner",
        parent: root,
        scopes,
        policy,
        journal,
        gate: {
          assertActive() {
            scopes.assert(root)
          },
        },
      },
    )
    const child = await backend.stage({
      key: "unit-child",
      sessionID: "unit-child" as SessionLease["sessionID"],
      agent: "build",
    })
    const binding = bindings.adopt(backend.borrowParent(child), 1, () => {})
    return { binding, backend }
  }
  return {
    dir,
    backing,
    base,
    scopes,
    root,
    bindings,
    channels,
    chain,
    trace,
    births,
    calls,
    draft,
    channel,
    childBinding,
    get scope() {
      return scope
    },
    set scope(value: OpenStartCreationScope | undefined) {
      scope = value
    },
    set generation(value: number | undefined) {
      generation = value
    },
    set afterSave(value: ((row: TaskRecord) => void) | undefined) {
      afterSave = value
    },
    set afterTransition(value: ((result: ReturnType<TaskRecordStore["transition"]>) => void) | undefined) {
      afterTransition = value
    },
    failRoot(value: unknown) {
      rootFault = value
      rootFails = true
    },
    close() {
      backing.close()
      scopes.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
async function withFixture(run: (f: ReturnType<typeof fixture>) => void | Promise<void>) {
  const f = fixture()
  try {
    await run(f)
  } finally {
    f.close()
  }
}
const at = "2026-11-09T00:00:00.000Z"

test("real canonical notifier emits once then liveness/mutation/ledger, without recursive notification bookkeeping", async () =>
  withFixture((f) => {
    const c = f.channel(),
      row = f.draft()
    f.backing.save(row)
    const result = f.chain.store.transition(row.task_id, {
      type: "complete",
      timestamp: at,
      final_response: "actual unit content",
    })
    expect(result.applied).toBe(true)
    expect(f.trace).toEqual([
      "state:unit-root",
      "mode",
      "notify:unit-root",
      "live:" + row.task_id,
      "mutation:" + row.task_id,
      "edge:" + row.task_id,
    ])
    expect(c.messages).toHaveLength(1)
    expect(defined(c.messages[0]).content).toContain(row.task_id)
    expect(defined(f.backing.load(row.task_id)).notification.notified_epoch).toBe(0)
    f.chain.store.mutate(row.task_id, (fresh) => ({ ...fresh, final_response: "bookkeeping" }))
    expect(c.messages).toHaveLength(1)
    expect(f.trace.filter((value) => value.startsWith("edge:"))).toHaveLength(1)
  }))

test("unknown channel commits once and outer ledger observes canonical replace/mutate without a fake notifier", async () =>
  withFixture((f) => {
    const row = f.draft("unregistered-parent")
    f.backing.save(row)
    let callback = 0
    const returned = defined(
      f.chain.store.mutate(row.task_id, (fresh) => {
        callback++
        return { ...fresh, status: "lost" }
      }),
    )
    expect(callback).toBe(1)
    expect(returned.status).toBe("lost")
    expect(f.calls.filter((call) => call.method === "mutate")).toHaveLength(1)
    expect(f.trace).toEqual(["mutation:" + row.task_id, "edge:" + row.task_id])
    expect(returned.notification.notified_epoch).toBe(-1)
    const other = f.draft()
    f.backing.save(other)
    f.trace.length = 0
    f.chain.store.replace({ ...other, status: "lost" })
    expect(f.trace).toEqual(["mutation:" + other.task_id, "edge:" + other.task_id])
  }))

test("two actual issued parent channels keep nested routing local", async () =>
  withFixture(async (f) => {
    const borrowed = await f.childBinding()
    try {
      const rootChannel = f.channel(),
        childChannel = f.channel(borrowed.binding)
      const a = f.draft(),
        b = f.draft("unit-child", { depth: 2 })
      f.backing.save(a)
      f.backing.save(b)
      let nested = false
      rootChannel.control.onReady = (record) => {
        if (record.task_id === a.task_id && !nested) {
          nested = true
          f.chain.store.mutate(b.task_id, (fresh) => ({ ...fresh, status: "completed" }))
        }
      }
      f.chain.store.mutate(a.task_id, (fresh) => ({ ...fresh, status: "completed" }))
      expect(rootChannel.messages).toHaveLength(1)
      expect(childChannel.messages).toHaveLength(1)
      expect(defined(defined(rootChannel.messages[0]).details[0]).task_id).toBe(a.task_id)
      expect(defined(defined(childChannel.messages[0]).details[0]).task_id).toBe(b.task_id)
      expect(f.trace.filter((value) => value.startsWith("edge:"))).toEqual(["edge:" + b.task_id, "edge:" + a.task_id])
    } finally {
      await borrowed.backend.dispose()
    }
  }))

test("actual returned parent change denies original effects and NEVER retargets a real other channel", async () =>
  withFixture(async (f) => {
    const borrowed = await f.childBinding()
    try {
      const a = f.channel(),
        b = f.channel(borrowed.binding),
        row = f.draft()
      f.backing.save(row)
      const returned = defined(
        f.chain.store.mutate(row.task_id, (fresh) => ({
          ...fresh,
          parent_session_id: "unit-child",
          depth: 2,
          status: "completed",
        })),
      )
      expect(returned.parent_session_id).toBe("unit-child")
      expect(returned.notification.notified_epoch).toBe(-1)
      expect(a.messages).toHaveLength(0)
      expect(b.messages).toHaveLength(0)
      expect(f.trace).toEqual(["mutation:" + row.task_id, "edge:" + row.task_id])
    } finally {
      await borrowed.backend.dispose()
    }
  }))

for (const changed of ["root", "birth", "epoch", "claim"] as const)
  test(`post-write ${changed} custody change is refused by the original private channel, no row-derived grant`, async () =>
    withFixture((f) => {
      const c = f.channel(),
        row = f.draft()
      // No actual SDK/control is fabricated: a deterministic custody reader models its
      // refusal while the real FileStore and original canonical wrapper execute.
      const actual = {
        ...row,
        parent_session_id: f.root.sessionID,
        runner_kind: "owned-session" as const,
        residency_claim: "original",
        child_session_id: "unit-task-child",
        owned_session: {
          format: 1 as const,
          backendID: "unit",
          location: f.dir,
          hostVersion: "2.2.6",
          parentID: f.root.sessionID,
          sessionID: "unit-task-child",
          generation: 1,
          journalKey: "unit-key",
          journalOwner: "unit-owner",
          journalRevision: 1,
          runEpoch: 0,
          residencyClaim: "original",
        },
      }
      f.backing.save(actual)
      c.control.owns = (value) =>
        value.created_at === actual.created_at &&
        value.notification.run_epoch === 0 &&
        value.owned_session?.residencyClaim === "original"
      f.chain.store.mutate(actual.task_id, (fresh) => ({
        ...fresh,
        status: "completed",
        ...(changed === "root" ? { root_session_id: "other-root" } : {}),
        ...(changed === "birth" ? { created_at: "2026-10-01T00:00:00.000Z" } : {}),
        ...(changed === "epoch"
          ? {
              notification: { ...fresh.notification, run_epoch: 1 },
              owned_session: { ...actual.owned_session, runEpoch: 1 },
            }
          : {}),
        ...(changed === "claim"
          ? { residency_claim: "new-claim", owned_session: { ...actual.owned_session, residencyClaim: "new-claim" } }
          : {}),
      }))
      expect(c.messages).toHaveLength(0)
      expect(defined(f.backing.load(actual.task_id)).notification.notified_epoch).toBe(-1)
      expect(f.trace).toEqual(["mutation:" + actual.task_id, "edge:" + actual.task_id])
    }))

test("postwrite channel replacement is a normal hold and does not adopt replacement callbacks", async () =>
  withFixture((f) => {
    const old = f.channel(),
      row = f.draft()
    f.backing.save(row)
    let replacement: ReturnType<typeof f.channel> | undefined
    f.chain.store.mutate(row.task_id, (fresh) => {
      replacement = f.channel()
      return { ...fresh, status: "completed" }
    })
    expect(old.messages).toHaveLength(0)
    expect(defined(replacement).messages).toHaveLength(0)
    expect(f.trace).toEqual(["mutation:" + row.task_id, "edge:" + row.task_id])
  }))

for (const thrown of [undefined, null, 0, Error("private proof failure")])
  test(`exact postcommit private proof error ${String(thrown)} preserves canonical outer exception boundary`, async () =>
    withFixture((f) => {
      f.channel()
      const row = f.draft()
      f.backing.save(row)
      f.failRoot(thrown)
      let caught = false,
        value: unknown
      try {
        f.chain.store.mutate(row.task_id, (fresh) => ({ ...fresh, status: "completed" }))
      } catch (error) {
        caught = true
        value = error
      }
      expect(caught).toBe(true)
      expect(value).toBe(thrown)
      expect(defined(f.backing.load(row.task_id)).status).toBe("completed")
      expect(f.trace).toEqual([])
    }))

test("readiness false holds notification, later real canonical deferred-source reconcile settles exactly once", async () =>
  withFixture((f) => {
    const c = f.channel()
    c.control.deferred = true
    c.control.ready = false
    c.control.state = undefined
    const row = f.draft()
    f.backing.save(row)
    f.chain.store.mutate(row.task_id, (fresh) => ({ ...fresh, status: "completed", final_response: "held terminal" }))
    expect(c.messages).toHaveLength(0)
    expect(f.trace).toEqual(["live:" + row.task_id, "mutation:" + row.task_id, "edge:" + row.task_id])
    c.control.ready = true
    c.control.state = { kind: "idle" }
    c.deferredNotifier.reconcileUnnotifiedNotifications({ sessionId: f.root.sessionID, parentState: c.control.state })
    expect(c.sources).toHaveLength(1)
    expect(defined(f.backing.load(row.task_id)).notification.notified_epoch).toBe(-1)
    defined(c.sources[0]).accepted()
    defined(c.sources[0]).accepted()
    c.deferredNotifier.reconcileUnnotifiedNotifications({ sessionId: f.root.sessionID, parentState: c.control.state })
    expect(c.messages).toHaveLength(1)
    expect(defined(f.backing.load(row.task_id)).notification.notified_epoch).toBe(0)
    expect(f.trace.filter((value) => value.startsWith("edge:"))).toHaveLength(1)
  }))

test("readytrue but unknown state is postcommit protocol contradiction; knownfalse never calls a failing parent proof", async () =>
  withFixture((f) => {
    const c = f.channel(),
      a = f.draft()
    c.control.state = undefined
    f.backing.save(a)
    expect(() => f.chain.store.mutate(a.task_id, (fresh) => ({ ...fresh, status: "completed" }))).toThrow(
      "state is unknown",
    )
    expect(defined(f.backing.load(a.task_id)).status).toBe("completed")
    expect(f.trace).toEqual(["state:unit-root"])
    const b = f.draft()
    f.backing.save(b)
    f.trace.length = 0
    c.control.owns = () => false
    f.failRoot(Error("retired proof must not run"))
    f.chain.store.mutate(b.task_id, (fresh) => ({ ...fresh, status: "completed" }))
    expect(f.trace).toEqual(["mutation:" + b.task_id, "edge:" + b.task_id])
  }))

test("birth is frozen/copied before actual insert and published only after normal return", async () =>
  withFixture((f) => {
    const row = f.draft(),
      expected = {
        taskId: row.task_id,
        createdAt: row.created_at,
        parentSessionId: row.parent_session_id,
        rootSessionId: row.root_session_id,
        depth: row.depth,
      }
    const scope = {
      identity: {},
      open: true,
      onCreated(birth: Readonly<TaskBirth>): undefined {
        expect(this).toBe(scope)
        expect(f.backing.load(birth.taskId)).not.toBeNull()
        f.births.push(birth)
        return undefined
      },
    }
    f.scope = scope
    f.afterSave = (draft) => {
      Reflect.set(draft, "created_at", "2020-01-01T00:00:00.000Z")
      Reflect.set(draft, "depth", 8)
    }
    f.chain.store.save(row)
    expect(f.births).toEqual([expected])
    expect(Object.isFrozen(f.births[0])).toBe(true)
    expect(f.calls.filter((call) => call.method === "save")).toHaveLength(1)
  }))

test("closed inherited scope cannot become a birth witness by reopening during save", async () =>
  withFixture((f) => {
    const scope = {
      identity: {},
      open: false,
      onCreated(birth: Readonly<TaskBirth>): undefined {
        f.births.push(birth)
        return undefined
      },
    }
    f.scope = scope
    f.afterSave = () => {
      scope.open = true
    }
    const row = f.draft()
    f.chain.store.save(row)
    expect(f.backing.load(row.task_id)).not.toBeNull()
    expect(f.births).toHaveLength(0)
  }))

test("scope changes/closure after save never assign original birth to a later request", async () =>
  withFixture((f) => {
    const original = {
      identity: {},
      open: true,
      onCreated(birth: Readonly<TaskBirth>): undefined {
        f.births.push(birth)
        return undefined
      },
    }
    f.scope = original
    f.afterSave = () => {
      f.scope = { ...original, identity: {} }
    }
    f.chain.store.save(f.draft())
    expect(f.births).toHaveLength(0)
    f.scope = original
    f.afterSave = () => {
      original.open = false
    }
    f.chain.store.save(f.draft())
    expect(f.births).toHaveLength(0)
  }))

test("actual FileStore collision never publishes a creation witness or retries insert", async () =>
  withFixture((f) => {
    const row = f.draft()
    f.backing.save(row)
    f.scope = {
      identity: {},
      open: true,
      onCreated(birth) {
        f.births.push(birth)
        return undefined
      },
    }
    expect(() => f.chain.store.save(row)).toThrow()
    expect(f.births).toHaveLength(0)
    expect(defined(f.backing.load(row.task_id)).created_at).toBe(row.created_at)
  }))

for (const thrown of [undefined, null, 0, Error("creation receipt failed")])
  test(`creation callback exact throw ${String(thrown)} leaves durable row, no retry/rollback`, async () =>
    withFixture((f) => {
      const row = f.draft()
      let count = 0
      f.scope = {
        identity: {},
        open: true,
        onCreated() {
          count++
          throw thrown
        },
      }
      let caught = false,
        value: unknown
      try {
        f.chain.store.save(row)
      } catch (error) {
        caught = true
        value = error
      }
      expect(caught).toBe(true)
      expect(value).toBe(thrown)
      expect(count).toBe(1)
      expect(defined(f.backing.load(row.task_id)).task_id).toBe(row.task_id)
      expect(f.calls.filter((call) => call.method === "save")).toHaveLength(1)
      expect(f.trace).toEqual([]) // canonical outer mutation/ledger boundary after inner failure
    }))

test("base save write-then-throw is not normal return: retain row with zero birth callbacks", async () =>
  withFixture((f) => {
    const row = f.draft()
    f.scope = {
      identity: {},
      open: true,
      onCreated(birth) {
        f.births.push(birth)
        return undefined
      },
    }
    f.afterSave = () => {
      throw null
    } // controlled fault AFTER original actual FileStore save
    let caught = false,
      value: unknown
    try {
      f.chain.store.save(row)
    } catch (error) {
      caught = true
      value = error
    }
    expect(caught).toBe(true)
    expect(value).toBeNull()
    expect(f.births).toHaveLength(0)
    expect(f.backing.load(row.task_id)).not.toBeNull()
    expect(f.calls.filter((call) => call.method === "save")).toHaveLength(1)
  }))

for (const invalid of [null, 0, false, {}, Promise.resolve(undefined)])
  test(`nonundefined creation result ${String(invalid)} is retained as strict protocol error cause`, async () =>
    withFixture((f) => {
      const row = f.draft(),
        scope = { identity: {}, open: true, onCreated: (): undefined => undefined }
      // Deliberate unchecked producer fault on a local unit object, not a forged Context/store.
      expect(Reflect.set(scope, "onCreated", () => invalid)).toBe(true)
      f.scope = scope
      let caught: unknown
      try {
        f.chain.store.save(row)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(TypeError)
      expect((caught as Error).cause).toBe(invalid)
      expect(f.backing.load(row.task_id)).not.toBeNull()
      expect(f.trace).toEqual([])
    }))

test("nested saves preserve distinct original scope identities and copied birth facts", async () =>
  withFixture((f) => {
    const a = f.draft(),
      b = f.draft(),
      seen: { identity: object; birth: Readonly<TaskBirth> }[] = []
    const scopeA = {
      identity: {},
      open: true,
      onCreated(birth: Readonly<TaskBirth>): undefined {
        seen.push({ identity: this.identity, birth })
        return undefined
      },
    }
    const scopeB = {
      identity: {},
      open: true,
      onCreated(birth: Readonly<TaskBirth>): undefined {
        seen.push({ identity: this.identity, birth })
        return undefined
      },
    }
    f.scope = scopeA
    f.afterSave = (row) => {
      if (row.task_id === a.task_id) {
        f.scope = scopeB
        f.chain.store.save(b)
        f.scope = scopeA
      }
    }
    f.chain.store.save(a)
    expect(seen.map((item) => [item.identity, item.birth.taskId])).toEqual([
      [scopeB.identity, b.task_id],
      [scopeA.identity, a.task_id],
    ])
    expect(f.calls.filter((call) => call.method === "save")).toHaveLength(2)
  }))

test("changing original scope callback/opaque identity during save cannot rebind birth", async () =>
  withFixture((f) => {
    const scope = {
      identity: {},
      open: true,
      onCreated(birth: Readonly<TaskBirth>): undefined {
        f.births.push(birth)
        return undefined
      },
    }
    f.scope = scope
    f.afterSave = () => {
      scope.identity = {}
    }
    f.chain.store.save(f.draft())
    expect(f.births).toHaveLength(0)
    f.afterSave = () => {
      scope.onCreated = () => {
        throw Error("replacement callback must not run")
      }
    }
    f.chain.store.save(f.draft())
    expect(f.births).toHaveLength(0)
  }))

test("canonical generation stamping retains planning generation AND sticky unknown", async () =>
  withFixture((f) => {
    const a = f.draft()
    f.generation = 7
    f.chain.store.save(a)
    expect(defined(f.backing.load(a.task_id)).config_generation).toBe(7)
    f.generation = 99
    f.chain.store.replace(a)
    expect(defined(f.backing.load(a.task_id)).config_generation).toBe(7)
    const b = f.draft()
    f.generation = undefined
    f.chain.store.save(b)
    f.generation = 100
    f.chain.store.replace(b)
    expect(defined(f.backing.load(b.task_id)).config_generation).toBeUndefined()
  }))

test("all fifteen actual store methods preserve receiver, results, callback/owner identities and two-phase TTL", async () =>
  withFixture((f) => {
    const row = f.draft(),
      store = f.chain.store
    store.save(row)
    expect(store.stateDir).toBe(f.backing.stateDir)
    expect("close" in store).toBe(false)
    const loaded = store.load(row.task_id)
    expect(defined(f.calls.findLast((call) => call.method === "load")).result).toBe(loaded)
    const listed = store.list()
    expect(defined(f.calls.findLast((call) => call.method === "list")).result).toBe(listed)
    const event = { type: "controlled-event", payload: { own: true } }
    const eventPath = store.appendEvent(row.task_id, event)
    expect(defined(f.calls.findLast((call) => call.method === "appendEvent")).result).toBe(eventPath)
    expect(defined(f.calls.findLast((call) => call.method === "appendEvent")).args[1]).toBe(event)
    let mutations = 0
    const returned = store.mutate(row.task_id, (fresh) => {
      mutations++
      return { ...fresh, final_response: "one actual callback" }
    })
    expect(mutations).toBe(1)
    expect(defined(f.calls.findLast((call) => call.method === "mutate")).result).toBe(returned)
    const transition = { type: "complete" as const, timestamp: at, final_response: "complete" }
    const transitioned = store.transition(row.task_id, transition)
    expect(defined(f.calls.findLast((call) => call.method === "transition")).result).toBe(transitioned)
    expect(defined(f.calls.findLast((call) => call.method === "transition")).args[1]).toBe(transition)
    store.replace(defined(f.backing.load(row.task_id)))
    const keep = () => true,
      drop = () => false,
      first = { pid: process.pid, token: "controlled-first" },
      next = { pid: process.pid, token: "controlled-next" }
    expect(store.tombstoneIfExpired(row.task_id, keep, first).kind).toBe("retained")
    const tombstone = store.tombstoneIfExpired(row.task_id, drop, first)
    expect(defined(f.calls.findLast((call) => call.method === "tombstoneIfExpired")).result).toBe(tombstone)
    expect(defined(f.calls.findLast((call) => call.method === "tombstoneIfExpired")).args.slice(1)).toEqual([
      drop,
      first,
    ])
    expect(store.load(row.task_id)).toBeNull()
    expect(store.listExpunging()).toContain(row.task_id)
    expect(defined(store.loadExpunging(row.task_id)).task_id).toBe(row.task_id)
    expect(store.readExpungeOwner(row.task_id)).toEqual(first)
    expect(store.takeOverExpunging(row.task_id, first, next)).toBe(true)
    expect(defined(f.calls.findLast((call) => call.method === "takeOverExpunging")).args[1]).toBe(first)
    expect(defined(f.calls.findLast((call) => call.method === "takeOverExpunging")).args[2]).toBe(next)
    store.restoreExpunging(row.task_id, next)
    expect(store.load(row.task_id)).not.toBeNull()
    store.tombstoneIfExpired(row.task_id, drop, next)
    expect(store.completeExpunge(row.task_id, first)).toBe(false)
    expect(store.completeExpunge(row.task_id, next)).toBe(true)
    const other = f.draft()
    store.save(other)
    store.remove(other.task_id)
    expect(store.load(other.task_id)).toBeNull()
    const methods = [
      "save",
      "replace",
      "mutate",
      "transition",
      "load",
      "list",
      "appendEvent",
      "remove",
      "tombstoneIfExpired",
      "completeExpunge",
      "listExpunging",
      "loadExpunging",
      "restoreExpunging",
      "readExpungeOwner",
      "takeOverExpunging",
    ]
    expect([...new Set(f.calls.map((call) => call.method))].sort()).toEqual([...methods].sort())
    expect(f.calls.every((call) => call.receiver === f.base)).toBe(true)
    expect(Object.keys(store).sort()).toEqual(["stateDir", ...methods].sort())
  }))

test("mutation listeners unsubscribe and exact falsey listener error keeps canonical postcommit ledger boundary", async () =>
  withFixture((f) => {
    let heard = 0
    const detach = f.chain.onMutation(() => heard++)
    f.chain.store.save(f.draft())
    expect(heard).toBe(1)
    detach()
    f.chain.store.save(f.draft())
    expect(heard).toBe(1)
    f.chain.onMutation(() => {
      throw 0
    })
    const row = f.draft()
    f.backing.save(row)
    f.trace.length = 0
    let caught = false,
      value: unknown
    try {
      f.chain.store.mutate(row.task_id, (fresh) => ({ ...fresh, status: "completed" }))
    } catch (error) {
      caught = true
      value = error
    }
    expect(caught).toBe(true)
    expect(value).toBe(0)
    expect(defined(f.backing.load(row.task_id)).status).toBe("completed")
    expect(f.trace).toEqual(["mutation:" + row.task_id])
  }))

test("released borrowed binding and removed original channel hold both effects without proof reuse", async () =>
  withFixture(async (f) => {
    const borrowed = await f.childBinding()
    try {
      const c = f.channel(borrowed.binding),
        row = f.draft("unit-child", { depth: 2 })
      f.backing.save(row)
      // Preload selects a real channel. Original write callback releases its map identity
      // synchronously before post-write policy; no asynchronous cleanup is faked here.
      f.chain.store.mutate(row.task_id, (fresh) => {
        f.channels.delete(borrowed.binding)
        return { ...fresh, status: "completed" }
      })
      expect(c.messages).toHaveLength(0)
      expect(f.trace).toEqual(["mutation:" + row.task_id, "edge:" + row.task_id])
      await f.bindings.release(borrowed.binding)
      expect(f.bindings.get("unit-child")).toBeUndefined()
      const other = f.draft("unit-child", { depth: 2 })
      f.backing.save(other)
      f.trace.length = 0
      f.chain.store.mutate(other.task_id, (fresh) => ({ ...fresh, status: "completed" }))
      expect(f.trace).toEqual(["mutation:" + other.task_id, "edge:" + other.task_id])
    } finally {
      await borrowed.backend.dispose()
    }
  }))

test("readiness/notifier revocation cannot run a later old-owner effect", async () =>
  withFixture((f) => {
    const c = f.channel(),
      a = f.draft()
    f.backing.save(a)
    c.control.onReady = () => {
      f.channels.delete(f.bindings.root)
    }
    f.chain.store.mutate(a.task_id, (fresh) => ({ ...fresh, status: "completed" }))
    expect(f.trace).toEqual(["mutation:" + a.task_id, "edge:" + a.task_id])
    expect(c.messages).toHaveLength(0)
    const next = f.channel(),
      b = f.draft()
    f.backing.save(b)
    f.trace.length = 0
    next.control.onEnqueue = () => {
      f.channels.delete(f.bindings.root)
    }
    f.chain.store.mutate(b.task_id, (fresh) => ({ ...fresh, status: "completed" }))
    expect(next.messages).toHaveLength(1)
    expect(f.trace).toEqual([
      "state:unit-root",
      "mode",
      "notify:unit-root",
      "mutation:" + b.task_id,
      "edge:" + b.task_id,
    ])
  }))

for (const which of ["ownsTerminal", "notificationReady"] as const)
  test(`invalid ${which} boolean is preserved as a postcommit protocol fault`, async () =>
    withFixture((f) => {
      const c = f.channel(),
        row = f.draft(),
        invalid = Promise.resolve(true)
      expect(Reflect.set(c.value, which, () => invalid)).toBe(true)
      f.backing.save(row)
      let caught: unknown
      try {
        f.chain.store.mutate(row.task_id, (fresh) => ({ ...fresh, status: "completed" }))
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(TypeError)
      expect((caught as Error).cause).toBe(invalid)
      expect(defined(f.backing.load(row.task_id)).status).toBe("completed")
      expect(f.trace).toEqual([])
    }))

test("post-write falsey channel reader throw is exact, and absent creation scope adds no witness", async () =>
  withFixture((f) => {
    const c = f.channel(),
      row = f.draft()
    f.chain.store.save(row)
    expect(f.births).toHaveLength(0)
    f.trace.length = 0
    c.control.owns = () => {
      throw undefined
    }
    let caught = false,
      value: unknown
    try {
      f.chain.store.mutate(row.task_id, (fresh) => ({ ...fresh, status: "completed" }))
    } catch (error) {
      caught = true
      value = error
    }
    expect(caught).toBe(true)
    expect(value).toBeUndefined()
    expect(defined(f.backing.load(row.task_id)).status).toBe("completed")
    expect(f.trace).toEqual([])
  }))

test("transition routes by original parent hint but validates the actual post-write returned record", async () =>
  withFixture(async (f) => {
    const borrowed = await f.childBinding()
    try {
      const a = f.channel(),
        b = f.channel(borrowed.binding),
        row = f.draft()
      f.backing.save(row)
      // Controlled post-write base-port seam: first delegate ORIGINAL transition, then
      // persist a valid actual FileStore parent change and return that actual loaded row.
      // No SDK/control/acceptance result is fabricated by these unit records.
      f.afterTransition = (result) => {
        f.backing.replace({ ...result.record, parent_session_id: "unit-child", depth: 2 })
        expect(Reflect.set(result, "record", defined(f.backing.load(row.task_id)))).toBe(true)
      }
      const result = f.chain.store.transition(row.task_id, { type: "complete", timestamp: at, final_response: "unit" })
      expect(result.record.parent_session_id).toBe("unit-child")
      expect(a.messages).toHaveLength(0)
      expect(b.messages).toHaveLength(0)
      expect(f.trace).toEqual(["mutation:" + row.task_id, "edge:" + row.task_id])
      expect(result.record.notification.notified_epoch).toBe(-1)
    } finally {
      await borrowed.backend.dispose()
    }
  }))
function defined<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("expected a defined value")
  return value
}
