import { expect, test } from "bun:test"
import { OmoTaskSettingsSchema } from "@oh-my-opencode/omo-config-core"
import { buildTaskExecute, runTaskSend, runTaskCancel, runTaskOutput } from "@oh-my-opencode/senpi-task/task-operations"
import type { NativeOperationOwner } from "./operation-ports"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { withNativeOperationService } from "./service.test"

test("fourth-owner parked send preserves Native refusal before explicit recovery", async () => {
  await withNativeOperationService(async f => {
    const root = f.raw()
    const started = await f.invoke(api => api.start({ category: "qa", prompt: "parked fourth-owner original", run_in_background: true }), root)
    const original = await f.invoke(api => api.wait(started.task_id), root)
    await f.reopen()
    const before = await f.invoke(api => Promise.resolve(api.get(started.task_id)), root)
    const transcriptDir = join(f.dir, "parent", "children", started.task_id, "sessions", started.task_id)
    mkdirSync(transcriptDir, { recursive: true })
    writeFileSync(join(transcriptDir, "available-native.jsonl"), '{"role":"assistant","content":"not external custody"}\n')
    const calls = [...f.calls]
    const result = await f.invoke(api => api.operation(async (_manager, _ancestry, _signal, owner) =>
      owner.runSend({ to: started.task_id, message: "parked fourth-owner fresh" })), root)
    expect(result.details.kind).toBe("not_continuable")
    expect(f.calls.filter(call => call === "create" || call === "prompt")).toEqual(calls.filter(call => call === "create" || call === "prompt"))
    const after = await f.invoke(api => Promise.resolve(api.get(started.task_id)), root)
    expect(after).toEqual(before)
    await f.invoke(api => api.recover(started.task_id), root)
    const resumed = await f.invoke(api => api.operation(async (_manager, _ancestry, _signal, owner) =>
      owner.runSend({ to: started.task_id, message: "parked fourth-owner fresh" })), root)
    expect(resumed.details.kind).toBe("revived")
    const done = await f.invoke(api => api.wait(started.task_id), root)
    expect(done.child_session_id).toBe(original.child_session_id)
    expect(done.notification.run_epoch).toBeGreaterThan(original.notification.run_epoch)
    expect(done.final_response).toBe("result:parked fourth-owner fresh")
    expect(f.calls.filter(call => call === "create")).toHaveLength(1)
    expect(f.calls.filter(call => call === "prompt")).toHaveLength(2)
  })
})

test.each(["birth", "epoch", "claim", "reference", "root", "parent", "residency"] as const)("stored send refuses %s drift before the original Native call", async field => {
  await withNativeOperationService(async f => {
    const root = f.raw()
    const started = await f.invoke(api => api.start({ category: "qa", prompt: "stored refusal fence", run_in_background: true }), root)
    await f.invoke(api => api.wait(started.task_id), root)
    await f.reopen()
    await f.invoke(api => Promise.resolve(api.get(started.task_id)), root)
    const path = join(f.dir, "parent", "tasks", started.task_id + ".json"), original = readFileSync(path, "utf8")
    const calls = [...f.calls]
    await f.invoke(api => api.operation(async (manager, _ancestry, _signal, owner) => {
      const originalSend = manager.sendToTask
      let nativeCalls = 0
      manager.sendToTask = (...args) => { nativeCalls++; return originalSend(...args) }
      try {
        const sending = owner.runSend({ to: started.task_id, message: "must not be dispatched" })
        const changed = JSON.parse(original)
        if (field === "birth") changed.created_at = "2026-01-01T00:00:00.000Z"
        if (field === "epoch") changed.notification.run_epoch++
        if (field === "claim") changed.residency_claim = "changed-stored-claim"
        if (field === "reference") changed.owned_session.generation++
        if (field === "root") changed.root_session_id = "foreign-root"
        if (field === "parent") changed.parent_session_id = "foreign-parent"
        if (field === "residency") changed.residency_state = "resident"
        replaceRecord(path, JSON.stringify(changed))
        await expect(sending).rejects.toThrow("Stored send refusal identity changed")
        expect(nativeCalls).toBe(0)
      } finally { manager.sendToTask = originalSend; replaceRecord(path, original) }
    }), root)
    expect(f.calls.filter(call => call === "create" || call === "prompt")).toEqual(calls.filter(call => call === "create" || call === "prompt"))
  })
})

