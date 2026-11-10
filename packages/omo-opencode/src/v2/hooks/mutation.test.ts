import { afterEach, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import { createMutationHooks, MutationHookFailure, type MutationHookOptions, type MutationReport } from "./mutation"

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}

const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() { const root = mkdtempSync(join(tmpdir(), "omo-mutation-unit-")); directories.push(root); return root }
function deferred<T = void>() { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function caller(id: string, controller = new AbortController(), progress: ToolContext["progress"] = async () => {}) {
  return { caller: { id, sessionID: "session-" + id, messageID: "message-" + id, agent: "build", signal: controller.signal, progress } as ToolContext, controller }
}
function host(name: string, execute: Info["execute"]) {
  type Entry = { -readonly [K in keyof Info]: Info[K] } & { id: string }
  const tool: Entry = { id: name, name, description: "Fixture actual callback", input: z.any(), execute }
  let callback: ((editor: ToolEditor) => void) | undefined
  let registrations = 0, removals = 0
  const editor: ToolEditor = {
    list: () => [tool], get: () => tool, update: (_, edit) => { edit(tool) },
    add: () => { throw Error("Unexpected add") }, remove: () => {}, namespace: () => {},
  }
  return {
    tool, replay: () => defined(callback)(editor), counts: () => ({ registrations, removals }),
    context: { tool: { transform: async (transform: (editor: ToolEditor) => void) => {
      registrations++; callback = transform; transform(editor)
      return { dispose: async () => { removals++ } }
    } } },
  }
}
function options(directory: string, overrides: Partial<MutationHookOptions> = {}) {
  const reports: MutationReport[] = [], calls: string[] = []
  const base: MutationHookOptions = {
    directory, authorize: async (ctx) => { calls.push("authorize:" + ctx.id) },
    format: async (_, ctx) => { calls.push("format:" + ctx.id); return {} },
    diagnostics: async (_, ctx) => { calls.push("diagnostics:" + ctx.id); return { source: ctx.id } },
    report: (report) => { reports.push(report) }, ...overrides,
  }
  return { ...base, reports, calls }
}

it("normalizes actual patchText, locks add/update/move/delete, and formats surviving files before diagnostics", async () => {
  const root = fixture(), old = join(root, "old.go"), removed = join(root, "removed.go"), added = join(root, "added.go"), moved = join(root, "moved.go")
  writeFileSync(old, "old"); writeFileSync(removed, "removed")
  const input = { patchText: "*** Begin Patch\n*** Add File: added.go\n+added\n*** Update File: old.go\n*** Move to: moved.go\n@@\n-old\n+new\n*** Delete File: removed.go\n*** End Patch" }
  const result = { content: "ORIGINAL_RESULT", metadata: { original: true } }
  const stages: string[] = [], identity = caller("one"), progress: unknown[] = []
  identity.caller = { ...identity.caller, progress: async update => { progress.push(update) } }
  const source = host("patch", async (actualInput, ctx) => {
    expect(actualInput).toBe(input); expect(ctx.id).toBe(identity.caller.id); expect(ctx.sessionID).toBe(identity.caller.sessionID)
    expect(Object.isFrozen(ctx)).toBe(true); await ctx.progress({ title: "actual-progress" })
    stages.push("mutate"); writeFileSync(added, "added"); renameSync(old, moved); unlinkSync(removed)
    return result
  })
  const ports = options(root, {
    authorize: (ctx, op) => { expect(ctx.id).toBe(identity.caller.id); expect(op.paths).toEqual([added, moved, old, removed].sort()); stages.push("authorize") },
    format: async (request, ctx) => {
      expect(ctx.id).toBe(identity.caller.id); expect(request.event).toEqual({ toolName: "apply_patch", input: { input: input.patchText } })
      expect(request.files).toEqual([added, moved].sort()); stages.push("format"); writeFileSync(added, "formatted")
      return { content: [{ type: "text", text: "formatter notice" }] }
    },
    diagnostics: async (file, ctx) => { expect(ctx.id).toBe(identity.caller.id); expect(readFileSync(added, "utf8")).toBe("formatted"); stages.push("diagnostics"); return { file } },
  })
  const hooks = createMutationHooks(ports), cleanup = await hooks.register(source.context)
  expect(await source.tool.execute(input, identity.caller)).toBe(result)
  expect(stages).toEqual(["authorize", "mutate", "format", "diagnostics", "diagnostics"])
  expect(progress).toEqual([{ title: "actual-progress" }])
  expect(ports.reports[0]).toMatchObject({ status: "processed", committed: true, deleted: [old, removed] })
  await cleanup()
})

it("preserves original errors and returned errors without postprocessing", async () => {
  const root = fixture(), denied = new Error("ORIGINAL_APPROVAL_REJECTION"), original = host("write", async () => { throw denied })
  const ports = options(root), hooks = createMutationHooks(ports)
  await hooks.register(original.context)
  await expect(original.tool.execute({ path: "a.go", content: "x" }, caller("one").caller)).rejects.toBe(denied)
  expect(ports.calls).toEqual(["authorize:one"]); expect(ports.reports).toEqual([])
  await hooks.dispose()
  const result = { content: "partial failure", metadata: { isError: true } }, second = host("edit", async () => result), secondHooks = createMutationHooks(ports)
  await secondHooks.register(second.context)
  expect(await second.tool.execute({ filePath: "a.go", oldString: "x", newString: "y" }, caller("two").caller)).toBe(result)
  expect(ports.reports.at(-1)).toMatchObject({ reason: "host_returned_error", committed: "unknown" })
  expect(ports.calls).toEqual(["authorize:one", "authorize:two"])
  await secondHooks.dispose()
})

it("preserves host-allowed outside/unknown mutations while reporting skipped automatic processing", async () => {
  const root = fixture(), external = fixture(); let mutations = 0
  const source = host("write", async () => { mutations++; return { content: "host-allowed" } })
  const ports = options(root), hooks = createMutationHooks(ports); await hooks.register(source.context)
  await source.tool.execute({ path: join(external, "outside.go"), content: "x" }, caller("external").caller)
  await source.tool.execute({ unsupportedPath: "unknown" }, caller("unknown").caller)
  expect(mutations).toBe(2); expect(ports.calls).toEqual([])
  expect(ports.reports.map(report => report.reason)).toEqual(["outside_owned_location", "unknown_mutation_paths"])
  await hooks.dispose()
})

it("serializes mutation through diagnostics per file while separate files proceed and callers keep distinct outcomes", async () => {
  const root = fixture(), a = join(root, "a.go"), b = join(root, "b.go"); writeFileSync(a, "a"); writeFileSync(b, "b")
  const entered = deferred(), release = deferred(), stages: string[] = []
  const source = host("write", async (_, ctx) => { stages.push("mutate:" + ctx.id); return { content: ctx.id } })
  const ports = options(root, { format: async (_, ctx) => { stages.push("format:" + ctx.id); if (ctx.id === "first") { entered.resolve(); await release.promise }; return { content: ctx.id } }, diagnostics: async (_, ctx) => { stages.push("diagnostics:" + ctx.id); return ctx.id } })
  const hooks = createMutationHooks(ports); await hooks.register(source.context)
  const first = source.tool.execute({ path: a }, caller("first").caller); await entered.promise
  const second = source.tool.execute({ path: a }, caller("second").caller)
  expect(await source.tool.execute({ path: b }, caller("independent").caller)).toEqual({ content: "independent" })
  expect(stages).not.toContain("mutate:second")
  release.resolve(); expect(await first).toEqual({ content: "first" }); expect(await second).toEqual({ content: "second" })
  expect(stages.indexOf("mutate:second")).toBeGreaterThan(stages.indexOf("diagnostics:first"))
  expect(ports.calls).toEqual(["authorize:first", "authorize:independent", "authorize:second"])
  await hooks.dispose()
})

it("handles opposing multipath order without deadlock and does not share authorization", async () => {
  const root = fixture(); writeFileSync(join(root, "a.go"), "a"); writeFileSync(join(root, "b.go"), "b")
  const entered = deferred(), release = deferred(), denied = new Error("SECOND_CALLER_DENIED"); let mutations = 0
  const ports = options(root, { authorize: (ctx) => { if (ctx.id === "second") throw denied }, format: async () => { entered.resolve(); await release.promise; return {} } })
  const source = host("patch", async () => { mutations++; return { content: "patched" } }), hooks = createMutationHooks(ports); await hooks.register(source.context)
  const patch = (paths: string[]) => ({ patchText: "*** Begin Patch\n" + paths.map(path => "*** Update File: " + path + "\n@@\n-a\n+b").join("\n") + "\n*** End Patch" })
  const first = source.tool.execute(patch(["a.go", "b.go"]), caller("first").caller); await entered.promise
  const second = source.tool.execute(patch(["b.go", "a.go"]), caller("second").caller).catch(error => error)
  release.resolve(); await first; expect(await second).toBe(denied); expect(mutations).toBe(1); await hooks.dispose()
})

it("aborts queued callers before their callback and rejects mutable input after an authorization wait", async () => {
  const root = fixture(); writeFileSync(join(root, "a.go"), "a")
  const entered = deferred(), release = deferred(), stopped = caller("queued"), reason = new Error("USER_ABORT"); let mutations = 0
  const source = host("write", async () => { mutations++; return { content: "written" } })
  const ports = options(root, { format: async () => { entered.resolve(); await release.promise; return {} } }), hooks = createMutationHooks(ports); await hooks.register(source.context)
  const first = source.tool.execute({ path: "a.go" }, caller("first").caller); await entered.promise
  const queued = source.tool.execute({ path: "a.go" }, stopped.caller).catch(error => error)
  queueMicrotask(() => stopped.controller.abort(reason)); expect(await queued).toBe(reason); expect(mutations).toBe(1)
  release.resolve(); await first; await hooks.dispose()
  const authorizeEntered = deferred(), authorizeRelease = deferred(), input = { path: "a.go" }
  const other = host("write", async () => { mutations++; return {} }), otherHooks = createMutationHooks(options(root, { authorize: async () => { authorizeEntered.resolve(); await authorizeRelease.promise } }))
  await otherHooks.register(other.context); const changed = other.tool.execute(input, caller("changed").caller).catch(error => error)
  await authorizeEntered.promise; input.path = "b.go"; authorizeRelease.resolve(); expect(await changed).toBeInstanceOf(MutationHookFailure); expect(mutations).toBe(1); await otherHooks.dispose()
})

it("reports committed mutation facts and rethrows the identical formatter denial even when reporting fails", async () => {
  const root = fixture(), file = join(root, "a.go"), denial = new Error("FORMATTER_SHELL_DENIED"); let report: MutationReport | undefined, diagnosticCalls = 0
  const source = host("write", async () => { writeFileSync(file, "committed"); return { content: "written" } })
  const hooks = createMutationHooks(options(root, { format: async () => { throw denial }, diagnostics: async () => { diagnosticCalls++; return {} }, report: value => { report = value; throw Error("observer failed") } }))
  await hooks.register(source.context); await expect(source.tool.execute({ filePath: file, content: "committed" }, caller("one").caller)).rejects.toBe(denial)
  expect(readFileSync(file, "utf8")).toBe("committed"); expect(diagnosticCalls).toBe(0)
  expect(report).toMatchObject({ status: "postprocess-error", committed: true, phase: "format", error: denial }); await hooks.dispose()
})

it("deduplicates replay/register, aborts genuine-derived active signals, joins work and fences old wrappers", async () => {
  const root = fixture(), entered = deferred(), exited = deferred(); let mutations = 0
  const actual = caller("active")
  const source = host("edit", async (_, ctx) => {
    mutations++; expect(ctx.signal).not.toBe(actual.caller.signal); expect(ctx.sessionID).toBe(actual.caller.sessionID)
    entered.resolve()
    await new Promise<void>((_, reject) => { ctx.signal.addEventListener("abort", () => { exited.resolve(); reject(ctx.signal.reason) }, { once: true }) })
    return { content: "never" }
  })
  const hooks = createMutationHooks(options(root)), dispose = await hooks.register(source.context)
  expect(await hooks.register(source.context)).toBe(dispose); const wrapper = source.tool.execute; source.replay(); expect(source.tool.execute).toBe(wrapper)
  const running = wrapper({ path: resolve(root, "a.go") }, actual.caller).catch(error => error)
  await entered.promise; await dispose(); await exited.promise; expect(await running).toBeInstanceOf(MutationHookFailure)
  expect(actual.caller.signal.aborted).toBe(false); expect(mutations).toBe(1); expect(source.counts()).toEqual({ registrations: 1, removals: 1 })
  await expect(wrapper({ path: "a.go" }, caller("late").caller)).rejects.toBeInstanceOf(MutationHookFailure)
  await expect(hooks.register(source.context)).rejects.toBeInstanceOf(MutationHookFailure)
  await dispose(); expect(source.counts().removals).toBe(1)
})

it("disposes active postprocessing and queued mutations before returning cleanup", async () => {
  const root = fixture(), file = join(root, "a.go"), entered = deferred(); let mutated = 0, diagnosed = 0, portsClosed = false
  const source = host("write", async () => { mutated++; writeFileSync(file, "committed"); return { content: "written" } })
  const ports = options(root, {
    format: async (_, ctx) => { entered.resolve(); await new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason), { once: true })); return {} },
    diagnostics: async () => { diagnosed++; return {} }, disposePorts: async () => { portsClosed = true },
  })
  const hooks = createMutationHooks(ports); await hooks.register(source.context)
  const first = source.tool.execute({ path: file }, caller("first").caller).catch(error => error); await entered.promise
  const queued = source.tool.execute({ path: file }, caller("queued").caller).catch(error => error)
  await hooks.dispose()
  expect(await first).toBeInstanceOf(MutationHookFailure); expect(await queued).toBeInstanceOf(MutationHookFailure)
  expect(mutated).toBe(1); expect(diagnosed).toBe(0); expect(portsClosed).toBe(true)
  expect(ports.reports).toHaveLength(1); expect(ports.reports[0]).toMatchObject({ status: "postprocess-error", phase: "format", committed: true })
})

