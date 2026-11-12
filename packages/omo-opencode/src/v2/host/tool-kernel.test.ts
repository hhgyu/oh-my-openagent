import { withNativeTargetPermissionService } from "../orchestration/native-task/service.test"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Schema, Scope } from "effect"
import { z } from "zod"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import { Error as HostToolError } from "@opencode/plugin/promise/tool"
import { createSessionScopes } from "./session-state"
import { createToolRegistry } from "./tool-registry"
import { createPolicyPipeline } from "./policy-pipeline"
import { createToolKernel } from "./tool-kernel"
import { locationPermissionAdapters } from "./permission-adapters"
import path from "node:path"
import { issueToolValueCodec, decodeToolValue } from "./tool-value-codec"
import { issueToolArgumentNormalizer } from "./tool-argument-normalizer"
import { acquireEffectPermissionApi } from "./effect-permission-api"

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}

function fixture(input: Info["input"] = z.object({ marker: z.string() })) {
  const order: string[] = []
  let calls = 0
  const controller = new AbortController()
  const context = {
    sessionID: "session",
    agent: "agent",
    messageID: "message",
    id: "call",
    signal: controller.signal,
    progress: async () => {
      order.push("progress")
    },
  } as unknown as ToolContext
  const scopes = createSessionScopes()
  const lease = scopes.open(context.sessionID, {
    tools: ["canary", "route", "read", "grep"],
    authorize: ({ input }) => {
      order.push("authorize")
      if ((input as { marker?: string }).marker === "write") throw Error("SIDECAR_WRITE_DENIED")
    },
  })
  const tool: Info & { id: string } = {
    id: "canary",
    name: "canary",
    description: "canary",
    input,
    options: { permission: "canary" },
    execute: async (args, c) => {
      calls++
      order.push("execute")
      await c.progress({})
      return { content: String(args.marker), metadata: { preserved: true } }
    },
  }
  const registry = createToolRegistry([tool], { canary: () => [{ action: "canary", resources: ["fixture"] }] })
  const pipeline = createPolicyPipeline({
    before: async () => {
      order.push("before")
    },
    after: async () => {
      order.push("after")
    },
    error: async () => {
      order.push("error")
    },
  })
  const kernel = createToolKernel({
    registry,
    scopes,
    pipeline,
    permission: {
      assert: async () => {
        order.push("permission")
      },
    },
  })
  return { kernel, registry, scopes, lease, tool, context, controller, order, calls: () => calls }
}

function strictMarker(tool: Info & { id: string }) {
  return issueToolValueCodec(tool, "input", {
    schema: tool.input,
    decodeUnknown: (value) => {
      if (!value || typeof (value as { marker?: unknown }).marker !== "string") throw Error("invalid marker")
      return value
    },
  })
}
test("final route prepares detached input before normalized scope, resources and permission denial", async () => {
  const f = fixture({ type: "object", properties: { marker: { type: "string" } }, required: ["marker"] })
  let wrongPreparations = 0,
    preparations = 0,
    targets = 0
  const route = {
    ...f.tool,
    id: "namespace_read",
    name: "read",
    options: { permission: "read" },
    execute: async () => {
      targets++
      return {}
    },
  }
  const sourceInput = issueToolArgumentNormalizer(f.tool, {
    schema: f.tool.input,
    normalizeUnknown: () => {
      wrongPreparations++
      throw Error("wrong target")
    },
  })
  const input = issueToolArgumentNormalizer(route, {
    schema: route.input,
    normalizeUnknown: (value: unknown) => {
      preparations++
      const prepared = value as { marker: string }
      prepared.marker = prepared.marker.trim()
      return value
    },
  })
  const registry = createToolRegistry(
    [f.tool, route],
    { canary: () => [], read: (value) => [{ action: "read", resources: [(value as { marker: string }).marker] }] },
    [{ tool: route, input: strictMarker(route) }],
    [
      { tool: f.tool, input: sourceInput },
      { tool: route, input },
    ],
  )
  const permissions: unknown[] = []
  const kernel = createToolKernel({
    scopes: f.scopes,
    registry,
    pipeline: createPolicyPipeline({
      before: (call) => {
        call.routed = "read"
      },
    }),
    permission: {
      assert: async (request) => {
        permissions.push(request)
        throw Error("DENIED_NORMALIZED")
      },
    },
  })
  const raw = { marker: "  allowed.txt  " }
  const bound = kernel.bind(f.context, f.lease)
  await expect(bound.invoke("canary", raw)).rejects.toThrow("DENIED_NORMALIZED")
  expect(wrongPreparations).toBe(0)
  expect(preparations).toBe(1)
  expect(targets).toBe(0)
  expect((permissions[0] as { resources: unknown }).resources).toEqual(["allowed.txt"])
  expect(raw.marker).toBe("  allowed.txt  ")
  expect(Object.isFrozen(raw)).toBe(false)
  bound.dispose()
})

test("invalid prepared values and canonical preparation failures stop authorization and execution", async () => {
  for (const throws of [false, true]) {
    const f = fixture({ type: "object", properties: { marker: { type: "string" } }, required: ["marker"] })
    const input = issueToolArgumentNormalizer(f.tool, {
      schema: f.tool.input,
      normalizeUnknown: () => {
        if (throws) throw Error("canonical preparation failed")
        return { marker: 42 }
      },
    })
    f.registry.replace([f.tool], [{ tool: f.tool, input: strictMarker(f.tool) }], [{ tool: f.tool, input }])
    const bound = f.kernel.bind(f.context, f.lease)
    await expect(bound.invoke("canary", { marker: "raw" })).rejects.toThrow(
      throws ? "canonical preparation" : "Invalid tool value",
    )
    expect(f.order).not.toContain("authorize")
    expect(f.order).not.toContain("permission")
    expect(f.calls()).toBe(0)
    bound.dispose()
  }
})

test("asynchronous preparation cannot reach permissions or target after caller abort or generation retirement", async () => {
  for (const retirement of [false, true]) {
    const f = fixture({ type: "object", properties: { marker: { type: "string" } }, required: ["marker"] })
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const input = issueToolArgumentNormalizer(f.tool, {
      schema: f.tool.input,
      normalizeUnknown: async (value) => {
        entered()
        await gate
        return value
      },
    })
    f.registry.replace([f.tool], [{ tool: f.tool, input: strictMarker(f.tool) }], [{ tool: f.tool, input }])
    const bound = f.kernel.bind(f.context, f.lease)
    const pending = bound.invoke("canary", { marker: "ok" })
    await started
    if (retirement) f.registry.replace([f.tool])
    else f.controller.abort(Error("caller aborted"))
    await expect(pending).rejects.toThrow()
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(f.order).not.toContain("authorize")
    expect(f.order).not.toContain("permission")
    expect(f.calls()).toBe(0)
    bound.dispose()
  }
})