test("a stored refusal issues no retained task receipt or future action", async () => {
  await withNativeOperationService(async f => {
    const root = f.raw()
    const started = await f.invoke(api => api.start({ category: "qa", prompt: "stored refusal has no grant", run_in_background: true }), root)
    await f.invoke(api => api.wait(started.task_id), root)
    await f.reopen()
    let retained!: NativeOperationOwner
    await f.invoke(api => api.operation(async (_manager, _ancestry, _signal, owner) => {
      retained = owner
      expect((await owner.runSend({ to: started.task_id, message: "stored refusal" })).details.kind).toBe("not_continuable")
      expect(() => owner.output.get(started.task_id)).toThrow("original owned membership")
      expect(() => owner.cancel.cancelTask(started.task_id)).toThrow("original owned membership")
    }), root)
    expect(() => retained.task.get(started.task_id)).toThrow()
    expect(() => retained.runSend({ to: started.task_id, message: "future unissued input" })).toThrow()
    expect(f.calls.filter(call => call === "create")).toHaveLength(1)
    expect(f.calls.filter(call => call === "prompt")).toHaveLength(1)
  })
})

test("stored send preserves an explicit Native stale epoch expectation", async () => {
  await withNativeOperationService(async f => {
    const root = f.raw()
    const started = await f.invoke(api => api.start({ category: "qa", prompt: "stored stale epoch", run_in_background: true }), root)
    const original = await f.invoke(api => api.wait(started.task_id), root)
    await f.reopen()
    await f.invoke(api => api.operation(async (manager, _ancestry, _signal, owner) => {
      const input = { idOrName: started.task_id, callerSessionId: root.caller.sessionID, message: "stale input", expectedRunEpoch: original.notification.run_epoch + 1 }
      const expected = await manager.sendToTask(input)
      expect(expected.kind).toBe("stale")
      expect(await owner.send.sendToTask(input)).toEqual(expected)
    }), root)
    expect(f.calls.filter(call => call === "create")).toHaveLength(1)
    expect(f.calls.filter(call => call === "prompt")).toHaveLength(1)
  })
})

test("four canonical Native operation bodies use the same manager through current issued owner", async () => {
  await withNativeOperationService(async f => {
    const origin = f.raw()
    let retained: NativeOperationOwner | undefined
    const started = await f.invoke((api, caller) => api.operation(async (manager, resolveAncestry, signal, owner) => {
      retained = owner
      expect(owner.source).toEqual({ sessionID: caller.sessionID, agent: caller.agent, messageID: caller.messageID, id: caller.id })
      if (!manager.concurrency) throw Error("Actual Native manager is missing its allocator")
      expect(owner.task.concurrency).not.toBe(manager.concurrency)
      expect(owner.task.concurrency?.getRetainedKeyCounts()).toEqual(manager.concurrency.getRetainedKeyCounts())
      expect(owner.reportProgress).toBeUndefined()
      let prepared = false
      const result = await buildTaskExecute({ manager: owner.task, agents: {}, omoConfig: { categories: { qa: { model: "qa/model" } }, task: OmoTaskSettingsSchema.parse({}) }, resolveAncestry,
        async prepareRuntime() { await f.ctx.model.list(); prepared = true }, loadSkills() { if (!prepared) throw Error("unprepared"); return { prepend: "", resolved: [], missing: [] } },
      })(caller.id, { category: "qa", prompt: "block", run_in_background: true }, signal, owner.reportProgress, { cwd: f.dir, sessionManager: { getSessionId: () => caller.sessionID } })
      expect(manager.get(result.details.task_id)?.task_id).toBe(result.details.task_id)
      return result
    }), origin)
    const id = started.details.task_id
    expect(defined(retained).task.get(id)?.task_id).toBe(id)
    expect(() => defined(retained).task.start({ parent_session_id: origin.caller.sessionID, depth: 1, prompt: "forbidden" })).toThrow()
    expect(() => defined(retained).send.sendToTask({ idOrName: id, message: "forbidden", deliverAs: "steer" })).toThrow()
    expect(() => defined(retained).task.waitFor(id)).toThrow()
    expect(() => defined(retained).cancel.cancelTask(id)).toThrow()
    const sent = await f.invoke((api, caller) => api.operation(async (_manager, _ancestry, signal, owner) =>
      runTaskSend(owner.send, { to: id, message: "block new input" }, caller.sessionID, undefined, { signal })), origin)
    expect(["steered", "queued"]).toContain(sent.details.kind)
    const output = await f.invoke((api, caller) => api.operation(async (_manager, _ancestry, _signal, owner) =>
      runTaskOutput({ manager: owner.output, stateDir: f.dir }, { task_id: id }, caller.sessionID)), origin)
    expect(output.details.snapshot.task_id).toBe(id)
    const cancelled = await f.invoke(api => api.operation(async (_manager, _ancestry, _signal, owner) =>
      runTaskCancel(owner.cancel, { task_id: id, reason: "canonical owned cancel" })), origin)
    expect(cancelled.details.kind).toBe("cancelled")
    expect(f.calls.filter(x => x === "create")).toHaveLength(1)
  })
})

