import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"

import * as nativeRuntime from "../../lazy/senpi-barrel"
import type { ManagerStartSpec, StartResult } from "../../manager"
import { CTX, createFakeManager, makeDeps } from "./__fixtures__/task-tool-fakes"
import { buildTaskExecute } from "./execute"
import type { TaskToolDeps } from "./types"

const started = (): Extract<StartResult, { readonly kind: "started" }> => ({ kind: "started", task_id: "st_prepared", status: "running", name: "prepared" })
const single = { prompt: "Inspect the source.", category: "quick", load_skills: ["review"], run_in_background: true }
const batch = { category: "quick", run_in_background: true, tasks: [{ prompt: "First item." }, { prompt: "Second item." }] }

afterEach(() => mock.restore())

describe("task runtime preparation boundary", () => {
  test("custom single preparation is awaited before skill capture/start and receives its dependency receiver", async () => {
    const events: string[] = [], gate = Promise.withResolvers<void>()
    const warm = spyOn(nativeRuntime, "loadSenpiBarrel").mockRejectedValue(new Error("Native warmup must not run"))
    const manager = createFakeManager({ start: async (spec): Promise<StartResult> => { events.push("start:" + spec.prompt); return started() } })
    let deps: TaskToolDeps
    deps = makeDeps(manager, {
      async prepareRuntime() { expect(this).toBe(deps); events.push("prepare"); await gate.promise; events.push("prepared") },
      loadSkills: () => { events.push("skills"); return { prepend: "READY ", resolved: ["review"], missing: [] } },
    })
    const running = buildTaskExecute(deps)("single", single, undefined, undefined, CTX)
    await Promise.resolve(); await Promise.resolve()
    expect(events).toEqual(["prepare"])
    gate.resolve()
    const result = await running
    expect(result.details.status).toBe("running")
    expect(events).toEqual(["prepare", "prepared", "skills", "start:READY Inspect the source."])
    expect(warm).not.toHaveBeenCalled()
  })

  test("custom batch preparation captures each item snapshot in the original sequential order", async () => {
    const events: string[] = [], specs: ManagerStartSpec[] = []
    let snapshot = 0
    const warm = spyOn(nativeRuntime, "loadSenpiBarrel").mockRejectedValue(new Error("Native warmup must not run"))
    const manager = createFakeManager({ start: async (spec): Promise<StartResult> => { specs.push(spec); events.push("start:" + snapshot); return { ...started(), task_id: "st_" + snapshot } } })
    const deps = makeDeps(manager, {
      async prepareRuntime() { events.push("prepare:" + (snapshot + 1)); await Promise.resolve(); snapshot++; events.push("prepared:" + snapshot) },
      loadSkills: () => { events.push("skills:" + snapshot); return { prepend: "SNAPSHOT " + snapshot + " ", resolved: [], missing: [] } },
    })
    const result = await buildTaskExecute(deps)("batch", batch, undefined, undefined, CTX)
    expect(result.details.items).toHaveLength(2)
    expect(specs.map(spec => spec.prompt)).toEqual(["SNAPSHOT 1 First item.", "SNAPSHOT 2 Second item."])
    expect(events).toEqual(["prepare:1", "prepared:1", "skills:1", "start:1", "prepare:2", "prepared:2", "skills:2", "start:2"])
    expect(warm).not.toHaveBeenCalled()
  })

  test("custom single preparation failure preserves the error and creates no child or skill capture", async () => {
    const reason = new Error("Catalog preparation failed")
    let starts = 0, skills = 0
    const manager = createFakeManager({ start: async () => { starts++; return started() } })
    const deps = makeDeps(manager, { prepareRuntime: async () => { throw reason }, loadSkills: () => { skills++; return { prepend: "", resolved: [], missing: [] } } })
    await expect(buildTaskExecute(deps)("failed-single", single, undefined, undefined, CTX)).rejects.toBe(reason)
    expect(starts).toBe(0); expect(skills).toBe(0)
  })

  test("custom batch preparation failure retains per-item failure mapping and starts zero children", async () => {
    let starts = 0, prepares = 0, skills = 0
    const manager = createFakeManager({ start: async () => { starts++; return started() } })
    const deps = makeDeps(manager, { prepareRuntime: async () => { prepares++; throw new Error("Catalog preparation failed") }, loadSkills: () => { skills++; return { prepend: "", resolved: [], missing: [] } } })
    const result = await buildTaskExecute(deps)("failed-batch", batch, undefined, undefined, CTX)
    expect(prepares).toBe(2); expect(starts).toBe(0); expect(skills).toBe(0)
    expect(result.details.status).toBe("error")
    expect(result.details.items?.map(item => item.error_message)).toEqual(["Catalog preparation failed", "Catalog preparation failed"])
  })

  test("absent preparation still awaits the real Native warmup before injected skills and start", async () => {
    const events: string[] = [], nativeWarmup = nativeRuntime.loadSenpiBarrel, gate = Promise.withResolvers<void>()
    const warm = spyOn(nativeRuntime, "loadSenpiBarrel").mockImplementation(async () => { events.push("warm"); await gate.promise; const loaded = await nativeWarmup(); events.push("warmed"); return loaded })
    const manager = createFakeManager({ start: async () => { events.push("start"); return started() } })
    const deps = makeDeps(manager, { loadSkills: () => { events.push("skills"); return { prepend: "", resolved: [], missing: [] } } })
    const running = buildTaskExecute(deps)("native-default", single, undefined, undefined, CTX)
    await Promise.resolve(); await Promise.resolve()
    expect(events).toEqual(["warm"])
    gate.resolve(); await running
    expect(events).toEqual(["warm", "warmed", "skills", "start"])
    expect(warm).toHaveBeenCalledTimes(1)
  })

  test("absent preparation preserves Native warmup failure before any single or batch child", async () => {
    const reason = new Error("Original Native warmup failure")
    const warm = spyOn(nativeRuntime, "loadSenpiBarrel").mockRejectedValue(reason)
    let starts = 0, skills = 0
    const manager = createFakeManager({ start: async () => { starts++; return started() } })
    const deps = makeDeps(manager, { loadSkills: () => { skills++; return { prepend: "", resolved: [], missing: [] } } })
    await expect(buildTaskExecute(deps)("native-single-error", single, undefined, undefined, CTX)).rejects.toBe(reason)
    const result = await buildTaskExecute(deps)("native-batch-error", batch, undefined, undefined, CTX)
    expect(result.details.items?.map(item => item.error_message)).toEqual([reason.message, reason.message])
    expect(warm).toHaveBeenCalledTimes(3)
    expect(starts).toBe(0); expect(skills).toBe(0)
  })
})


