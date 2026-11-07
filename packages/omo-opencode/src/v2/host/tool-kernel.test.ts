import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { z } from "zod"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import { Error as HostToolError } from "@opencode/plugin/promise/tool"
import { createSessionScopes } from "./session-state"
import { createToolRegistry } from "./tool-registry"
import { createPolicyPipeline } from "./policy-pipeline"
import { createToolKernel } from "./tool-kernel"
import { locationPermissionAdapters } from "./permission-adapters"
import path from "node:path"

function fixture(input: Info["input"] = z.object({ marker: z.string() })) {
  const order: string[] = []
  let calls = 0
  const controller = new AbortController()
  const context = { sessionID: "session", agent: "agent", messageID: "message", id: "call", signal: controller.signal,
    progress: async () => { order.push("progress") } } as unknown as ToolContext
  const scopes = createSessionScopes()
  const lease = scopes.open(context.sessionID, { tools: ["canary", "route", "read", "grep"], authorize: ({ input }) => {
    order.push("authorize")
    if ((input as { marker?: string }).marker === "write") throw Error("SIDECAR_WRITE_DENIED")
  } })
  const tool: Info & { id: string } = { id: "canary", name: "canary", description: "canary", input,
    options: { permission: "canary" }, execute: async (args, c) => { calls++; order.push("execute"); await c.progress({}); return { content: String(args.marker), metadata: { preserved: true } } } }
  const registry = createToolRegistry([tool], { canary: () => [{ action: "canary", resources: ["fixture"] }] })
  const pipeline = createPolicyPipeline({ before: async () => { order.push("before") }, after: async () => { order.push("after") }, error: async () => { order.push("error") } })
  const kernel = createToolKernel({ registry, scopes, pipeline, permission: { assert: async () => { order.push("permission") } } })
  return { kernel, registry, scopes, lease, tool, context, controller, order, calls: () => calls }
}