test("successful preparation is checked and frozen while raw arguments remain writable", async () => {
  const f = fixture({ type: "object", properties: { marker: { type: "string" } }, required: ["marker"] })
  let checked: unknown
  const tool = {
    ...f.tool,
    execute: async (value: { marker: string }) => {
      checked = value
      expect(Object.isFrozen(value)).toBe(true)
      return { content: value.marker }
    },
  }
  const input = issueToolArgumentNormalizer(tool, {
    schema: tool.input,
    normalizeUnknown: () => ({ marker: "prepared" }),
  })
  f.registry.replace([tool], [{ tool, input: strictMarker(tool) }], [{ tool, input }])
  const raw = { marker: 42 }
  const bound = f.kernel.bind(f.context, f.lease)
  expect(await bound.invoke("canary", raw)).toEqual({ content: "prepared" })
  expect(checked).toEqual({ marker: "prepared" })
  expect(Object.isFrozen(raw)).toBe(false)
  bound.dispose()
})

test("normalized input reaches scope authorization before permissions", async () => {
  const f = fixture({ type: "object", properties: { marker: { type: "string" } } })
  const input = issueToolArgumentNormalizer(f.tool, {
    schema: f.tool.input,
    normalizeUnknown: () => ({ marker: "write" }),
  })
  f.registry.replace([f.tool], [{ tool: f.tool, input: strictMarker(f.tool) }], [{ tool: f.tool, input }])
  const bound = f.kernel.bind(f.context, f.lease)
  await expect(bound.invoke("canary", { marker: "allowed raw" })).rejects.toThrow("SIDECAR_WRITE_DENIED")
  expect(f.order).toContain("authorize")
  expect(f.order).not.toContain("permission")
  expect(f.calls()).toBe(0)
  bound.dispose()
})