it("reports post-format diagnostic failure without rolling back a committed mutation", async () => {
  const root = fixture(), file = join(root, "a.go"), denial = new Error("DIAGNOSTIC_READ_DENIED")
  const source = host("write", async () => { writeFileSync(file, "committed"); return { content: "written" } })
  const ports = options(root, { format: async () => { writeFileSync(file, "formatted"); return { content: "notice" } }, diagnostics: async () => { throw denial } })
  const hooks = createMutationHooks(ports); await hooks.register(source.context)
  await expect(source.tool.execute({ path: file }, caller("one").caller)).rejects.toBe(denial)
  expect(readFileSync(file, "utf8")).toBe("formatted")
  expect(ports.reports[0]).toMatchObject({ phase: "diagnostics", committed: true, error: denial, formatting: { content: "notice" } })
  await hooks.dispose()
})

it("deliberately decorates successful model-visible output with actual notices and diagnostics", async () => {
  const root = fixture(), file = join(root, "a.go"), original = { content: "original result" }, actual = caller("decorated")
  const source = host("write", async () => { writeFileSync(file, "mutated"); return original })
  const ports = options(root, {
    format: async () => ({ content: "ACTUAL_FORMAT_NOTICE" }), diagnostics: async () => ({ content: "ACTUAL_DIAGNOSTIC" }),
    decorate: (result, report, ctx) => {
      expect(result).toBe(original); expect(report).toBe(ports.reports[0])
      expect(ctx.id).toBe(actual.caller.id); expect(ctx.sessionID).toBe(actual.caller.sessionID)
      expect(report).toMatchObject({ status: "processed", formatting: { content: "ACTUAL_FORMAT_NOTICE" }, diagnostics: [{ file, result: { content: "ACTUAL_DIAGNOSTIC" } }] })
      return { content: result.content + "\nACTUAL_FORMAT_NOTICE\nACTUAL_DIAGNOSTIC", metadata: { committed: report.committed } }
    },
  })
  const hooks = createMutationHooks(ports); await hooks.register(source.context)
  expect(await source.tool.execute({ path: file }, actual.caller)).toEqual({ content: "original result\nACTUAL_FORMAT_NOTICE\nACTUAL_DIAGNOSTIC", metadata: { committed: true } })
  expect(original).toEqual({ content: "original result" }); await hooks.dispose()
})