test("reporter belongs to the exact current callback; genuine pending progress is joined", async () => {
  await withNativeOperationService(async f => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    const origin = f.raw(), raw = origin.caller
    const actual = { ...raw, progress: async () => { entered.resolve(); await gate.promise } }
    let owner!: NativeOperationOwner, returned = false
    const work = f.invoke((api, caller) => api.operation(async (_m, _a, _s, issued) => {
      owner = issued; issued.reportProgress?.({}); return "canonical-result"
    }, { progress: caller.progress }), { ...origin, caller: actual }).then(value => { returned = true; return value })
    await entered.promise
    await Promise.resolve()
    expect(returned).toBe(false)
    expect(owner.diagnostics().progressPending).toBe(1)
    gate.resolve(); expect(await work).toBe("canonical-result")
    expect(owner.diagnostics().progressPending).toBe(0)
    expect(owner.diagnostics().live).toBe(false)
    await expect(f.invoke(api => api.operation(async () => null, { progress: async () => {} }), origin)).rejects.toThrow("Foreign Native operation reporter")
  })
})

test("rejected genuine progress is recorded and cannot replace Native completion", async () => {
  await withNativeOperationService(async f => {
    const origin = f.raw(), caller = { ...origin.caller, progress: async () => { throw Error("controlled progress transport rejection") } }
    let owner!: NativeOperationOwner
    const result = await f.invoke((api, current) => api.operation(async (_m, _a, _s, issued) => {
      owner = issued; issued.reportProgress?.({}); return "actual Native completed result"
    }, { progress: current.progress }), { ...origin, caller })
    expect(result).toBe("actual Native completed result")
    expect(owner.diagnostics().progressErrors).toHaveLength(1)
  })
})

test("accepted private send survives report abort and frame close, then settles exactly once", async () => {
  await withNativeOperationService(async f => {
    const root = f.raw(), started = await f.invoke(api => api.start({ category: "qa", prompt: "block" }), root)
    f.holdInput()
    const reportAbort = new AbortController(), late = Promise.withResolvers<unknown>()
    const reporting = f.invoke((api, caller) => api.operation(async (_m, _a, _s, owner) =>
      runTaskSend(owner.send, { to: started.task_id, message: "block accepted original send" }, caller.sessionID, undefined,
        { signal: reportAbort.signal, deliverLateOutcome(result) { late.resolve(result) } })), root)
    await f.inputEntered
    reportAbort.abort(Error("reporting only stopped"))
    const reported = await reporting
    expect(reported.details.kind).toBe("delivering")
    expect(reported.details.reason).toBe("aborted")
    expect(f.calls.filter(x => x === "prompt")).toHaveLength(2)
    f.releaseInput()
    const result = await late.promise as { details: { kind: string } }
    expect(["steered", "queued"]).toContain(result.details.kind)
    expect(f.calls.filter(x => x === "prompt")).toHaveLength(2)
    await f.invoke(api => api.end(started.task_id), root)
  })
})