test("task-operations preserves the exact existing functions, schemas, normalizer and prompt data", async () => {
  const operations = await import("@oh-my-opencode/senpi-task/task-operations")
  const execute = await import("./execute")
  const params = await import("./params")
  const normalize = await import("./argument-normalization")
  const description = await import("./description")
  const send = await import("../control/send")
  const cancel = await import("../control/cancel")
  const output = await import("../output/output")
  expect(operations.buildTaskExecute).toBe(execute.buildTaskExecute)
  expect(operations.TaskToolParams).toBe(params.TaskToolParams)
  expect(operations.normalizeTaskToolArguments).toBe(normalize.normalizeTaskToolArguments)
  expect(operations.buildTaskToolDescription).toBe(description.buildTaskToolDescription)
  expect(operations.TASK_PROMPT_GUIDELINES).toBe(description.TASK_PROMPT_GUIDELINES)
  expect(operations.TASK_PROMPT_SNIPPET).toBe(description.TASK_PROMPT_SNIPPET)
  expect(operations.runTaskSend).toBe(send.runTaskSend)
  expect(operations.TaskSendParams).toBe(send.TaskSendParams)
  expect(operations.runTaskCancel).toBe(cancel.runTaskCancel)
  expect(operations.TaskCancelParams).toBe(cancel.TaskCancelParams)
  expect(operations.runTaskOutput).toBe(output.runTaskOutput)
  expect(operations.TaskOutputParams).toBe(output.TaskOutputParams)
})

test("absent batch preparation keeps each original awaited Native warmup before that item's skill snapshot", async () => {
  const events: string[] = [], nativeWarmup = nativeRuntime.loadSenpiBarrel
  const warm = spyOn(nativeRuntime, "loadSenpiBarrel").mockImplementation(async () => { events.push("warm"); const loaded = await nativeWarmup(); events.push("warmed"); return loaded })
  const manager = createFakeManager({ start: async () => { events.push("start"); return started() } })
  const deps = makeDeps(manager, { loadSkills: () => { events.push("skills"); return { prepend: "", resolved: [], missing: [] } } })
  const result = await buildTaskExecute(deps)("native-batch", batch, undefined, undefined, CTX)
  expect(result.details.items).toHaveLength(2)
  expect(events).toEqual(["warm", "warmed", "skills", "start", "warm", "warmed", "skills", "start"])
  expect(warm).toHaveBeenCalledTimes(2)
})