it("preserves decorator errors and abort identity, reports committed facts, and releases locks", async () => {
  const root = fixture(), file = join(root, "a.go"), failed = new Error("DECORATOR_FAILURE"), aborted = new Error("USER_ABORT_DURING_DECORATION"), identity = caller("abort"); let mutations = 0
  const source = host("write", async () => { mutations++; writeFileSync(file, "committed"); return { content: "original" } })
  const ports = options(root, { decorate: (result, _, ctx) => { if (ctx.id === "failure") throw failed; if (ctx.id === "abort") identity.controller.abort(aborted); return result } })
  const hooks = createMutationHooks(ports); await hooks.register(source.context)
  await expect(source.tool.execute({ path: file }, caller("failure").caller)).rejects.toBe(failed)
  expect(ports.reports.at(-1)).toMatchObject({ status: "postprocess-error", phase: "decorate", committed: true, error: failed })
  await expect(source.tool.execute({ path: file }, identity.caller)).rejects.toBe(aborted)
  expect(ports.reports.at(-1)).toMatchObject({ status: "postprocess-error", phase: "decorate", committed: true, error: aborted })
  expect(await source.tool.execute({ path: file }, caller("next").caller)).toEqual({ content: "original" }); expect(mutations).toBe(3)
  await hooks.dispose()
})
