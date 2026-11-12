import { expect, test } from "bun:test"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import * as coordinator from "./coordinator"
import * as items from "./items"
import * as receipts from "./receipts"
import * as support from "../tools/task/operations"
// Test-only compatibility check; production S never imports adapter code.
import * as oldCoordinator from "../../../omo-senpi/src/extension/idle-injection-coordinator"
import * as oldItems from "../../../omo-senpi/src/extension/idle-injection-items"
import * as oldReceipts from "../../../omo-senpi/src/extension/idle-injection-receipts"

test("old, moved and support paths share constructors/functions/constants", () => {
  for (const pair of [
    [oldCoordinator.IdleInjectionCoordinator, coordinator.IdleInjectionCoordinator],
    [oldCoordinator.IdleInjectionRetiredError, coordinator.IdleInjectionRetiredError],
    [support.IdleInjectionCoordinator, coordinator.IdleInjectionCoordinator],
    [support.IdleInjectionRetiredError, coordinator.IdleInjectionRetiredError],
    [oldItems.withSuperseded, items.withSuperseded],
    [support.withSuperseded, items.withSuperseded],
    [oldItems.admissionBatches, items.admissionBatches],
    [support.admissionBatches, items.admissionBatches],
    [oldItems.failItems, items.failItems],
    [support.failItems, items.failItems],
    [oldItems.settleItemReceipts, items.settleItemReceipts],
    [support.settleItemReceipts, items.settleItemReceipts],
    [oldReceipts.runReceipts, receipts.runReceipts],
    [support.runReceipts, receipts.runReceipts],
  ])
    expect(pair[0]).toBe(pair[1])
  expect(oldReceipts.NO_RECEIPT_ERRORS).toBe(receipts.NO_RECEIPT_ERRORS)
  expect(support.NO_RECEIPT_ERRORS).toBe(receipts.NO_RECEIPT_ERRORS)
  const error = new coordinator.IdleInjectionRetiredError()
  expect(error).toBeInstanceOf(oldCoordinator.IdleInjectionRetiredError)
  expect(error.name).toBe("IdleInjectionRetiredError")
  expect(error.message).toBe("idle-injection coordinator retired on session shutdown; injection not delivered")
})

test("default microtask/passive-only/rank/live keyed content and all superseded receipts stay exact", async () => {
  const messages: coordinator.IdleInjectionMessage[] = [],
    done: string[] = []
  const queue = new coordinator.IdleInjectionCoordinator((message) => {
    messages.push(message)
  })
  queue.enqueue({
    key: "passive",
    source: "kibitzer",
    passive: true,
    content: "passive",
    onFlushed: () => done.push("passive"),
  })
  queue.scheduleFlush()
  expect(messages).toHaveLength(0)
  await Promise.resolve()
  expect(messages).toHaveLength(0)
  expect(queue.pendingCount()).toBe(1)
  queue.enqueue({ key: "task", source: "task-completion", content: "old", onFlushed: () => done.push("old") })
  const latest = { key: "task", source: "task-completion" as const, content: "new", onFlushed: () => done.push("new") }
  queue.enqueue(latest)
  latest.content = "live"
  queue.enqueue({ key: "team", source: "team-message", content: "team" })
  queue.enqueue({ key: "dag", source: "dag-run", content: "dag" })
  queue.scheduleFlush()
  expect(messages).toHaveLength(0)
  await Promise.resolve()
  expect(messages).toHaveLength(1)
  expect(messages[0].content).toBe("live\n\nteam\n\ndag\n\npassive")
  expect(messages[0].customType).toBe("omo-senpi:wake")
  expect(messages[0].display).toBe(false)
  expect(done).toEqual(["new", "old", "passive"])
  expect(queue.childWorkCount()).toBe(0)
})

test("custody receipts preserve UTF16 ranges/held/missing semantics and falsy receipt errors", () => {
  const seen: string[] = []
  const entries: items.QueuedInjection[] = [
    {
      key: "one",
      itemId: "one",
      source: "task-completion",
      content: "界",
      customType: "a",
      contextScoped: true,
      superseded: [],
      onHeld: (receipt) => seen.push(receipt.entryId),
    },
    {
      key: "two",
      itemId: "two",
      source: "team-message",
      content: "👩‍💻",
      superseded: [],
      onDeliveryFailed: (error) => seen.push(String(error)),
    },
  ]
  const [batch] = items.admissionBatches(entries)
  expect(batch.items.map((item) => item.contentRange)).toEqual([
    [0, 1],
    [3, 8],
  ])
  expect(batch.message.details[0].contentRange).toEqual([0, 1])
  expect(
    items.settleItemReceipts(entries, [
      { itemId: "one", disposition: "notice_persisted", entryId: "real-unit-custody" },
    ]).threw,
  ).toBe(false)
  expect(seen[0]).toBe("real-unit-custody")
  expect(seen[1]).toContain("missing custody receipt for two")
  const calls: number[] = []
  const errors = receipts.runReceipts([1, 2, 3], (value) => {
    calls.push(value)
    if (value === 1) throw undefined
    if (value === 2) throw 0
  })
  expect(calls).toEqual([1, 2, 3])
  expect(errors.threw).toBe(true)
  expect(errors.first).toBeUndefined()
  expect(errors.rest).toEqual([0])
})