test("rerouting to an unassociated target never borrows the requested normalizer", async () => {
  const f = fixture({ type: "object", properties: { marker: { type: "string" } } })
  let prepared = 0
  const route = { ...f.tool, name: "read", id: "namespace_read", options: { permission: "read" } }
  const input = issueToolArgumentNormalizer(f.tool, {
    schema: f.tool.input,
    normalizeUnknown: () => {
      prepared++
      return { marker: "converted" }
    },
  })
  const registry = createToolRegistry(
    [f.tool, route],
    { canary: () => [], read: () => [{ action: "read", resources: ["bounded"] }] },
    [{ tool: route, input: strictMarker(route) }],
    [{ tool: f.tool, input }],
  )
  const kernel = createToolKernel({
    scopes: f.scopes,
    registry,
    pipeline: createPolicyPipeline({
      before: (call) => {
        call.routed = "read"
      },
    }),
    permission: {
      assert: async () => {
        throw Error("unexpected permission")
      },
    },
  })
  const bound = kernel.bind(f.context, f.lease)
  await expect(bound.invoke("canary", { marker: 42 })).rejects.toThrow("Invalid tool value")
  expect(prepared).toBe(0)
  expect(f.calls()).toBe(0)
  bound.dispose()
})

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
    await expect(f.kernel.bind(f.context, f.lease).invoke("canary", { marker: "write" })).rejects.toThrow(
      "SIDECAR_WRITE_DENIED",
    )
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
    const kernel = createToolKernel({
      ...f,
      pipeline: createPolicyPipeline({
        error: () => {
          throw Error("reporting failure")
        },
      }),
      permission: {
        assert: async () => {
          throw denied
        },
      },
    })
    try {
      await kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })
      throw Error("unexpected success")
    } catch (error) {
      expect(error).toBe(denied)
    }
    expect(f.calls()).toBe(0)
  })
  test("rewrite validates final schema and authorizes final normalized resource", async () => {
    const f = fixture()
    const requests: unknown[] = []
    const route: Info & { id: string } = {
      ...f.tool,
      id: "read",
      name: "read",
      input: Schema.Struct({ path: Schema.String }),
      options: { permission: "read" },
    }
    const registry = createToolRegistry([f.tool, route], {
      canary: () => [{ action: "canary", resources: ["fixture"] }],
      ...locationPermissionAdapters(process.cwd()),
    })
    const pipeline = createPolicyPipeline({
      before: (call) => {
        expect(call.requested).toBe("canary")
        call.routed = "read"
        call.input = { path: "folder/../allowed.txt" }
      },
    })
    const kernel = createToolKernel({
      scopes: f.scopes,
      registry,
      pipeline,
      permission: {
        assert: async (input) => {
          requests.push(input)
        },
      },
    })
    await kernel.bind(f.context, f.lease).invoke("canary", { marker: 123 })
    expect(requests).toEqual([
      {
        action: "read",
        resources: [path.resolve("allowed.txt")],
        sessionID: "session",
        agent: "agent",
        source: { type: "tool", messageID: "message", id: "call" },
      },
    ])
    expect(f.calls()).toBe(1)
  })
  test("rewrite cannot escape a filtered session or activate unknown target", async () => {
    const f = fixture()
    const pipeline = createPolicyPipeline({
      before: (call) => {
        call.routed = "hidden"
      },
    })
    const kernel = createToolKernel({ ...f, pipeline, permission: { assert: async () => {} } })
    await expect(kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })).rejects.toThrow("Unknown tool")
    await expect(kernel.bind(f.context, f.lease).invoke("missing", {})).rejects.toThrow("Unknown tool")
    expect(f.calls()).toBe(0)
  })
  test("explicit handler policy forbids a registry-visible filtered tool", async () => {
    const f = fixture()
    const lease = f.scopes.open(f.context.sessionID, { tools: ["read"], authorize: () => {} })
    await expect(f.kernel.bind(f.context, lease).invoke("canary", { marker: "ok" })).rejects.toThrow(
      "outside session scope",
    )
    expect(f.calls()).toBe(0)
  })
  test("unknown permission map and omitted declared permission fail closed", async () => {
    const f = fixture()
    const registry = createToolRegistry([f.tool], {})
    const kernel = createToolKernel({
      ...f,
      registry,
      permission: { assert: async () => {} },
      pipeline: createPolicyPipeline(),
    })
    await expect(kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })).rejects.toThrow(
      "Unsupported resource",
    )
    const wrong = createToolRegistry([f.tool], { canary: () => [{ action: "allow", resources: ["wrong"] }] })
    await expect(
      createToolKernel({
        ...f,
        registry: wrong,
        pipeline: createPolicyPipeline(),
        permission: { assert: async () => {} },
      })
        .bind(f.context, f.lease)
        .invoke("canary", { marker: "ok" }),
    ).rejects.toThrow("omits declared")
    expect(f.calls()).toBe(0)
  })
  test("approval wait cancellation returns promptly and late approval cannot execute", async () => {
    const f = fixture()
    let approve!: () => void
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    const kernel = createToolKernel({
      ...f,
      pipeline: createPolicyPipeline(),
      permission: {
        assert: async () => {
          entered()
          await new Promise<void>((resolve) => {
            approve = resolve
          })
        },
      },
    })
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
    const lease = f.scopes.open(f.context.sessionID, {
      tools: ["canary"],
      authorize: () => {
        f.registry.replace([f.tool])
      },
    })
    await expect(f.kernel.bind(f.context, lease).invoke("canary", { marker: "ok" })).rejects.toThrow(
      "Retired tool registry",
    )
    // Renew handler to avoid triggering a second registry reload.
    const renewed = f.scopes.open(f.context.sessionID, { tools: ["canary"], authorize: () => {} })
    const retiring = createToolKernel({
      ...f,
      pipeline: createPolicyPipeline(),
      permission: {
        assert: async () => {
          f.scopes.retire(renewed)
        },
      },
    })
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
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    f.registry.replace([
      {
        ...f.tool,
        execute: async (_input, context) => {
          expect(context.sessionID).toBe(f.context.sessionID)
          expect(context.id).toBe(f.context.id)
          await context.progress({ phase: "started" })
          started()
          await new Promise((_, reject) =>
            context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }),
          )
          return { content: "unreachable" }
        },
      },
    ])
    const execution = f.kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })
    await ready
    f.scopes.retire(f.lease)
    await expect(execution).rejects.toThrow()
    expect(f.order).toContain("progress")
  })
  test("malformed output and callback error trigger the error policy once", async () => {
    const f = fixture()
    const errors: unknown[] = []
    const pipeline = createPolicyPipeline({
      error: (_call, error) => {
        errors.push(error)
      },
    })
    const registry = createToolRegistry([{ ...f.tool, output: z.string(), execute: async () => ({ output: 123 }) }], {
      canary: () => [{ action: "canary", resources: ["fixture"] }],
    })
    const kernel = createToolKernel({ ...f, registry, pipeline, permission: { assert: async () => {} } })
    await expect(kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })).rejects.toThrow(
      "Invalid tool value",
    )
    expect(errors).toHaveLength(1)
    const failure = Error("CALLBACK_FAILURE")
    registry.replace([
      {
        ...f.tool,
        execute: async () => {
          throw failure
        },
      },
    ])
    await expect(kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })).rejects.toBe(failure)
    expect(errors).toEqual([errors[0], failure])
  })
  test("shared invocation marker executes before/body/after once on concurrent reentry", async () => {
    const order: string[] = []
    const pipeline = createPolicyPipeline({
      before: () => {
        order.push("before")
      },
      after: () => {
        order.push("after")
      },
    })
    const invocation = pipeline.invocation("canary", {})
    const body = async () => {
      order.push("body")
      return { content: "ok" }
    }
    const a = invocation.run(body)
    const b = invocation.run(body)
    expect(a).toBe(b)
    await Promise.all([a, b])
    expect(order).toEqual(["before", "body", "after"])
  })
  test("resource adapters normalize the current host location and reject ambiguity", () => {
    const adapters = locationPermissionAdapters(process.cwd())
    expect(defined(adapters.grep)({ pattern: "needle", path: "folder/.." })).toEqual([
      { action: "read", resources: [process.cwd()] },
      { action: "grep", resources: ["needle"] },
    ])
    expect(() => defined(adapters.read)({ path: "a", filePath: "b" })).toThrow("Ambiguous")
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
    const registry = createToolRegistry(
      [{ ...f.tool, execute: async () => bound.invoke("route", { marker: "nested" }) }, route],
      {
        canary: () => [{ action: "canary", resources: ["fixture"] }],
        route: () => [{ action: "canary", resources: ["fixture"] }],
      },
    )
    const kernel = createToolKernel({
      ...f,
      registry,
      maxDepth: 1,
      pipeline: createPolicyPipeline(),
      permission: { assert: async () => {} },
    })
    bound = kernel.bind(f.context, f.lease)
    await expect(bound.invoke("canary", { marker: "ok" })).rejects.toThrow("depth limit")
    expect(f.calls()).toBe(0)
    let errors = 0
    const badOutput = createToolKernel({
      ...f,
      pipeline: createPolicyPipeline({
        after: () => ({ content: 42 }) as never,
        error: () => {
          errors++
        },
      }),
      permission: { assert: async () => {} },
    })
    await expect(badOutput.bind(f.context, f.lease).invoke("canary", { marker: "ok" })).rejects.toThrow(
      "Invalid tool result content",
    )
    expect(errors).toBe(1)
  })
  test("before-policy cancellation cannot reach body; policies receive trusted caller identity", async () => {
    const f = fixture()
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release!: () => void
    const pipeline = createPolicyPipeline({
      before: async (call) => {
        expect(call.context?.sessionID).toBe(f.context.sessionID)
        expect(call.context?.id).toBe(f.context.id)
        entered()
        await new Promise<void>((resolve) => {
          release = resolve
        })
      },
    })
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
    const lease = f.scopes.open(f.context.sessionID, {
      tools: ["canary"],
      authorize: ({ input }) => {
        expect(Object.isFrozen(input)).toBe(true)
        ;(input as { marker: string }).marker = "write"
      },
    })
    await expect(f.kernel.bind(f.context, lease).invoke("canary", { marker: "ok" })).rejects.toThrow()
    expect(f.calls()).toBe(0)
  })
  test("plain step rejection, typed host denial and non-Error abort reasons preserve identity", async () => {
    for (const rejection of [{ step: "rejected", opaque: true }, new HostToolError({ message: "feedback rejected" })]) {
      const f = fixture()
      const kernel = createToolKernel({
        ...f,
        pipeline: createPolicyPipeline(),
        permission: {
          assert: async () => {
            throw rejection
          },
        },
      })
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
        before: () => {
          order.push("before")
          if (phase === "before") throw failure
        },
        after: () => {
          order.push("after")
          throw failure
        },
        error: () => {
          order.push("error")
          throw Error("secondary")
        },
      })
      const invocation = pipeline.invocation("canary", {})
      const execution = invocation.run(async () => {
        order.push("body")
        return { content: "ok" }
      })
      await expect(execution).rejects.toBe(failure)
      await expect(
        invocation.run(async () => {
          throw Error("must not rerun")
        }),
      ).rejects.toBe(failure)
      expect(order).toEqual(phase === "before" ? ["before", "error"] : ["before", "body", "after", "error"])
    }
  })
  test("schema errors never expose rejected input or raw validator diagnostics", async () => {
    const secret = "synthetic-sensitive-fixture-value"
    const schemas = [
      Schema.Struct({ marker: Schema.Number }),
      {
        "~standard": { version: 1, vendor: "test", validate: () => ({ issues: [{ message: secret, input: secret }] }) },
      },
      {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: () => {
            throw Error(secret)
          },
        },
      },
    ] as Info["input"][]
    for (const schema of schemas) {
      const f = fixture(schema)
      try {
        await f.kernel.bind(f.context, f.lease).invoke("canary", { marker: secret })
        throw Error("unexpected success")
      } catch (error) {
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
    const registry = createToolRegistry([f.tool], {
      canary: () => [
        {
          action: "canary",
          resources: ["fixture"],
          sessionID: "forged",
          agent: "forged",
          source: { type: "tool", id: "forged", messageID: "forged" },
        },
      ],
    })
    const kernel = createToolKernel({
      ...f,
      registry,
      pipeline: createPolicyPipeline(),
      permission: {
        assert: async (request) => {
          requests.push(request)
        },
      },
    })
    await kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })
    expect(requests).toEqual([
      {
        action: "canary",
        resources: ["fixture"],
        sessionID: "session",
        agent: "agent",
        source: { type: "tool", messageID: "message", id: "call" },
      },
    ])
  })
})