test.each(["journal-forward", "journal-rollback", "owner", "epoch", "claim", "root", "parent", "depth"])("accepted receipt refuses raw valid-record %s edit without a host side effect", async mutation => {
  await withNativeOperationService(async f => {
    const root = f.raw(); let owner!: NativeOperationOwner
    const started = await f.invoke(api => api.operation(async (_m, _a, _s, issued) => { owner = issued; return issued.task.start({ parent_session_id: root.caller.sessionID, root_session_id: root.caller.sessionID, depth: 1, category: "qa", prompt: "block" }) }), root)
    const path = join(f.dir, "parent", "tasks", started.task_id + ".json"), original = readFileSync(path, "utf8"), row = JSON.parse(original)
    const baseline = [...f.calls]
    if (mutation === "journal-forward") row.owned_session.journalRevision += 2
    if (mutation === "journal-rollback") row.owned_session.journalRevision -= 1
    if (mutation === "owner") row.owned_session.journalOwner += ":foreign"
    if (mutation === "epoch") { row.notification.run_epoch++; row.owned_session.runEpoch++ }
    if (mutation === "claim") { row.residency_claim += ":foreign"; row.owned_session.residencyClaim = row.residency_claim }
    if (mutation === "root") row.root_session_id = "foreign"
    if (mutation === "parent") { row.parent_session_id = "foreign"; row.owned_session.parentID = "foreign" }
    if (mutation === "depth") row.depth++
    try { replaceRecord(path, JSON.stringify(row)); expect(() => owner.task.get(started.task_id)).toThrow(); expect(f.calls).toEqual(baseline) }
    finally { replaceRecord(path, original) }
    expect(owner.task.get(started.task_id)?.task_id).toBe(started.task_id)
    await f.invoke(api => api.end(started.task_id), root)
  })
})

test("genuine same-backend revision progress preserves an original receipt and queued owner grant", async () => {
  await withNativeOperationService(async f => {
    f.setConcurrency(1)
    const root = f.raw(); let rootOwner!: NativeOperationOwner
    const parent = await f.invoke(api => api.operation(async (_m, _a, _s, owner) => { rootOwner = owner; return owner.task.start({ parent_session_id: root.caller.sessionID, depth: 1, category: "qa", prompt: "block parent" }) }), root)
    const before = defined(rootOwner.task.get(parent.task_id))
    const child = { caller: { ...root.caller, sessionID: before.child_session_id, id: "current-child", messageID: "current-child-message" } as ToolContext, controller: root.controller }
    let queuedOwner!: NativeOperationOwner
    const queued = await f.invoke(api => api.operation(async (_m, _a, _s, owner) => { queuedOwner = owner; return owner.task.start({ parent_session_id: child.caller.sessionID, root_session_id: root.caller.sessionID, depth: 2, category: "qa", prompt: "original queued descendant", run_in_background: true }) }), child)
    expect(queued.status).toBe("pending")
    await f.invoke(api => api.send({ idOrName: parent.task_id, message: "block own backend progress" }), root)
    const after = defined(rootOwner.task.get(parent.task_id))
    expect(defined(after.owned_session).journalRevision).toBe(defined(before.owned_session).journalRevision + 2)
    await f.invoke(api => api.operation(async (manager, _a, _s, owner) => {
      const token = defined(owner.task.concurrency).park(parent.task_id, after.notification.run_epoch)
      expect(token).toBeDefined()
      expect(() => defined(owner.task.concurrency).park(queued.task_id, 0)).toThrow()
      try { return await owner.task.waitFor(queued.task_id) } finally {
        await defined(owner.task.concurrency).unpark(token, undefined, { overflow: true })
        expect(() => defined(owner.task.concurrency).unpark(token)).toThrow()
      }
    }), child)
    expect(queuedOwner.task.get(queued.task_id)?.status).toBe("completed")
    expect(f.calls.filter(x => x === "create")).toHaveLength(2)
    await f.invoke(api => api.end(parent.task_id), root)
  })
})

test("sync body throw joins already-started genuine progress and preserves the original error", async () => {
  await withNativeOperationService(async f => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), origin = f.raw()
    const caller = { ...origin.caller, progress: async () => { entered.resolve(); await gate.promise } }
    const original = Error("original synchronous Native composition failure")
    let settled = false
    const work = f.invoke((api, current) => api.operation((_m, _a, _s, owner) => {
      owner.reportProgress?.({}); throw original
    }, { progress: current.progress }), { ...origin, caller }).catch(error => { settled = true; return error })
    await entered.promise; await Promise.resolve()
    expect(settled).toBe(false)
    gate.resolve(); expect(await work).toBe(original)
  })
})