test("retire fails queued entries but does not join or cancel original delivery in flight", async () => {
  const delivery = Promise.withResolvers<unknown>(),
    events: string[] = []
  const queue = new coordinator.IdleInjectionCoordinator(() => delivery.promise)
  queue.enqueue({
    key: "inflight",
    source: "task-completion",
    content: "inflight",
    onFlushed: () => events.push("original delivered"),
  })
  expect(queue.flushOnIdle()).toBe(1)
  expect(queue.childWorkCount()).toBe(1)
  queue.enqueue({
    key: "queued",
    source: "team-message",
    content: "queued",
    onDeliveryFailed: (error) => {
      expect(error).toBeInstanceOf(oldCoordinator.IdleInjectionRetiredError)
      events.push("queued failed")
    },
  })
  expect(queue.retire()).toBeUndefined()
  expect(events).toEqual(["queued failed"])
  expect(queue.pendingCount()).toBe(0)
  expect(queue.childWorkCount()).toBe(1)
  expect(
    queue.enqueue({
      key: "refused",
      source: "task-completion",
      content: "refused",
      onDeliveryFailed: () => events.push("wrong refused receipt"),
    }),
  ).toBe(false)
  delivery.resolve(undefined)
  await Promise.resolve()
  expect(events).toEqual(["queued failed", "original delivered"])
  expect(queue.childWorkCount()).toBe(0)
})

test("async failure attempts every producer receipt and reports falsy errors without escaping", async () => {
  const delivery = Promise.withResolvers<void>(),
    failed: string[] = [],
    errors: unknown[] = []
  const queue = new coordinator.IdleInjectionCoordinator(() => delivery.promise, {
    onReceiptError: (error) => errors.push(error),
  })
  queue.enqueue({
    key: "first",
    source: "task-completion",
    content: "first",
    onDeliveryFailed() {
      failed.push("first")
      throw undefined
    },
  })
  queue.enqueue({
    key: "second",
    source: "team-message",
    content: "second",
    onDeliveryFailed() {
      failed.push("second")
      throw 0
    },
  })
  queue.flushOnIdle()
  delivery.reject(Error("actual controlled rejection"))
  await Promise.resolve()
  expect(failed).toEqual(["first", "second"])
  expect(errors).toEqual([undefined, 0])
  expect(queue.childWorkCount()).toBe(0)
})

test("fresh process executes shared coordinator/items/receipts without SDK/UI/adapter runtime", () => {
  const url = pathToFileURL(resolve(import.meta.dir, "../tools/task/operations.ts")).href
  const script = `
let forbidden=0;
Bun.plugin({name:"a6a-cold",setup(b){b.onResolve({filter:/^(@code-yeongyu\\/senpi|@earendil-works\\/pi-tui|@oh-my-opencode\\/omo-senpi)(\\/|$)/},a=>{forbidden++;throw Error("FORBIDDEN:"+a.path)});b.onLoad({filter:/[\\\\/]packages[\\\\/]omo-senpi[\\\\/]/},()=>{forbidden++;throw Error("FORBIDDEN_ADAPTER")})}});
const ops=await import(${JSON.stringify(url)});let receipts=0;
const queue=new ops.IdleInjectionCoordinator(()=>Promise.reject(Error("controlled rejection")));
queue.enqueue({key:"p",source:"kibitzer",passive:true,content:"p",onDeliveryFailed(){receipts++}});if(queue.flushOnIdle()!==0)throw Error("Passive woke");
queue.enqueue({key:"t",source:"task-completion",content:"old",onDeliveryFailed(){receipts++}});queue.enqueue({key:"t",source:"task-completion",content:"new",onDeliveryFailed(){receipts++}});if(queue.flushOnIdle()!==2)throw Error("Wrong collapse");await Promise.resolve();queue.retire();
let sync=0;const success=new ops.IdleInjectionCoordinator(()=>undefined);success.enqueue({key:"s",source:"team-message",content:"s",onFlushed(){sync++}});success.flushOnIdle();success.retire();
if(forbidden||receipts!==3||sync!==1||queue.childWorkCount()!==0)throw Error("Cold receipt execution failed");console.log(JSON.stringify({forbidden,receipts,sync}));`
  const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 5000 })
  expect(new TextDecoder().decode(child.stderr)).toBe("")
  expect(child.exitCode).toBe(0)
  expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({ forbidden: 0, receipts: 3, sync: 1 })
})