describe("issued raw JSON kernel decoding", () => {
  function issuedFixture(decoder?: (value: unknown) => unknown | Promise<unknown>) {
    const f = fixture({ type: "object", properties: { marker: { type: "string" } }, required: ["marker"] })
    const input = issueToolValueCodec(f.tool, "input", {
      schema: f.tool.input,
      decodeUnknown:
        decoder ??
        ((value) => {
          if (typeof (value as { marker?: unknown }).marker !== "string") throw Error("private diagnostic")
          return value
        }),
    })
    f.registry.replace([f.tool], [{ tool: f.tool, input }])
    return { ...f, input }
  }
  test("same decoder protects direct and nested callbacks; invalid input has no target/authorization/permission effects", async () => {
    const f = issuedFixture()
    await expect(decodeToolValue(f.input, f.tool, "input", { marker: 42 })).rejects.toThrow("Invalid tool value")
    await expect(f.kernel.bind(f.context, f.lease).invoke("canary", { marker: 42 })).rejects.toThrow(
      "Invalid tool value",
    )
    expect(f.calls()).toBe(0)
    expect(f.order).toEqual(["before", "error"])
    const value = { marker: "ok" }
    expect(await decodeToolValue(f.input, f.tool, "input", value)).toBe(value)
    expect(await f.kernel.bind(f.context, f.lease).invoke("canary", value)).toEqual({
      content: "ok",
      metadata: { preserved: true },
    })
    expect(Object.isFrozen(value)).toBe(true)
    expect(f.order.slice(2)).toEqual(["before", "authorize", "permission", "execute", "progress", "after"])
  })
  test("alias uses routed input codec and independent output codec after policy transforms", async () => {
    const f = fixture()
    const route = {
      ...f.tool,
      id: "route",
      name: "route",
      input: { type: "object", required: ["prompt"] },
      output: { type: "string" },
      execute: async () => ({ output: "ok" }),
    }
    const input = issueToolValueCodec(route, "input", {
      schema: route.input,
      decodeUnknown: (value) => {
        if (typeof (value as { prompt?: unknown }).prompt !== "string") throw Error()
        return value
      },
    })
    const output = issueToolValueCodec(route, "output", {
      schema: route.output,
      decodeUnknown: (value) => {
        if (typeof value !== "string") throw Error()
        return value
      },
    })
    const registry = createToolRegistry(
      [f.tool, route],
      { canary: () => [], route: () => [{ action: "canary", resources: ["fixture"] }] },
      [{ tool: route, input, output }],
    )
    let invalid = false
    const pipeline = createPolicyPipeline({
      before: (call) => {
        call.routed = "route"
        call.input = { prompt: "ok" }
      },
      after: () => ({ output: invalid ? 42 : "after" }),
    })
    const kernel = createToolKernel({ ...f, registry, pipeline, permission: { assert: async () => {} } })
    expect(await kernel.bind(f.context, f.lease).invoke("canary", { marker: 42 })).toEqual({ output: "after" })
    invalid = true
    await expect(kernel.bind(f.context, f.lease).invoke("canary", {})).rejects.toThrow("Invalid tool value")
    registry.replace([f.tool, route], [{ tool: route, input }])
    invalid = false
    await expect(kernel.bind(f.context, f.lease).invoke("canary", {})).rejects.toThrow("Unsupported JSON Schema")
  })
  test("replacement and cancellation during async raw validation cannot reach authorization or target", async () => {
    for (const reason of ["replace", "abort"] as const) {
      let entered!: () => void
      let release!: (value: unknown) => void
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const f = issuedFixture((value) => {
        entered()
        return new Promise((resolve) => {
          release = () => resolve(value)
        })
      })
      const pending = f.kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })
      await ready
      if (reason === "replace") f.registry.replace([f.tool])
      else f.controller.abort(Error("validation aborted"))
      release(undefined)
      await expect(pending).rejects.toThrow(reason === "replace" ? "Retired tool registry" : "validation aborted")
      await Promise.resolve()
      expect(f.calls()).toBe(0)
      expect(f.order).not.toContain("authorize")
      expect(f.order).not.toContain("permission")
      if (reason === "replace")
        await expect(f.kernel.bind(f.context, f.lease).invoke("canary", {})).rejects.toThrow("Unsupported JSON Schema")
    }
  })
})