test("retirement stays pending on genuine uncancellable progress and does not retire the lease early", async () => {
  await withNativeOperationService(async f => {
    const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), origin = f.raw()
    const caller = { ...origin.caller, progress: async () => { entered.resolve(); await gate.promise } }
    const work = f.invoke((api, current) => api.operation(async (_m, _a, _s, owner) => { owner.reportProgress?.({}); return "completed" }, { progress: current.progress }), { ...origin, caller }).catch(error => error)
    await entered.promise
    const lease = f.leases[0] as Parameters<typeof f.service.retire>[0]
    let retired = false
    const closing = f.service.retire(lease).then(() => { retired = true })
    await Promise.resolve(); await Promise.resolve()
    expect(retired).toBe(false); expect(lease.signal.aborted).toBe(false)
    gate.resolve(); await work; await closing
    expect(retired).toBe(true); expect(lease.signal.aborted).toBe(true)
  })
})

test("missing and hidden targets are scoped refusals with zero Native mutation calls", async () => {
  await withNativeOperationService(async f => {
    const root = f.raw(), foreign = f.raw("foreign-root")
    const own = await f.invoke(api => api.start({ category: "qa", prompt: "block own", name: "OWN_VISIBLE" }), root)
    const other = await f.invoke(api => api.start({ category: "qa", prompt: "block foreign", name: "FOREIGN_SECRET_NAME" }), foreign)
    let nativeSends = 0, nativeCancels = 0
    await f.invoke((api, caller) => api.operation(async (manager, _a, _s, owner) => {
      const originalSend = manager.sendToTask, originalCancel = manager.cancelTask
      expect(Reflect.set(manager, "sendToTask", new Proxy(originalSend, { apply(target, receiver, args) { nativeSends++; return Reflect.apply(target, receiver, args) } }))).toBe(true)
      expect(Reflect.set(manager, "cancelTask", new Proxy(originalCancel, { apply(target, receiver, args) { nativeCancels++; return Reflect.apply(target, receiver, args) } }))).toBe(true)
      const calls = [...f.calls]
      try {
        for (const target of ["genuinely-missing", other.task_id, "FOREIGN_SECRET_NAME"]) {
          const send = await runTaskSend(owner.send, { to: target, message: "never dispatched" }, caller.sessionID)
          expect(send.details.kind).toBe("not_found")
          if (send.details.kind !== "not_found") throw Error("not scoped refusal")
          expect(send.details.known_tasks).toEqual(["OWN_VISIBLE"])
          const cancel = await runTaskCancel(owner.cancel, { task_id: target })
          expect(cancel.details.kind).toBe("not_found")
        }
        expect(nativeSends).toBe(0); expect(nativeCancels).toBe(0); expect(f.calls).toEqual(calls)
        expect(owner.task.get(own.task_id)?.task_id).toBe(own.task_id)
      } finally { Reflect.set(manager, "sendToTask", originalSend); Reflect.set(manager, "cancelTask", originalCancel) }
      return null
    }), root)
  })
})

test("canonical late not_found reads current names only within the original scope after callback closure", async () => {
  await withNativeOperationService(async f => {
    const root = f.raw(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), late = Promise.withResolvers<unknown>(), reportAbort = new AbortController()
    await f.invoke(api => api.start({ category: "qa", prompt: "block", name: "ORIGINAL_OWN" }), root)
    let owner!: NativeOperationOwner
    const reporting = f.invoke((api, caller) => api.operation(async (_m, _a, _s, issued) => {
      owner = issued
      // Fixture delays the ORIGINAL nonmutating scope refusal, not an SDK ACK.
      const delayed = new Proxy(issued.send, { get(target, key, receiver) {
        const original = Reflect.get(target, key, receiver)
        if (key !== "sendToTask") return original
        return new Proxy(original, { apply(method, thisArg, args) {
          const work: ReturnType<typeof target.sendToTask> = Reflect.apply(method, thisArg, args)
          return work.then(async result => { entered.resolve(); await gate.promise; return result })
        } })
      } })
      return runTaskSend(delayed, { to: "missing-original", message: "no transport" }, caller.sessionID, undefined,
        { signal: reportAbort.signal, deliverLateOutcome(result) { late.resolve(result) } })
    }), root)
    await entered.promise; reportAbort.abort(Error("stop report only"))
    expect((await reporting).details.kind).toBe("delivering")
    expect(owner.diagnostics().live).toBe(false)
    const newer = await f.invoke(api => api.start({ category: "qa", prompt: "block", name: "LATER_OWN_CURRENT_SCOPE" }), root)
    const foreign = f.raw("foreign-late-format-root")
    await f.invoke(api => api.start({ category: "qa", prompt: "block foreign", name: "FOREIGN_LATE_SECRET" }), foreign)
    expect(() => owner.task.get(newer.task_id)).toThrow()
    gate.resolve()
    const result = await late.promise as { details: { kind: string; known_tasks: string[] } }
    expect(result.details.kind).toBe("not_found")
    expect(result.details.known_tasks).toEqual(["ORIGINAL_OWN", "LATER_OWN_CURRENT_SCOPE"])
  })
})

