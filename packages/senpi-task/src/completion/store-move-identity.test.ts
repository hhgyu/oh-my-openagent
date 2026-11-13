import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createTaskRecord } from "../state/record"
import { createTaskRecordStore } from "../store/record-store"
import { createCompletionNotifier } from "./notifier"
import * as observing from "./observing-store"
import * as mutation from "./mutation-store"
import * as status from "./status-edge"
import * as generation from "./config-generation-store"
import * as terminal from "./terminal-observers"
import * as support from "../tools/task/operations"
// Compatibility identity test only: production S modules never import the adapter.
import * as oldObserving from "../../../omo-senpi/src/components/task/completion-bridge"
import * as oldMutation from "../../../omo-senpi/src/components/task/store-mutation-observer"
import * as oldStatus from "../../../omo-senpi/src/components/task/store-status-edge"
import * as oldGeneration from "../../../omo-senpi/src/components/task/config-generation-store"
import * as oldTerminal from "../../../omo-senpi/src/components/task/terminal-observers"

function withStore(run: (backing: ReturnType<typeof createTaskRecordStore>, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "omo-a5-store-"))
  const backing = createTaskRecordStore({ project_dir: dir })
  try {
    run(backing, dir)
  } finally {
    backing.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
const draft = () =>
  createTaskRecord({
    parent_session_id: "parent",
    root_session_id: "parent",
    depth: 0,
    execution_mode: "in-process",
    model: "qa/model",
    notify_on_terminal: false,
    task_seq: 0,
  })

test("old, moved and support paths expose the same definitions, not forwarding lambdas", () => {
  for (const pair of [
    [oldObserving.createCompletionObservingStore, observing.createCompletionObservingStore],
    [oldMutation.createMutationNotifyingStore, mutation.createMutationNotifyingStore],
    [oldStatus.watchStatusEdge, status.watchStatusEdge],
    [oldStatus.isTerminalStatus, status.isTerminalStatus],
    [oldGeneration.createConfigGenerationStampingStore, generation.createConfigGenerationStampingStore],
    [oldTerminal.createTaskTerminalObservers, terminal.createTaskTerminalObservers],
    [oldTerminal.sharedTaskTerminalObservers, terminal.sharedTaskTerminalObservers],
    [support.createCompletionObservingStore, observing.createCompletionObservingStore],
    [support.createMutationNotifyingStore, mutation.createMutationNotifyingStore],
    [support.watchStatusEdge, status.watchStatusEdge],
    [support.isTerminalStatus, status.isTerminalStatus],
    [support.createConfigGenerationStampingStore, generation.createConfigGenerationStampingStore],
    [support.createTaskTerminalObservers, terminal.createTaskTerminalObservers],
    [support.sharedTaskTerminalObservers, terminal.sharedTaskTerminalObservers],
  ])
    expect(pair[0]).toBe(pair[1])
  expect(oldTerminal.TASK_TERMINAL_OBSERVERS_KEY).toBe(terminal.TASK_TERMINAL_OBSERVERS_KEY)
  expect(support.TASK_TERMINAL_OBSERVERS_KEY).toBe(terminal.TASK_TERMINAL_OBSERVERS_KEY)
})

test("real-store chain preserves notify/liveness/mutation/ledger order and terminal epoch distinction", () => {
  withStore((backing, dir) => {
    const order: string[] = []
    const notifier = createCompletionNotifier({
      store: backing,
      stateDir: dir,
      notifier: {
        enqueue() {
          throw Error("foreground must not enqueue")
        },
      },
    })
    const observedNotifier = new Proxy(notifier, {
      get(target, key, receiver) {
        const original = Reflect.get(target, key, receiver)
        return key === "notifyTerminal"
          ? new Proxy(original, {
              apply(fn, thisArg, args) {
                order.push("notify")
                return Reflect.apply(fn, thisArg, args)
              },
            })
          : original
      },
    })
    const observed = observing.createCompletionObservingStore(backing, {
      notifier: observedNotifier,
      parentState: () => ({ kind: "idle" }),
      wasBackground: () => false,
      currentSessionId: () => "parent",
      onTerminal() {
        order.push("liveness")
      },
    })
    const stamped = generation.createConfigGenerationStampingStore(observed, () => 7)
    const ledger = terminal.createTaskTerminalObservers()
    ledger.subscribe(() => order.push("ledger"))
    const store = mutation.createMutationNotifyingStore(stamped, () => order.push("mutation"), ledger)
    const row = { ...draft(), status: "running" as const }
    store.save(row)
    expect(store.load(row.task_id)?.config_generation).toBe(7)
    order.length = 0
    store.mutate(row.task_id, (fresh) => ({ ...fresh, status: "lost" }))
    expect(order).toEqual(["notify", "liveness", "mutation", "ledger"])
    order.length = 0
    store.mutate(row.task_id, (fresh) => ({
      ...fresh,
      notification: { ...fresh.notification, run_epoch: fresh.notification.run_epoch + 1 },
    }))
    expect(order).toEqual(["notify", "liveness", "mutation"])
    order.length = 0
    store.mutate(row.task_id, (fresh) => ({ ...fresh, name: "terminal bookkeeping" }))
    expect(order).toEqual(["mutation"])
  })
})

test("all seven real TTL methods preserve owners/results and never generate a terminal edge", () => {
  withStore((backing) => {
    const changes: (string | null)[] = [],
      edges: string[] = []
    const ledger = terminal.createTaskTerminalObservers()
    ledger.subscribe((edge) => edges.push(edge.record.status))
    const store = mutation.createMutationNotifyingStore(
      backing,
      (change) => changes.push(change.record?.task_id ?? null),
      ledger,
    )
    const row = { ...draft(), status: "running" as const },
      owner = { pid: process.pid, token: "a5-first" },
      next = { pid: process.pid, token: "a5-next" }
    store.save(row)
    changes.length = 0
    store.appendEvent(row.task_id, { type: "a5-read-only-to-wrapper", payload: {} })
    store.load(row.task_id)
    store.list()
    expect(changes).toEqual([])
    expect(store.tombstoneIfExpired(row.task_id, () => true, owner).kind).toBe("retained")
    expect(changes).toEqual([])
    expect(store.tombstoneIfExpired(row.task_id, () => false, owner).kind).toBe("tombstoned")
    expect(store.listExpunging()).toContain(row.task_id)
    expect(store.loadExpunging(row.task_id)?.task_id).toBe(row.task_id)
    expect(store.readExpungeOwner(row.task_id)).toEqual(owner)
    expect(store.takeOverExpunging(row.task_id, owner, next)).toBe(true)
    expect(store.readExpungeOwner(row.task_id)).toEqual(next)
    expect(store.completeExpunge(row.task_id, owner)).toBe(false)
    store.restoreExpunging(row.task_id, owner)
    expect(store.load(row.task_id)).toBeNull()
    store.restoreExpunging(row.task_id, next)
    expect(store.load(row.task_id)?.task_id).toBe(row.task_id)
    expect(store.tombstoneIfExpired(row.task_id, () => false, next).kind).toBe("tombstoned")
    expect(store.completeExpunge(row.task_id, next)).toBe(true)
    expect(store.completeExpunge(row.task_id, next)).toBe(false)
    expect(store.loadExpunging(row.task_id)).toBeNull()
    expect(changes).toEqual([null, null, null, row.task_id, null, null, null])
    expect(edges).toEqual([])
  })
})

test("shared ledger identity and existing reporter-throw boundary remain unchanged", () => {
  const globals = globalThis as unknown as Record<symbol, unknown>,
    key = terminal.TASK_TERMINAL_OBSERVERS_KEY,
    previous = globals[key]
  try {
    delete globals[key]
    expect(oldTerminal.sharedTaskTerminalObservers()).toBe(terminal.sharedTaskTerminalObservers())
    expect(support.sharedTaskTerminalObservers()).toBe(terminal.sharedTaskTerminalObservers())
    withStore((backing) => {
      const record = { ...draft(), status: "lost" as const }
      backing.save(record)
      const reporterFault = Error("original reporter throws")
      const ledger = terminal.createTaskTerminalObservers(() => {
        throw reporterFault
      })
      ledger.subscribe(() => {
        throw Error("observer throws")
      })
      expect(() => ledger.notify({ record })).toThrow(reporterFault)
    })
  } finally {
    if (previous === undefined) delete globals[key]
    else globals[key] = previous
  }
})

test("fresh process executes moved store/ledger support without SDK/UI/adapter runtime", () => {
  const url = (name: string) => pathToFileURL(resolve(import.meta.dir, name)).href
  const script = `
let forbidden=0;
Bun.plugin({name:"a5-cold",setup(b){b.onResolve({filter:/^(@code-yeongyu\\/senpi|@earendil-works\\/pi-tui|@oh-my-opencode\\/omo-senpi)(\\/|$)/},a=>{forbidden++;throw Error("FORBIDDEN:"+a.path)});b.onLoad({filter:/[\\\\/]packages[\\\\/]omo-senpi[\\\\/]/},()=>{forbidden++;throw Error("FORBIDDEN_ADAPTER")})}});
const ops=await import(${JSON.stringify(url("../tools/task/operations.ts"))});
const {createTaskRecordStore}=await import(${JSON.stringify(url("../store/record-store.ts"))});
const {createTaskRecord}=await import(${JSON.stringify(url("../state/record.ts"))});
const {createCompletionNotifier}=await import(${JSON.stringify(url("notifier.ts"))});
const {mkdtempSync,rmSync}=await import("node:fs");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
const dir=mkdtempSync(join(tmpdir(),"omo-a5-cold-")),backing=createTaskRecordStore({project_dir:dir});
try{let edges=0;const ledger=ops.createTaskTerminalObservers();ledger.subscribe(()=>edges++);const notifier=createCompletionNotifier({store:backing,stateDir:dir,notifier:{enqueue(){throw Error("Unexpected foreground notification")}}});const observing=ops.createCompletionObservingStore(backing,{notifier,parentState:()=>({kind:"idle"}),wasBackground:()=>false,currentSessionId:()=>"parent"});const stamped=ops.createConfigGenerationStampingStore(observing,()=>0);const store=ops.createMutationNotifyingStore(stamped,()=>{},ledger);const row=createTaskRecord({parent_session_id:"parent",root_session_id:"parent",depth:0,execution_mode:"in-process",model:"qa/model",notify_on_terminal:false,task_seq:0});store.save(row);store.mutate(row.task_id,r=>({...r,status:"lost"}));if(edges!==1||store.load(row.task_id).config_generation!==0||forbidden)throw Error("Cold store execution failed");console.log(JSON.stringify({forbidden,edges,generation:0}))}finally{backing.close();rmSync(dir,{recursive:true,force:true})}`
  const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 5000 })
  expect(new TextDecoder().decode(child.stderr)).toBe("")
  expect(child.exitCode).toBe(0)
  expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({ forbidden: 0, edges: 1, generation: 0 })
})