describe("issued per-call host authority", () => {
  test("issued admission survives normal binding disposal but raw interruption affects only admission", async () => {
    const f = fixture()
    let token!: ReturnType<typeof f.kernel.callAuthority.capture>
    f.registry.replace([
      {
        ...f.tool,
        execute: async (_args, caller) => {
          token = f.kernel.callAuthority.capture(caller)
          return { content: "ok" }
        },
      },
    ])
    const bound = f.kernel.bind(f.context, f.lease)
    await bound.invoke("canary", { marker: "ok" })
    bound.dispose()
    expect(f.kernel.callAuthority.parent(token)).toBe(f.lease)
    token.assertAdmission()
    token.assertLifetime()
    expect(token.admissionSignal.aborted).toBe(false)
    f.controller.abort(Error("raw call interrupted"))
    expect(token.admissionSignal.aborted).toBe(true)
    expect(token.lifetimeSignal.aborted).toBe(false)
    expect(() => token.assertAdmission()).toThrow("raw call interrupted")
    token.assertLifetime()
    f.kernel.callAuthority.assert(token, f.lease)
    await expect(bound.invoke("canary", { marker: "ok" })).rejects.toThrow()
  })
  test("capture requires exact active derived caller; casts, copied tokens and foreign kernels refuse", async () => {
    const f = fixture()
    const foreign = createToolKernel({ ...f, pipeline: createPolicyPipeline(), permission: { assert: async () => {} } })
    expect(() => f.kernel.callAuthority.capture(f.context)).toThrow("authorized")
    let token!: ReturnType<typeof f.kernel.callAuthority.capture>
    f.registry.replace([
      {
        ...f.tool,
        execute: async (_args, caller) => {
          expect(() => f.kernel.callAuthority.capture({ ...caller })).toThrow("authorized")
          expect(() => foreign.callAuthority.capture(caller)).toThrow("authorized")
          token = f.kernel.callAuthority.capture(caller)
          return { content: "ok" }
        },
      },
    ])
    await f.kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })
    expect(() => f.kernel.callAuthority.assert({ ...token })).toThrow("Unissued")
    expect(() => ({ ...token }).assertLifetime()).toThrow("Unissued")
    expect(() => foreign.callAuthority.assert(token)).toThrow("Unissued")
    const other = f.scopes.open("other" as ToolContext["sessionID"], { tools: [], authorize() {} })
    expect(() => f.kernel.callAuthority.assert(token, other)).toThrow("foreign")
    expect(token).not.toHaveProperty("context")
    expect(token).not.toHaveProperty("progress")
  })
  test("before and permission phases cannot issue; invalid input and denied permission never reach issuance", async () => {
    const f = fixture()
    let kernel!: ReturnType<typeof createToolKernel>
    let targets = 0,
      before = 0
    const pipeline = createPolicyPipeline({
      before: (call) => {
        before++
        expect(() => kernel.callAuthority.capture(defined(call.context))).toThrow("authorized")
      },
    })
    f.registry.replace([
      {
        ...f.tool,
        execute: async (_args, caller) => {
          targets++
          kernel.callAuthority.capture(caller)
          return { content: "ok" }
        },
      },
    ])
    kernel = createToolKernel({
      ...f,
      pipeline,
      permission: {
        assert: async () => {
          expect(() => kernel.callAuthority.capture(f.context)).toThrow("authorized")
          throw Error("permission denied")
        },
      },
    })
    await expect(kernel.bind(f.context, f.lease).invoke("canary", { marker: 123 })).rejects.toThrow(
      "Invalid tool value",
    )
    await expect(kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })).rejects.toThrow(
      "permission denied",
    )
    expect(before).toBe(2)
    expect(targets).toBe(0)
  })
  test("async descendants cannot mint after target return while an already issued token remains valid", async () => {
    const f = fixture(),
      gate = Promise.withResolvers<void>()
    let descendant!: Promise<unknown>
    let token!: ReturnType<typeof f.kernel.callAuthority.capture>
    f.registry.replace([
      {
        ...f.tool,
        execute: async (_args, caller) => {
          token = f.kernel.callAuthority.capture(caller)
          f.kernel.callAuthority.assertCall(token)
          descendant = gate.promise.then(() => {
            try {
              f.kernel.callAuthority.assertCall(token)
              return f.kernel.callAuthority.capture(caller)
            } catch (error) {
              return error
            }
          })
          return { content: "ok" }
        },
      },
    ])
    await f.kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })
    gate.resolve()
    expect(String(await descendant)).toContain("authorized")
    token.assertAdmission()
  })
  test("registry retirement aborts both signals promptly and leaves old lease available for cleanup", async () => {
    const f = fixture()
    let token!: ReturnType<typeof f.kernel.callAuthority.capture>
    f.registry.replace([
      {
        ...f.tool,
        execute: async (_args, caller) => {
          token = f.kernel.callAuthority.capture(caller)
          return { content: "ok" }
        },
      },
    ])
    await f.kernel.bind(f.context, f.lease).invoke("canary", { marker: "ok" })
    expect(() => f.registry.replace([f.tool, f.tool])).toThrow()
    token.assertAdmission()
    f.registry.replace([f.tool])
    expect(token.admissionSignal.aborted).toBe(true)
    expect(token.lifetimeSignal.aborted).toBe(true)
    expect(() => token.assertLifetime()).toThrow()
    expect(f.lease.signal.aborted).toBe(false)
    f.scopes.assert(f.lease)
  })
  test("parallel authorized callbacks keep distinct raw admission signals and shared parent lifetime", async () => {
    const f = fixture(),
      ready = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      tokens = new Map<string, ReturnType<typeof f.kernel.callAuthority.capture>>()
    let entered = 0
    f.registry.replace([
      {
        ...f.tool,
        execute: async (args, caller) => {
          tokens.set(String(args.marker), f.kernel.callAuthority.capture(caller))
          if (++entered === 2) ready.resolve()
          await release.promise
          return { content: "ok" }
        },
      },
    ])
    const a = new AbortController(),
      b = new AbortController()
    const one = f.kernel.bind({ ...f.context, id: "call-a", signal: a.signal } as ToolContext, f.lease),
      two = f.kernel.bind({ ...f.context, id: "call-b", signal: b.signal } as ToolContext, f.lease)
    const tasks = Promise.all([one.invoke("canary", { marker: "a" }), two.invoke("canary", { marker: "b" })])
    await ready.promise
    release.resolve()
    await tasks
    one.dispose()
    two.dispose()
    a.abort(Error("only A interrupted"))
    expect(defined(tokens.get("a")).admissionSignal.aborted).toBe(true)
    expect(defined(tokens.get("b")).admissionSignal.aborted).toBe(false)
    defined(tokens.get("b")).assertAdmission()
    defined(tokens.get("a")).assertLifetime()
    defined(tokens.get("b")).assertLifetime()
    f.scopes.retire(f.lease)
    expect(defined(tokens.get("a")).lifetimeSignal.aborted).toBe(true)
    expect(defined(tokens.get("b")).lifetimeSignal.aborted).toBe(true)
  })
})