test.each([false, true])("canonical Native foreground updates keep all fields despite reporter rejection=%s", async rejectProgress => {
  await withNativeOperationService(async f => {
    const root = f.raw(), metadata: Parameters<ToolContext["progress"]>[0][] = []
    const caller = { ...root.caller, progress: async (update: Parameters<ToolContext["progress"]>[0]) => { metadata.push(update); if (rejectProgress) throw Error("actual progress transport rejected") } }
    const result = await f.invoke((api, current) => api.operation(async (_m, resolveAncestry, signal, owner) => {
      return buildTaskExecute({ manager: owner.task, agents: {}, omoConfig: { categories: { qa: { model: "qa/model" } }, task: OmoTaskSettingsSchema.parse({}) }, resolveAncestry,
        async prepareRuntime() { await f.ctx.model.list() }, loadSkills() { return { prepend: "", resolved: [], missing: [] } },
      })(current.id, { category: "qa", prompt: "canonical progress", run_in_background: false }, signal,
        update => owner.reportProgress?.({ nativeTaskUpdate: update }), { cwd: f.dir, sessionManager: { getSessionId: () => current.sessionID } })
    }, { progress: current.progress }), { ...root, caller })
    expect(result.details.status).toBe("completed")
    expect(metadata.length).toBeGreaterThan(0)
    for (const item of metadata) { expect(item.nativeTaskUpdate.content).toBeArray(); expect(item.nativeTaskUpdate.details).toBeDefined() }
  })
})

test("persistent original unsubscribe failure retains retirement custody and retries the same resource", async () => {
  await withNativeOperationService(async f => {
    const root = f.raw(), started = await f.invoke(api => api.start({ category: "qa", prompt: "block" }), root)
    let held = true, attempts = 0, actualDisposals = 0
    await f.invoke(api => api.operation(async (manager, _a, _s, owner) => {
      const original = manager.subscribeChild
      expect(Reflect.set(manager, "subscribeChild", new Proxy(original, { apply(target, receiver, args) {
        const dispose: () => void = Reflect.apply(target, receiver, args)
        return () => { attempts++; if (held) throw Error("fixture persistent pre-original unsubscribe failure"); dispose(); actualDisposals++ }
      } }))).toBe(true)
      try { owner.task.subscribeChild(started.task_id, () => {}) } finally { Reflect.set(manager, "subscribeChild", original) }
      return null
    }), root)
    const lease = f.leases[0] as Parameters<typeof f.service.retire>[0]
    await expect(f.service.retire(lease)).rejects.toThrow()
    expect(attempts).toBeGreaterThanOrEqual(1); expect(actualDisposals).toBe(0); expect(lease.signal.aborted).toBe(false)
    held = false; await f.service.retire(lease)
    expect(actualDisposals).toBe(1); expect(lease.signal.aborted).toBe(true)
    await f.service.retire(lease); expect(actualDisposals).toBe(1)
  })
})