describe("native host kernel", () => {
  test("raw public closure accepts malformed input; library blocks it before side effects", async () => {
    const f = fixture()
    await f.tool.execute({ marker: 123 }, f.context)
    expect(f.calls()).toBe(1)
    await expect(f.kernel.bind(f.context, f.lease).invoke("canary", { marker: 123 })).rejects.toThrow()
    expect(f.calls()).toBe(1)
  })
  test("genuine context, ordered policy, permission and preserved result", async () => {
    const f = fixture(Schema.Struct({ marker: Schema.String }))
    const result = await f.kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })
    expect(result).toEqual({ content: "ok", metadata: { preserved: true } })
    expect(f.order).toEqual(["before", "authorize", "permission", "execute", "progress", "after"])
  })
  test("handler restrictions stop schema-valid sidecar writes", async () => {
    const f = fixture()
    await expect(f.kernel.bind(f.context, f.lease).invoke("canary", { marker: "write" })).rejects.toThrow("SIDECAR_WRITE_DENIED")
    expect(f.calls()).toBe(0)
  })
  test("foreign and retired leases cannot invoke; replacing registry invalidates bindings", async () => {
    const f = fixture()
    expect(() => f.kernel.bind({ ...f.context, sessionID: "foreign" } as ToolContext, f.lease)).toThrow()
    const bound = f.kernel.bind(f.context, f.lease)
    f.registry.replace([f.tool])
    await expect(bound.invoke("canary", { marker: "ok" })).rejects.toThrow()
    f.scopes.retire(f.lease)
    expect(() => f.kernel.bind(f.context, f.lease)).toThrow()
    expect(f.calls()).toBe(0)
  })
  test("abort prevents execution and raw JSON schemas fail closed", async () => {
    const f = fixture({ type: "object" })
    await expect(f.kernel.bind(f.context, f.lease).invoke("canary", {})).rejects.toThrow("Unsupported")
    f.controller.abort()
    await expect(f.kernel.bind(f.context, f.lease).invoke("canary", {})).rejects.toThrow()
    expect(f.calls()).toBe(0)
  })
  test("permission rejection preserves the original error and never calls the target", async () => {
    const f = fixture()
    const denied = new Error("DENIED")
    const kernel = createToolKernel({ ...f, pipeline: createPolicyPipeline({ error: () => { throw Error("reporting failure") } }), permission: { assert: async () => { throw denied } } })
    try { await kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" }); throw Error("unexpected success") }
    catch (error) { expect(error).toBe(denied) }
    expect(f.calls()).toBe(0)
  })
  test("rewrite validates final schema and authorizes final normalized resource", async () => {
    const f = fixture()
    const requests: unknown[] = []
    const route: Info & { id: string } = { ...f.tool, id: "read", name: "read", input: Schema.Struct({ path: Schema.String }), options: { permission: "read" } }
    const registry = createToolRegistry([f.tool, route], { canary: () => [{ action: "canary", resources: ["fixture"] }], ...locationPermissionAdapters(process.cwd()) })
    const pipeline = createPolicyPipeline({ before: call => { expect(call.requested).toBe("canary"); call.routed = "read"; call.input = { path: "folder/../allowed.txt" } } })
    const kernel = createToolKernel({ scopes: f.scopes, registry, pipeline, permission: { assert: async input => { requests.push(input) } } })
    await kernel.bind(f.context, f.lease).invoke("canary", { marker: 123 })
    expect(requests).toEqual([{ action: "read", resources: [path.resolve("allowed.txt")], sessionID: "session", agent: "agent", source: { type: "tool", messageID: "message", id: "call" } }])
    expect(f.calls()).toBe(1)
  })
  test("rewrite cannot escape a filtered session or activate unknown target", async () => {
    const f = fixture()
    const pipeline = createPolicyPipeline({ before: call => { call.routed = "hidden" } })
    const kernel = createToolKernel({ ...f, pipeline, permission: { assert: async () => {} } })
    await expect(kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })).rejects.toThrow("Unknown tool")
    await expect(kernel.bind(f.context, f.lease).invoke("missing", {})).rejects.toThrow("Unknown tool")
    expect(f.calls()).toBe(0)
  })
  test("explicit handler policy forbids a registry-visible filtered tool", async () => {
    const f = fixture()
    const lease = f.scopes.open(f.context.sessionID, { tools: ["read"], authorize: () => {} })
    await expect(f.kernel.bind(f.context, lease).invoke("canary", { marker: "ok" })).rejects.toThrow("outside session scope")
    expect(f.calls()).toBe(0)
  })
  test("unknown permission map and omitted declared permission fail closed", async () => {
    const f = fixture()
    const registry = createToolRegistry([f.tool], {})
    const kernel = createToolKernel({ ...f, registry, permission: { assert: async () => {} }, pipeline: createPolicyPipeline() })
    await expect(kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })).rejects.toThrow("Unsupported resource")
    const wrong = createToolRegistry([f.tool], { canary: () => [{ action: "allow", resources: ["wrong"] }] })
    await expect(createToolKernel({ ...f, registry: wrong, pipeline: createPolicyPipeline(), permission: { assert: async () => {} } }).bind(f.context, f.lease).invoke("canary", { marker: "ok" })).rejects.toThrow("omits declared")
    expect(f.calls()).toBe(0)
  })
  test("approval wait cancellation returns promptly and late approval cannot execute", async () => {
    const f = fixture()
    let approve!: () => void
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    const kernel = createToolKernel({ ...f, pipeline: createPolicyPipeline(), permission: { assert: async () => { entered(); await new Promise<void>(resolve => { approve = resolve }) } } })
    const execution = kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })
    await ready
    const interrupted = Error("INTERRUPTED")
    f.controller.abort(interrupted)
    await expect(execution).rejects.toBe(interrupted)
    approve()
    await Promise.resolve()
    expect(f.calls()).toBe(0)
  })
  test("retirement during approval and registry reload during authorization stop execution", async () => {
    const f = fixture()
    const lease = f.scopes.open(f.context.sessionID, { tools: ["canary"], authorize: () => { f.registry.replace([f.tool]) } })
    await expect(f.kernel.bind(f.context, lease).invoke("canary", { marker: "ok" })).rejects.toThrow("Retired tool registry")
    // Renew handler to avoid triggering a second registry reload.
    const renewed = f.scopes.open(f.context.sessionID, { tools: ["canary"], authorize: () => {} })
    const retiring = createToolKernel({ ...f, pipeline: createPolicyPipeline(), permission: { assert: async () => { f.scopes.retire(renewed) } } })
    await expect(retiring.bind(f.context, renewed).invoke("canary", { marker: "ok" })).rejects.toThrow()
    expect(f.calls()).toBe(0)
  })
  test("recursive target calls are blocked while concurrent independent calls succeed", async () => {
    const f = fixture()
    let bound: ReturnType<typeof f.kernel.bind>
    const recursive = { ...f.tool, execute: async () => bound.invoke("canary", { marker: "nested" }) }
    f.registry.replace([recursive])
    bound = f.kernel.bind(f.context, f.lease)
    await expect(bound.invoke("canary", { marker: "ok" })).rejects.toThrow("Recursive")
    f.registry.replace([f.tool])
    bound = f.kernel.bind(f.context, f.lease)
    await Promise.all([bound.invoke("canary", { marker: "one" }), bound.invoke("canary", { marker: "two" })])
    expect(f.calls()).toBe(2)
  })
  test("progress and signal propagate through the genuine caller; retirement aborts cooperative callbacks", async () => {
    const f = fixture()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    f.registry.replace([{ ...f.tool, execute: async (_input, context) => {
      expect(context.sessionID).toBe(f.context.sessionID)
      expect(context.id).toBe(f.context.id)
      await context.progress({ phase: "started" })
      started()
      await new Promise((_, reject) => context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }))
      return { content: "unreachable" }
    } }])
    const execution = f.kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })
    await ready
    f.scopes.retire(f.lease)
    await expect(execution).rejects.toThrow()
    expect(f.order).toContain("progress")
  })
  test("malformed output and callback error trigger the error policy once", async () => {
    const f = fixture()
    const errors: unknown[] = []
    const pipeline = createPolicyPipeline({ error: (_call, error) => { errors.push(error) } })
    const registry = createToolRegistry([{ ...f.tool, output: z.string(), execute: async () => ({ output: 123 }) }], { canary: () => [{ action: "canary", resources: ["fixture"] }] })
    const kernel = createToolKernel({ ...f, registry, pipeline, permission: { assert: async () => {} } })
    await expect(kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })).rejects.toThrow("Invalid tool value")
    expect(errors).toHaveLength(1)
    const failure = Error("CALLBACK_FAILURE")
    registry.replace([{ ...f.tool, execute: async () => { throw failure } }])
    await expect(kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })).rejects.toBe(failure)
    expect(errors).toEqual([errors[0], failure])
  })
  test("shared invocation marker executes before/body/after once on concurrent reentry", async () => {
    const order: string[] = []
    const pipeline = createPolicyPipeline({ before: () => { order.push("before") }, after: () => { order.push("after") } })
    const invocation = pipeline.invocation("canary", {})
    const body = async () => { order.push("body"); return { content: "ok" } }
    const a = invocation.run(body)
    const b = invocation.run(body)
    expect(a).toBe(b)
    await Promise.all([a, b])
    expect(order).toEqual(["before", "body", "after"])
  })
  test("resource adapters normalize the current host location and reject ambiguity", () => {
    const adapters = locationPermissionAdapters(process.cwd())
    expect(adapters.grep!({ pattern: "needle", path: "folder/.." })).toEqual([{ action: "read", resources: [process.cwd()] }, { action: "grep", resources: ["needle"] }])
    expect(() => adapters.read!({ path: "a", filePath: "b" })).toThrow("Ambiguous")
    expect(() => locationPermissionAdapters("relative")).toThrow()
  })
  test("closed outer binding cannot be retained by evaluated code", async () => {
    const f = fixture()
    const bound = f.kernel.bind(f.context, f.lease)
    bound.dispose()
    await expect(bound.invoke("canary", { marker: "ok" })).rejects.toThrow("binding closed")
    expect(f.calls()).toBe(0)
  })
  test("depth limit stops distinct nested targets and after-policy output is validated", async () => {
    const f = fixture()
    let bound: ReturnType<typeof f.kernel.bind>
    const route = { ...f.tool, name: "route", id: "route" }
    const registry = createToolRegistry([{ ...f.tool, execute: async () => bound.invoke("route", { marker: "nested" }) }, route], {
      canary: () => [{ action: "canary", resources: ["fixture"] }], route: () => [{ action: "canary", resources: ["fixture"] }],
    })
    const kernel = createToolKernel({ ...f, registry, maxDepth: 1, pipeline: createPolicyPipeline(), permission: { assert: async () => {} } })
    bound = kernel.bind(f.context, f.lease)
    await expect(bound.invoke("canary", { marker: "ok" })).rejects.toThrow("depth limit")
    expect(f.calls()).toBe(0)
    let errors = 0
    const badOutput = createToolKernel({ ...f, pipeline: createPolicyPipeline({ after: () => ({ content: 42 } as never), error: () => { errors++ } }), permission: { assert: async () => {} } })
    await expect(badOutput.bind(f.context, f.lease).invoke("canary", { marker: "ok" })).rejects.toThrow("Invalid tool result content")
    expect(errors).toBe(1)
  })
  test("before-policy cancellation cannot reach body; policies receive trusted caller identity", async () => {
    const f = fixture()
    let entered!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    const pipeline = createPolicyPipeline({ before: async call => {
      expect(call.context?.sessionID).toBe(f.context.sessionID)
      expect(call.context?.id).toBe(f.context.id)
      entered()
      await new Promise<void>(resolve => { release = resolve })
    } })
    const kernel = createToolKernel({ ...f, pipeline, permission: { assert: async () => {} } })
    const execution = kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })
    await ready
    f.controller.abort(Error("STOP"))
    await expect(execution).rejects.toThrow("STOP")
    release()
    await Promise.resolve()
    expect(f.calls()).toBe(0)
  })
  test("authorization cannot mutate the decoded resource after permission selection", async () => {
    const f = fixture()
    const lease = f.scopes.open(f.context.sessionID, { tools: ["canary"], authorize: ({ input }) => {
      expect(Object.isFrozen(input)).toBe(true)
      ;(input as { marker: string }).marker = "write"
    } })
    await expect(f.kernel.bind(f.context, lease).invoke("canary", { marker: "ok" })).rejects.toThrow()
    expect(f.calls()).toBe(0)
  })
  test("plain step rejection, typed host denial and non-Error abort reasons preserve identity", async () => {
    for (const rejection of [{ step: "rejected", opaque: true }, new HostToolError({ message: "feedback rejected" })]) {
      const f = fixture()
      const kernel = createToolKernel({ ...f, pipeline: createPolicyPipeline(), permission: { assert: async () => { throw rejection } } })
      await expect(kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })).rejects.toBe(rejection)
      expect(f.calls()).toBe(0)
    }
    const f = fixture()
    const reason = { interrupted: true }
    f.controller.abort(reason)
    await expect(f.kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })).rejects.toBe(reason)
  })
  test("policy failure ordering preserves the first failure and invokes error once", async () => {
    for (const phase of ["before", "after"] as const) {
      const order: string[] = []
      const failure = Error(phase)
      const pipeline = createPolicyPipeline({
        before: () => { order.push("before"); if (phase === "before") throw failure },
        after: () => { order.push("after"); throw failure },
        error: () => { order.push("error"); throw Error("secondary") },
      })
      const invocation = pipeline.invocation("canary", {})
      const execution = invocation.run(async () => { order.push("body"); return { content: "ok" } })
      await expect(execution).rejects.toBe(failure)
      await expect(invocation.run(async () => { throw Error("must not rerun") })).rejects.toBe(failure)
      expect(order).toEqual(phase === "before" ? ["before", "error"] : ["before", "body", "after", "error"])
    }
  })
  test("schema errors never expose rejected input or raw validator diagnostics", async () => {
    const secret = "synthetic-sensitive-fixture-value"
    const schemas = [Schema.Struct({ marker: Schema.Number }), {
      "~standard": { version: 1, vendor: "test", validate: () => ({ issues: [{ message: secret, input: secret }] }) },
    }, {
      "~standard": { version: 1, vendor: "test", validate: () => { throw Error(secret) } },
    }] as Info["input"][]
    for (const schema of schemas) {
      const f = fixture(schema)
      try { await f.kernel.bind(f.context, f.lease).invoke("canary", { marker: secret }); throw Error("unexpected success") }
      catch (error) {
        expect(String(error)).toBe("Error: Invalid tool value")
        expect(JSON.stringify(error)).not.toContain(secret)
        expect((error as Error).cause).toBeUndefined()
      }
      expect(f.calls()).toBe(0)
    }
  })
  test("adapter metadata cannot override captured session, agent or source IDs", async () => {
    const f = fixture()
    const requests: unknown[] = []
    const registry = createToolRegistry([f.tool], { canary: () => [{ action: "canary", resources: ["fixture"], sessionID: "forged", agent: "forged", source: { type: "tool", id: "forged", messageID: "forged" } }] })
    const kernel = createToolKernel({ ...f, registry, pipeline: createPolicyPipeline(), permission: { assert: async request => { requests.push(request) } } })
    await kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })
    expect(requests).toEqual([{ action: "canary", resources: ["fixture"], sessionID: "session", agent: "agent", source: { type: "tool", messageID: "message", id: "call" } }])
  })
})