test("active-call authority cannot cross target frames even when a binding reuses the same derived caller", async () => {
  const f = fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  let first!: ReturnType<typeof f.kernel.callAuthority.capture>, kernel!: ReturnType<typeof createToolKernel>
  const canary = {
    ...f.tool,
    execute: async (_args: unknown, caller: ToolContext) => {
      first = kernel.callAuthority.capture(caller)
      entered.resolve()
      await release.promise
      return { content: "first" }
    },
  }
  const route = {
    ...f.tool,
    id: "route",
    name: "route",
    execute: async (_args: unknown, caller: ToolContext) => {
      kernel.callAuthority.assert(first, f.lease)
      expect(() => kernel.callAuthority.assertCall(first)).toThrow("authorized")
      kernel.callAuthority.assertCall(kernel.callAuthority.capture(caller))
      return { content: "second" }
    },
  }
  const registry = createToolRegistry([canary, route], {
    canary: () => [{ action: "canary", resources: ["fixture"] }],
    route: () => [{ action: "canary", resources: ["fixture"] }],
  })
  kernel = createToolKernel({
    ...f,
    registry,
    pipeline: createPolicyPipeline(),
    permission: { assert: async () => {} },
  })
  // Same binding means the exact derived caller is shared; issuance must still match its target frame.
  const bound = kernel.bind(f.context, f.lease),
    pending = bound.invoke("canary", { marker: "ok" })
  await entered.promise
  try {
    expect((await bound.invoke("route", { marker: "ok" })).content).toBe("second")
  } finally {
    release.resolve()
    await pending
    bound.dispose()
  }
  expect(() => kernel.callAuthority.assertCall(first)).toThrow("authorized")
  first.assertAdmission()
})

test.each([false, true])(
  "nested invocation policy phases cannot borrow outer authority (denied=%s)",
  async (denied) => {
    const f = fixture()
    let kernel!: ReturnType<typeof createToolKernel>,
      bound!: ReturnType<typeof f.kernel.bind>,
      outerCaller!: ToolContext
    const minted: string[] = []
    let targets = 0
    const probe = (phase: string, caller: ToolContext) => {
      try {
        kernel.callAuthority.capture(caller)
        minted.push(phase)
      } catch {}
    }
    const outer = {
      ...f.tool,
      execute: async (_args: unknown, caller: ToolContext) => {
        outerCaller = caller
        const token = kernel.callAuthority.capture(caller)
        if (denied) await expect(bound.invoke("route", { marker: "nested" })).rejects.toThrow("nested denied")
        else expect((await bound.invoke("route", { marker: "nested" })).content).toBe("inner")
        kernel.callAuthority.assertCall(token)
        return { content: "outer" }
      },
    }
    const inner = {
      ...f.tool,
      id: "route",
      name: "route",
      options: { permission: "route" },
      execute: async (_args: unknown, caller: ToolContext) => {
        targets++
        kernel.callAuthority.assertCall(kernel.callAuthority.capture(caller))
        return { content: "inner" }
      },
    }
    const registry = createToolRegistry([outer, inner], {
      canary: () => [{ action: "canary", resources: ["fixture"] }],
      route: () => [{ action: "route", resources: ["fixture"] }],
    })
    const pipeline = createPolicyPipeline({
      before: (call) => {
        if (call.routed === "route") probe("before", defined(call.context))
      },
      after: (call) => {
        if (call.routed === "route") probe("after", defined(call.context))
      },
      error: (call) => {
        if (call.routed === "route") probe("error", defined(call.context))
      },
    })
    kernel = createToolKernel({
      ...f,
      registry,
      pipeline,
      permission: {
        assert: async (request) => {
          if (request.action === "route") {
            probe("permission", outerCaller)
            if (denied) throw Error("nested denied")
          }
        },
      },
    })
    bound = kernel.bind(f.context, f.lease)
    try {
      expect((await bound.invoke("canary", { marker: "outer" })).content).toBe("outer")
      expect(minted).toEqual([])
      expect(targets).toBe(denied ? 0 : 1)
    } finally {
      bound.dispose()
    }
  },
)

describe("session-owned recursion frames", () => {
  test("genuine child lease may invoke the same target while parent target is live", async () => {
    const f = fixture()
    const childContext = { ...f.context, sessionID: "child", id: "child-call" } as ToolContext
    const childLease = f.scopes.open(childContext.sessionID, { tools: ["canary"], authorize() {} })
    const visited: string[] = []
    f.registry.replace([
      {
        ...f.tool,
        execute: async (_input, caller) => {
          visited.push(caller.sessionID)
          if (caller.sessionID === f.context.sessionID) {
            const child = f.kernel.bind(childContext, childLease)
            try {
              return await child.invoke("canary", { marker: "child" })
            } finally {
              child.dispose()
            }
          }
          return { content: "child completed" }
        },
      },
    ])
    const parent = f.kernel.bind(f.context, f.lease)
    try {
      expect(await parent.invoke("canary", { marker: "parent" })).toEqual({ content: "child completed" })
    } finally {
      parent.dispose()
    }
    expect(visited).toEqual(["session", "child"])
  })

  test("child cannot loop back through another binding into the live parent target", async () => {
    const f = fixture()
    const childContext = { ...f.context, sessionID: "child", id: "child-call" } as ToolContext
    const childLease = f.scopes.open(childContext.sessionID, { tools: ["canary"], authorize() {} })
    const visited: string[] = []
    f.registry.replace([
      {
        ...f.tool,
        execute: async (_input, caller) => {
          visited.push(caller.sessionID)
          const next =
            caller.sessionID === "child"
              ? f.kernel.bind({ ...f.context, id: "rebound-parent" } as ToolContext, f.lease)
              : f.kernel.bind(childContext, childLease)
          try {
            return await next.invoke("canary", { marker: "nested" })
          } finally {
            next.dispose()
          }
        },
      },
    ])
    const parent = f.kernel.bind(f.context, f.lease)
    try {
      await expect(parent.invoke("canary", { marker: "parent" })).rejects.toThrow("Recursive")
    } finally {
      parent.dispose()
    }
    expect(visited).toEqual(["session", "child"])
  })

  test("inherited asynchronous context does not retain a completed tool recursion frame", async () => {
    const f = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let later!: Promise<unknown>
    f.registry.replace([
      {
        ...f.tool,
        execute: async (input) => {
          if (input.marker === "first") {
            later = gate.then(async () => {
              const next = f.kernel.bind({ ...f.context, id: "later-call" } as ToolContext, f.lease)
              try {
                return await next.invoke("canary", { marker: "later" })
              } finally {
                next.dispose()
              }
            })
            void later.catch(() => {})
          }
          return { content: String(input.marker) }
        },
      },
    ])
    const parent = f.kernel.bind(f.context, f.lease)
    expect(await parent.invoke("canary", { marker: "first" })).toEqual({ content: "first" })
    parent.dispose()
    release()
    expect(await later).toEqual({ content: "later" })
  })

  test("a separate child recursion frame still enforces that child's policy", async () => {
    const f = fixture()
    const childContext = { ...f.context, sessionID: "child", id: "child-call" } as ToolContext
    const childLease = f.scopes.open(childContext.sessionID, { tools: ["read"], authorize() {} })
    let childExecuted = false
    f.registry.replace([
      {
        ...f.tool,
        execute: async (_input, caller) => {
          if (caller.sessionID === "child") {
            childExecuted = true
            return {}
          }
          const child = f.kernel.bind(childContext, childLease)
          try {
            return await child.invoke("canary", { marker: "child" })
          } finally {
            child.dispose()
          }
        },
      },
    ])
    const parent = f.kernel.bind(f.context, f.lease)
    try {
      await expect(parent.invoke("canary", { marker: "parent" })).rejects.toThrow("outside session scope")
    } finally {
      parent.dispose()
    }
    expect(childExecuted).toBe(false)
  })
})