test("same-tree root ID access stays Native-compatible while sibling name collisions stay scoped", async () => {
  await withNativeOperationService(async f => {
    const root = f.raw(), a = await f.invoke(api => api.start({ category: "qa", prompt: "block A", name: "DIRECT_PRIORITY" }), root), b = await f.invoke(api => api.start({ category: "qa", prompt: "block B" }), root)
    const ar = await f.invoke(api => Promise.resolve(api.get(a.task_id)), root), br = await f.invoke(api => Promise.resolve(api.get(b.task_id)), root)
    const childA = { ...root, caller: { ...root.caller, sessionID: ar.child_session_id } as ToolContext }, childB = { ...root, caller: { ...root.caller, sessionID: br.child_session_id } as ToolContext }
    const own = await f.invoke(api => api.start({ category: "qa", prompt: "block A child", name: "COLLISION" }), childA), sibling = await f.invoke(api => api.start({ category: "qa", prompt: "block B child", name: "COLLISION" }), childB)
    await f.invoke(api => api.start({ category: "qa", prompt: "block duplicate descendant", name: "DIRECT_PRIORITY" }), childA)
    const preferred = await f.invoke((api, caller) => api.operation(async (_m, _a, _s, owner) => runTaskSend(owner.send, { to: "DIRECT_PRIORITY", message: "block direct priority" }, caller.sessionID)), root)
    expect(preferred.details.task_id).toBe(a.task_id)
    const denied = await f.invoke((api, caller) => api.operation(async (_m, _a, _s, owner) => runTaskSend(owner.send, { to: sibling.task_id, message: "no sibling dispatch" }, caller.sessionID)), childA)
    expect(denied.details.kind).toBe("not_found")
    const byName = await f.invoke((api, caller) => api.operation(async (_m, _a, _s, owner) => runTaskSend(owner.send, { to: "COLLISION", message: "block own collision" }, caller.sessionID)), childA)
    expect(byName.details.task_id).toBe(own.task_id)
    const byRootID = await f.invoke((api, caller) => api.operation(async (_m, _a, _s, owner) => runTaskSend(owner.send, { to: own.task_id, message: "block root descendant" }, caller.sessionID)), root)
    expect(byRootID.details.task_id).toBe(own.task_id)
    await expect(f.invoke((api, caller) => api.operation(async (_m, _a, _s, owner) => runTaskSend(owner.send, { to: "COLLISION", message: "ambiguous root name" }, caller.sessionID)), root)).rejects.toThrow("Ambiguous")
  })
})

test("retirement stops an original signal-less Native waiter before joining its callback body", async () => {
  await withNativeOperationService(async f => {
    const root = f.raw(), started = Promise.withResolvers<void>()
    const waiting = f.invoke(api => api.operation(async (_m, _a, _s, owner) => {
      const result = await owner.task.start({ parent_session_id: root.caller.sessionID, depth: 1, category: "qa", prompt: "block original wait" })
      if (result.kind !== "started") throw Error("start failed")
      const work = owner.task.waitFor(result.task_id)
      started.resolve(); return work
    }), root).catch(error => error)
    await started.promise
    const lease = f.leases[0] as Parameters<typeof f.service.retire>[0]
    await f.service.retire(lease)
    expect(await waiting).toBeInstanceOf(Error)
    expect(lease.signal.aborted).toBe(true)
    expect(f.calls.filter(call => call === "create")).toHaveLength(1)
  })
})

