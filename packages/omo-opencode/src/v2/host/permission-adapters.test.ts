import { expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import type { PermissionDomain } from "@opencode/plugin/effect/permission"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { acquireEffectPermissionApi, hasJoinedPermissionCancellation } from "./effect-permission-api"
import {
  assertPermissions,
  locationPermissionAdapters,
  type ResourcePermission,
  type LegacyPermissionPort,
} from "./permission-adapters"
import path from "node:path"

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}
/** Explicit UNIT context/domain; official codec and actual Effect API/fibers.
 * No actual SDK callback, permission evaluator or approval UI is claimed. */
function caller() {
  const controller = new AbortController()
  const context = {
    sessionID: "ses_adapter_unit",
    agent: "unit-agent",
    messageID: "unit-message",
    id: "unit-call",
    signal: controller.signal,
    progress: async () => {},
  } as unknown as ToolContext
  return { controller, context }
}
async function owner(
  work: (input: Parameters<PermissionDomain["assert"]>[0]) => Effect.Effect<void, unknown, Scope.Scope>,
) {
  const scope = Scope.makeUnsafe(),
    inputs: Parameters<PermissionDomain["assert"]>[0][] = [],
    counts: number[] = []
  const domain = {
    assert(...args: Parameters<PermissionDomain["assert"]>) {
      inputs.push(args[0])
      counts.push(args.length)
      return Effect.scoped(work(args[0]))
    },
  } as Pick<PermissionDomain, "assert">
  const api = await Effect.runPromise(Effect.provideService(acquireEffectPermissionApi(domain), Scope.Scope, scope))
  return { api, inputs, counts, close: () => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))) }
}
const permissions: readonly ResourcePermission[] = [{ action: "unit-read", resources: ["bounded-unit-file"] }]

test("genuine internal options preserve real SDK input/source and domain still receives one argument", async () => {
  const f = await owner(() => Effect.void),
    c = caller()
  await assertPermissions(f.api, c.context, permissions)
  expect(f.inputs).toEqual([
    {
      sessionID: c.context.sessionID,
      agent: c.context.agent,
      action: "unit-read",
      resources: ["bounded-unit-file"],
      source: { type: "tool", messageID: c.context.messageID, id: c.context.id },
    },
  ])
  expect(f.counts).toEqual([1])
  await f.close()
})

test("adapter forwards cancellation only to genuine API and waits its original held finalizer", async () => {
  const entered = deferred<void>(),
    cleaning = deferred<void>(),
    finish = deferred<void>(),
    c = caller(),
    reason = Error("adapter caller canceled")
  const f = await owner(() =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          cleaning.resolve()
          await finish.promise
        }),
      )
      entered.resolve()
      yield* Effect.never
    }),
  )
  let settled = false,
    observed: unknown
  const original = assertPermissions(f.api, c.context, permissions).then(
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
    c.controller.abort(reason)
    await cleaning.promise
    expect(settled).toBe(false)
    finish.resolve()
    await original
    expect(observed).toBe(reason)
  } finally {
    finish.resolve()
    await f.close()
    await original
  }
})

test("SDK Tool.Error identity survives adapter; a pre-aborted caller starts no request", async () => {
  const error = new ToolError({ message: "unit deny", metadata: { bounded: true } }),
    f = await owner(() => Effect.fail(error)),
    c = caller()
  await expect(assertPermissions(f.api, c.context, permissions)).rejects.toBe(error)
  c.controller.abort(false)
  await expect(assertPermissions(f.api, c.context, permissions)).rejects.toBe(false)
  expect(f.inputs).toHaveLength(1)
  await f.close()
})

for (const [index, failure] of [undefined, null, false, 0].entries())
  test(`distinct joined falsy finalizer error survives adapter ${index}`, async () => {
    const entered = deferred<void>(),
      cleaning = deferred<void>(),
      finish = deferred<void>(),
      c = caller()
    const f = await owner(() =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            cleaning.resolve()
            await finish.promise
          }).pipe(Effect.andThen(Effect.die(failure))),
        )
        entered.resolve()
        yield* Effect.never
      }),
    )
    const original = assertPermissions(f.api, c.context, permissions)
    try {
      await entered.promise
      c.controller.abort(Error("ordinary caller abort"))
      await cleaning.promise
      finish.resolve()
      await expect(original).rejects.toBe(failure)
    } finally {
      finish.resolve()
      await f.close()
      await original.catch(() => {})
    }
  })

test("cancellation after first permission never initiates a later permission", async () => {
  const c = caller(),
    reason = Error("first assertion canceled caller")
  const f = await owner(() =>
    Effect.sync(() => {
      c.controller.abort(reason)
    }),
  )
  await expect(
    assertPermissions(f.api, c.context, [...permissions, { action: "later", resources: ["never"] }]),
  ).rejects.toBe(reason)
  expect(f.inputs).toHaveLength(1)
  await f.close()
})

test("legacy and structural lookalikes receive exactly one SDK argument, not joined options", async () => {
  const f = await owner(() => Effect.void),
    c = caller(),
    counts: number[] = []
  const lookalike = {
    close: f.api.close,
    async assert(...args: Parameters<LegacyPermissionPort["assert"]>) {
      counts.push(args.length)
      await f.api.assert(args[0])
    },
  }
  expect(hasJoinedPermissionCancellation(lookalike)).toBe(false)
  expect(hasJoinedPermissionCancellation({ ...f.api })).toBe(false)
  await assertPermissions(lookalike, c.context, permissions)
  await assertPermissions(
    {
      async assert(...args) {
        counts.push(args.length)
      },
    },
    c.context,
    permissions,
  )
  expect(counts).toEqual([1, 1])
  await f.close()
})

test("invalid resource mappings reject before request and existing location mappings stay exact", async () => {
  const c = caller()
  let calls = 0
  const legacy = {
    async assert() {
      calls++
    },
  }
  for (const value of [
    [],
    [{ action: "", resources: ["x"] }],
    [{ action: "read", resources: [] }],
    [{ action: "read", resources: [""] }],
  ]) {
    await expect(assertPermissions(legacy, c.context, value)).rejects.toThrow()
  }
  expect(calls).toBe(0)
  const cwd = path.resolve("unit-cwd"),
    adapters = locationPermissionAdapters(cwd)
  expect(defined(adapters.read)({ path: "a.txt" })).toEqual([{ action: "read", resources: [path.join(cwd, "a.txt")] }])
  expect(defined(adapters.grep)({ pattern: "needle" })).toEqual([
    { action: "read", resources: [cwd] },
    { action: "grep", resources: ["needle"] },
  ])
  expect(() => defined(adapters.read)({ path: "a", filePath: "b" })).toThrow("Ambiguous")
})