test("delayed policy routing ignores an ancestor that completed during the policy wait", async () => {
  const f = fixture()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let later!: Promise<unknown>
  let next: ReturnType<typeof f.kernel.bind> | undefined
  let kernel: ReturnType<typeof createToolKernel>
  const tool = {
    ...f.tool,
    execute: async (input: { marker: string }) => {
      if (input.marker === "first") {
        next = kernel.bind({ ...f.context, id: "later-call" } as ToolContext, f.lease)
        later = next.invoke("route", { marker: "later" })
        void later.catch(() => {})
      }
      return { content: input.marker }
    },
  }
  const route = { ...tool, id: "route", name: "route" }
  const registry = createToolRegistry([tool, route], {
    canary: () => [{ action: "canary", resources: ["fixture"] }],
    route: () => [{ action: "canary", resources: ["fixture"] }],
  })
  kernel = createToolKernel({
    registry,
    scopes: f.scopes,
    permission: { assert: async () => {} },
    pipeline: createPolicyPipeline({
      before: async (call) => {
        if (call.requested === "route") {
          await gate
          call.routed = "canary"
        }
      },
    }),
  })
  const parent = kernel.bind(f.context, f.lease)
  expect(await parent.invoke("canary", { marker: "first" })).toEqual({ content: "first" })
  parent.dispose()
  release()
  try {
    expect(await later).toEqual({ content: "later" })
  } finally {
    next?.dispose()
  }
})

function permissionDeferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

/** Controlled UNIT domain with the real issued Effect API and real kernel.
 * These unit caller IDs are not claimed as actual SDK callback provenance. */
async function joinedPermissionKernel(failure?: { value: unknown }) {
  const scope = Scope.makeUnsafe(),
    entered = permissionDeferred<void>(),
    cleaning = permissionDeferred<void>(),
    finish = permissionDeferred<void>()
  const controller = new AbortController(),
    scopes = createSessionScopes()
  let targets = 0,
    cleaned = false,
    cleanedBeforeOwnerClose = false
  const context = {
    sessionID: "ses_joined_kernel_unit",
    agent: "unit-agent",
    messageID: "unit-message",
    id: "unit-call",
    signal: controller.signal,
    progress: async () => {},
  } as unknown as ToolContext
  const permission = await Effect.runPromise(
    Effect.provideService(
      acquireEffectPermissionApi({
        assert: () =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.promise(async () => {
                  cleaning.resolve()
                  await finish.promise
                  cleaned = true
                }).pipe(Effect.andThen(failure ? Effect.die(failure.value) : Effect.void)),
              )
              entered.resolve()
              yield* Effect.never
            }),
          ),
      }),
      Scope.Scope,
      scope,
    ),
  )
  const tool = {
    id: "unit-joined",
    name: "unit-joined",
    description: "unit",
    input: Schema.Unknown,
    execute: async () => {
      targets++
      return {}
    },
  }
  const registry = createToolRegistry([tool], {
    "unit-joined": () => [{ action: "unit", resources: ["unit-resource"] }],
  })
  const lease = scopes.open(context.sessionID, { tools: ["unit-joined"], authorize() {} })
  const kernel = createToolKernel({ registry, scopes, permission, pipeline: createPolicyPipeline() }),
    bound = kernel.bind(context, lease)
  return {
    entered,
    cleaning,
    finish,
    controller,
    permission,
    bound,
    registry,
    kernel,
    context,
    lease,
    scopes,
    targets: () => targets,
    cleaned: () => cleaned,
    async cleanup() {
      cleanedBeforeOwnerClose = cleaned
      const close = permission.close()
      await cleaning.promise
      finish.resolve()
      await close
      bound.dispose()
      scopes.dispose()
      await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    },
    cleanedBeforeOwnerClose: () => cleanedBeforeOwnerClose,
  }
}

test("genuine joined permission keeps OUTER kernel pending until original delayed finalizer joins", async () => {
  const f = await joinedPermissionKernel(),
    reason = Error("unit caller canceled")
  let settled = false,
    result: unknown
  const pending = f.bound.invoke("unit-joined", {}).then(
    () => {
      settled = true
    },
    (error) => {
      settled = true
      result = error
    },
  )
  await f.entered.promise
  f.controller.abort(reason)
  // One event-loop turn lets either the original abort reaction or finalizer
  // entry run; the held finalizer cannot finish until explicit release below.
  await new Promise<void>((resolve) => setImmediate(resolve))
  const settledBeforeRelease = settled
  try {
    await f.cleanup()
    await pending
    expect(settledBeforeRelease).toBe(false)
    expect(f.cleaned()).toBe(true)
    expect(result).toBe(reason)
    expect(f.targets()).toBe(0)
  } finally {
    f.finish.resolve()
    await f.permission.close()
    await pending
  }
})

for (const [index, failure] of [
  undefined,
  null,
  false,
  0,
  new HostToolError({ message: "actual typed joined error" }),
].entries()) {
  test(`OUTERMOST join preserves distinct actual/falsy finalizer failure over abort ${index}`, async () => {
    const f = await joinedPermissionKernel({ value: failure })
    let settled = false,
      rejected = false,
      observed: unknown
    const pending = f.bound.invoke("unit-joined", {}).then(
      () => {
        settled = true
      },
      (error) => {
        settled = true
        rejected = true
        observed = error
      },
    )
    try {
      await f.entered.promise
      f.controller.abort(Error("ordinary outer abort"))
      await f.cleaning.promise
      expect(settled).toBe(false)
      expect(() => f.kernel.callAuthority.capture(f.context)).toThrow("authorized")
      await f.cleanup()
      await pending
      expect(rejected).toBe(true)
      expect(observed).toBe(failure)
      expect(f.targets()).toBe(0)
      expect(() => f.kernel.callAuthority.capture(f.context)).toThrow("authorized")
    } finally {
      f.finish.resolve()
      await f.permission.close()
      await pending
    }
  })
}