test.each([false, true])("canonical accepted start result delayed across raw abort preserves foreground cleanup/background=%s", async background => {
  await withNativeOperationService(async f => {
    const root = f.raw(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    let nativeBody!: Promise<unknown>, owner!: NativeOperationOwner, taskID = ""
    const outer = f.invoke((api, caller) => api.operation(async (_manager, ancestry, signal, issued) => {
      owner = issued
      const delayed = new Proxy(owner.task, { get(target, key, receiver) {
        const original = Reflect.get(target, key, receiver)
        if (key !== "start") return original
        return new Proxy(original, { apply(method, thisArg, args) {
          const actual: ReturnType<typeof target.start> = Reflect.apply(method, thisArg, args)
          return actual.then(async result => {
            if (result.kind !== "started") throw Error("actual admission failed")
            taskID = result.task_id; entered.resolve(); await release.promise; return result
          })
        } })
      } })
      nativeBody = buildTaskExecute({ manager: delayed, agents: {}, omoConfig: { categories: { qa: { model: "qa/model" } }, task: OmoTaskSettingsSchema.parse({}) }, resolveAncestry: ancestry,
        async prepareRuntime() { await f.ctx.model.list() }, loadSkills() { return { prepend: "", resolved: [], missing: [] } },
      })(caller.id, { category: "qa", prompt: "block actual accepted foreground", run_in_background: background }, signal, undefined, { cwd: f.dir, sessionManager: { getSessionId: () => caller.sessionID } })
      return nativeBody
    }), root).catch(error => error)
    await entered.promise
    expect(f.calls.filter(call => call === "prompt")).toHaveLength(1)
    root.controller.abort(Error("actual raw caller aborted after Native acceptance"))
    await outer
    release.resolve()
    const outcome = await nativeBody.catch(error => error)
    expect(outcome).not.toBeInstanceOf(Error)
    const record = defined(owner.task.get(taskID))
    expect(record.status).toBe(background ? "running" : "cancelled")
    expect(f.blocked.has(defined(record.child_session_id))).toBe(background)
  })
})

test("retirement joins the canonical late-delivery callback promise rather than only its manager outcome", async () => {
  await withNativeOperationService(async f => {
    const root = f.raw(), start = await f.invoke(api => api.start({ category: "qa", prompt: "block accepted send" }), root)
    f.holdInput()
    const reportAbort = new AbortController(), deliveryEntered = Promise.withResolvers<void>(), releaseDelivery = Promise.withResolvers<void>(), order: string[] = []
    let deliveryWork: Promise<void> | undefined
    const reporting = f.invoke((api, _caller) => api.operation(async (_m, _a, _s, owner) => owner.runSend(
      { to: start.task_id, message: "block original late delivery" }, {
        signal: reportAbort.signal,
        deliverLateOutcome() {
          deliveryWork = (async () => { deliveryEntered.resolve(); await releaseDelivery.promise; order.push("original-late-work-joined") })()
          return deliveryWork
        },
      })), root)
    await f.inputEntered; reportAbort.abort(Error("report ends but original send continues"))
    expect((await reporting).details.kind).toBe("delivering")
    f.releaseInput(); await deliveryEntered.promise
    const lease = f.leases[0] as Parameters<typeof f.service.retire>[0]
    const closing = f.service.retire(lease).then(() => { order.push("retirement-complete") })
    // The gate remains genuinely pending; this bounded window exposes the current
    // missing Native work-observer contract, not a fabricated transport outcome.
    await Promise.race([closing, Bun.sleep(200)])
    releaseDelivery.resolve(); await deliveryWork; await closing
    expect(order).toEqual(["original-late-work-joined", "retirement-complete"])
  })
})

test("settled late callback failure is reported once and retained after resource-only retry without replay", async () => {
  await withNativeOperationService(async f => {
    const root = f.raw(), start = await f.invoke(api => api.start({ category: "qa", prompt: "block original late failure" }), root)
    f.holdInput()
    const reportAbort = new AbortController(), entered = Promise.withResolvers<void>()
    let owner!: NativeOperationOwner, callbacks = 0
    const reporting = f.invoke(api => api.operation(async (_m, _a, _s, issued) => {
      owner = issued
      return owner.runSend({ to: start.task_id, message: "block once" }, {
        signal: reportAbort.signal,
        deliverLateOutcome() { callbacks++; entered.resolve(); throw Error("fixture original late callback failed") },
      })
    }), root)
    await f.inputEntered; reportAbort.abort(Error("report only ends"))
    expect((await reporting).details.kind).toBe("delivering")
    f.releaseInput(); await entered.promise
    const lease = f.leases[0] as Parameters<typeof f.service.retire>[0]
    const failure = await f.service.retire(lease).then(() => null, error => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(lease.signal.aborted).toBe(false)
    const history = owner.diagnostics().sendFailures
    expect(history).toHaveLength(1)
    expect(history[0].phase).toBe("late")
    expect(history[0].source.sessionID).toBe(root.caller.sessionID)
    expect(history[0].reason).toBe("fixture original late callback failed")
    expect(JSON.parse(defined(history[0].originalOutcomeJSON)).result.details.task_id).toBe(start.task_id)
    expect(Object.isFrozen(history[0])).toBe(true)
    await f.service.retire(lease)
    expect(lease.signal.aborted).toBe(true)
    expect(owner.diagnostics().sendFailures).toEqual(history)
    expect(callbacks).toBe(1); expect(f.calls.filter(call => call === "prompt")).toHaveLength(2)
  })
})


// Raw edits replace the record the way the store's writer does (atomic rename, a new inode), so a
// same-length edit or restore inside one coarse mtime tick is still observed (record-store.ts #10708).
function replaceRecord(path: string, body: string): void { const staged = `${path}.edit-${process.pid}`; writeFileSync(staged, body); renameSync(staged, path) }
function defined<T>(value: T | null | undefined): T { if (value === undefined || value === null) throw new Error("expected a defined value"); return value }