for (const mode of ["binding", "registry", "lease"] as const)
  test(`joined permission follows combined ${mode} cancellation and keeps outer pending`, async () => {
    const f = await joinedPermissionKernel()
    let settled = false,
      observed: unknown
    const retirement = f.registry.retirementSignal(f.registry.generation)
    const pending = f.bound.invoke("unit-joined", {}).then(
      () => {
        settled = true
      },
      (error) => {
        settled = true
        observed = error
      },
    )
    try {
      await f.entered.promise
      if (mode === "binding") f.bound.dispose()
      else if (mode === "registry") f.registry.replace([f.registry.get("unit-joined", f.registry.generation).tool])
      else f.scopes.retire(f.lease)
      await f.cleaning.promise
      expect(settled).toBe(false)
      await f.cleanup()
      await pending
      expect(f.cleaned()).toBe(true)
      expect(f.targets()).toBe(0)
      if (mode === "registry") expect(observed).toBe(retirement.reason)
      else if (mode === "lease") expect(observed).toBe(f.lease.signal.reason)
      else expect((observed as Error).message).toBe("Tool caller binding closed")
    } finally {
      f.finish.resolve()
      await f.permission.close()
      await pending
    }
  })

test("canceled preparation cannot create a late genuine permission behind the returned invocation", async () => {
  const f = fixture(),
    scope = Scope.makeUnsafe(),
    entered = permissionDeferred<void>(),
    release = permissionDeferred<void>(),
    finished = permissionDeferred<void>()
  let requests = 0
  const permission = await Effect.runPromise(
    Effect.provideService(
      acquireEffectPermissionApi({
        assert: () =>
          Effect.sync(() => {
            requests++
          }),
      }),
      Scope.Scope,
      scope,
    ),
  )
  const kernel = createToolKernel({
    ...f,
    permission,
    pipeline: createPolicyPipeline({
      before: async () => {
        entered.resolve()
        await release.promise
        finished.resolve()
      },
    }),
  })
  const bound = kernel.bind(f.context, f.lease),
    reason = Error("preparation canceled")
  const pending = bound.invoke("canary", { marker: "ok" })
  try {
    await entered.promise
    f.controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    release.resolve()
    await finished.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(requests).toBe(0)
    expect(f.calls()).toBe(0)
  } finally {
    release.resolve()
    bound.dispose()
    await permission.close()
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
  }
})

test("legacy permission remains explicitly unjoined and receives one SDK argument", async () => {
  const f = fixture(),
    entered = permissionDeferred<void>(),
    release = permissionDeferred<void>(),
    counts: number[] = []
  let actualLegacy: Promise<void> | undefined,
    settled = false,
    observed: unknown
  const kernel = createToolKernel({
    ...f,
    pipeline: createPolicyPipeline(),
    permission: {
      assert(...args) {
        counts.push(args.length)
        entered.resolve()
        actualLegacy = release.promise
        return actualLegacy
      },
    },
  })
  const bound = kernel.bind(f.context, f.lease),
    reason = Error("legacy caller canceled")
  const pending = bound.invoke("canary", { marker: "ok" }).then(
    () => {
      settled = true
    },
    (error) => {
      settled = true
      observed = error
    },
  )
  try {
    await entered.promise
    f.controller.abort(reason)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const returnedBeforeLegacy = settled
    release.resolve()
    await actualLegacy
    await pending
    expect(returnedBeforeLegacy).toBe(true)
    expect(observed).toBe(reason)
    expect(counts).toEqual([1])
    expect(f.calls()).toBe(0)
  } finally {
    release.resolve()
    await actualLegacy
    await pending
    bound.dispose()
  }
})

test("canonical Native owner entry keeps canonical input and expired binding fences without invented assertions", async () => {
  await withNativeTargetPermissionService(async ({ service, registry, kernel, f, requests, targets }) => {
    const target = defined(targets.tools[0])
    registry.replace(
      [target],
      targets.codecs.filter((x) => x.tool === target),
      targets.normalizers.filter((x) => x.tool === target),
      [{ tool: target, permission: service.targetPermission(target) }],
    )
    const caller = f.raw("ses_native_boundary").caller,
      lease = await service.parent(caller),
      bound = kernel.bind(caller, lease)
    try {
      await expect(bound.invoke("task", { isolated: "true" })).rejects.toThrow("isolated must be a boolean")
      // The UNIT inspection bridge has deliberately not acquired an owner: valid input reaches ONLY its original handler.
      await expect(bound.invoke("task", { prompt: "valid" })).rejects.toThrow("no acquired owner")
      expect(requests).toHaveLength(0)
    } finally {
      bound.dispose()
    }
    await expect(bound.invoke("task", { prompt: "late" })).rejects.toThrow("binding closed")
  })
})

test("ordinary route cannot borrow a service-owned target permission", async () => {
  await withNativeTargetPermissionService(async ({ service, f, requests, targets }) => {
    const target = defined(targets.tools[0])
    const source = {
      id: "read",
      name: "read",
      description: "unit route",
      input: z.object({}),
      execute: async () => ({}),
    }
    const routed = createToolRegistry([], { read: () => [{ action: "read", resources: [f.dir] }] })
    routed.replace(
      [source, target],
      targets.codecs.filter((x) => x.tool === target),
      targets.normalizers.filter((x) => x.tool === target),
      [{ tool: target, permission: service.targetPermission(target) }],
    )
    const kernel = createToolKernel({
      registry: routed,
      scopes: f.scopes,
      pipeline: createPolicyPipeline({
        before: (call) => {
          call.routed = "task"
        },
      }),
      permission: {
        async assert() {
          throw Error("Unexpected permission assertion")
        },
      },
    })
    const caller = f.raw("ses_native_route").caller,
      lease = await service.parent(caller),
      bound = kernel.bind(caller, lease)
    try {
      await expect(bound.invoke("read", {})).rejects.toThrow("cannot transfer across routes")
      expect(requests).toHaveLength(0)
    } finally {
      bound.dispose()
    }
  })
})

test("synchronous owner fence abort is rechecked before issuing a canonical target frame", async () => {
  await withNativeTargetPermissionService(async ({ service, registry, kernel, f, targets, setFence, requests }) => {
    const target = defined(targets.tools[0])
    registry.replace(
      [target],
      targets.codecs.filter((x) => x.tool === target),
      targets.normalizers.filter((x) => x.tool === target),
      [{ tool: target, permission: service.targetPermission(target) }],
    )
    const origin = f.raw("ses_owner_fence_abort"),
      lease = await service.parent(origin.caller),
      bound = kernel.bind(origin.caller, lease)
    setFence(() => origin.controller.abort(false))
    try {
      await expect(bound.invoke("task", { prompt: "must not enter handler" })).rejects.toBe(false)
      expect(requests).toHaveLength(0)
    } finally {
      bound.dispose()
    }
  })
})
