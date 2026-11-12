import { expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { z } from "zod"
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool"
import type { AgentDefinition } from "@oh-my-opencode/senpi-task"
import type { TaskManager } from "@oh-my-opencode/senpi-task/manager-kernel"
import { buildTaskExecute } from "@oh-my-opencode/senpi-task/task-operations"
import { OmoTaskSettingsSchema } from "@oh-my-opencode/omo-config-core"
import { createSessionScopes } from "../../host/session-state"
import { createToolRegistry } from "../../host/tool-registry"
import { createToolKernel } from "../../host/tool-kernel"
import { createPolicyPipeline } from "../../host/policy-pipeline"
import { withJoinedSessionCancellation } from "../../host/session-cancellation"
import { acquireEffectToolMetadataSource } from "../../host/effect-tool-metadata-source"
import { createNativeTaskService, bindNativeTaskTargetPermission } from "./service"
import { acquireOwnedChildToolGuard } from "../../host/owned-child-tool-guard"
import type { ListedTool } from "../../host/tool-registry"
import { createNativeTaskBridge, type NativeTaskTargets } from "../../tools/native-task"
import type { PreparedNativeTaskRuntime } from "../../tools/native-task-preparation"
import type { OwnedTaskHost } from "./owned-runner"
import { acquireEffectPermissionApi } from "../../host/effect-permission-api"

type Service = ReturnType<typeof createNativeTaskService>
type Facade = Awaited<ReturnType<Service["forCall"]>>
type PermissionRequest = Parameters<Parameters<typeof acquireEffectPermissionApi>[0]["assert"]>[0]
type UnitPublicTool = Info & { readonly id: string }
type UnitSyntheticInput = {
  id?: string
  sessionID: string
  delivery?: string
  text: string
  description?: string
  metadata?: unknown
}
type UnitSyntheticAck = {
  id: string
  sessionID: string
  time: { created: number }
  type: string
  delivery: string
  payload: { text: string; description?: string; metadata?: unknown }
}
function publicTool(tools: readonly UnitPublicTool[], name: string): UnitPublicTool {
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`Missing controlled public tool ${name}`)
  return found
}
function nativeDetails(result: unknown): Record<string, unknown> {
  const metadata = typeof result === "object" && result !== null && "metadata" in result ? result.metadata : undefined
  const native = typeof metadata === "object" && metadata !== null && "native" in metadata ? metadata.native : undefined
  const details = typeof native === "object" && native !== null && "details" in native ? native.details : undefined
  if (typeof details !== "object" || details === null) throw new Error("Missing controlled native result details")
  return { ...details }
}
function defined<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Expected value to be defined in controlled fixture")
  return value
}
export { fixture as withNativeOperationService }
/** Controlled public-domain protocol fixture. Actual installed-host proof is separate. */
async function fixture(run: (f: Awaited<ReturnType<typeof host>>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "omo-service-unit-")),
    closers: (() => Promise<void> | void)[] = []
  let bodyFailure: unknown
  try {
    await run(await host(dir, closers))
  } catch (error) {
    bodyFailure = error
    throw error
  } finally {
    const errors: unknown[] = []
    for (const close of closers.reverse())
      try {
        await close()
      } catch (error) {
        errors.push(error)
      }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      errors.push(error)
    }
    if (errors.length)
      throw new AggregateError(
        bodyFailure === undefined ? errors : [bodyFailure, ...errors],
        "Service protocol fixture cleanup incomplete",
      )
  }
}
async function host(dir: string, closers: (() => Promise<void> | void)[]) {
  let scopes = createSessionScopes()
  closers.push(() => scopes.dispose())
  const calls: string[] = [],
    blocked = new Set<string>(),
    sequence = new Map<string, number>(),
    sessions = new Map<string, unknown>()
  const createdChildren = new Set<string>(),
    idleParents = new Set<string>()
  const activeAssistants = new Map<string, string>()
  const streams = new Set<{ queue: unknown[]; wake?: (r: IteratorResult<unknown>) => void; ended: boolean }>(),
    hooks = new Map<string, Set<(value: unknown) => unknown>>()
  const toolHooks = new Map<string, Set<(value: unknown) => unknown>>()
  const synthetics: Array<{ input: UnitSyntheticInput; ack: UnitSyntheticAck }> = []
  const syntheticEntered = Promise.withResolvers<void>(),
    syntheticRelease = Promise.withResolvers<void>()
  const syntheticSubmitted = Promise.withResolvers<void>()
  const observerUpdateEntered = Promise.withResolvers<void>(),
    observerUpdateRelease = Promise.withResolvers<void>()
  let holdObserverUpdate = false
  let holdSynthetic = false,
    syntheticSequence = 0
  const catalogEntered = Promise.withResolvers<void>(),
    catalogRelease = Promise.withResolvers<void>(),
    createEntered = Promise.withResolvers<void>(),
    createRelease = Promise.withResolvers<void>()
  const waitEntered = Promise.withResolvers<void>(),
    waitRelease = Promise.withResolvers<void>(),
    heldWaitEntered = Promise.withResolvers<void>()
  let holdCatalog = false,
    holdCreate = false,
    holdWait = false,
    failChildGet = false,
    failWait = false
  let catalogs = 0,
    failPolicyDispose = false,
    catalogError: Error | undefined
  const inputEntered = Promise.withResolvers<void>(),
    inputRelease = Promise.withResolvers<void>()
  let holdInput = false
  function emit(type: string, sessionID: string, data: object = {}) {
    const seq = sequence.get(sessionID) ?? 0
    sequence.set(sessionID, seq + 1)
    const value = {
      id: `${sessionID}:${seq}`,
      created: seq,
      type,
      durable: { aggregateID: sessionID, seq, version: 1 },
      data: { sessionID, ...data },
    }
    for (const s of streams) {
      if (s.ended) continue
      if (s.wake) {
        const next = s.wake
        s.wake = undefined
        next({ done: false, value })
      } else s.queue.push(value)
    }
  }
  const api = {
    async create(input: { id: string; parentID?: string; location?: unknown }) {
      calls.push("create")
      const value = { id: input.id, parentID: input.parentID, location: input.location }
      sessions.set(input.id, value)
      createdChildren.add(input.id)
      if (holdCreate) {
        createEntered.resolve()
        await createRelease.promise
      }
      return value
    },
    async get({ sessionID }: { sessionID: string }) {
      calls.push("get")
      const value = sessions.get(sessionID)
      if (!value) throw Error("Missing protocol session")
      if (failChildGet && sessionID.startsWith("ses_native_")) {
        failChildGet = false
        throw Error("controlled child get failure")
      }
      return value
    },
    async list() {
      return { data: [...sessions.values()], cursor: {} }
    },
    async hook(name: string, callback: (value: unknown) => unknown) {
      const list = hooks.get(name) ?? new Set()
      hooks.set(name, list)
      list.add(callback)
      return {
        dispose() {
          if (name === "context") {
            calls.push("policy-dispose-attempt")
            if (failPolicyDispose) {
              failPolicyDispose = false
              calls.push("policy-dispose-failed")
              throw Error("controlled policy dispose failed before removal")
            }
          }
          list.delete(callback)
          if (name === "context") calls.push("policy-disposed")
        },
      }
    },
    // Host own-session update replaces permissions/metadata as sent, like the real backend does.
    async update(input: { sessionID: string; permissions?: readonly unknown[]; metadata?: Record<string, unknown> }) {
      if (holdObserverUpdate) {
        observerUpdateEntered.resolve()
        await observerUpdateRelease.promise
      }
      const session = sessions.get(input.sessionID)
      if (session && typeof session === "object") {
        if (input.permissions) Object.assign(session, { permissions: structuredClone([...input.permissions]) })
        if (input.metadata) Object.assign(session, { metadata: structuredClone({ ...input.metadata }) })
      }
      emit("session.renamed", input.sessionID)
    },
    // Controlled protocol port only: this DTO and its events are unit data, never live SDK evidence.
    async synthetic(input: UnitSyntheticInput, options?: { signal?: AbortSignal }) {
      calls.push("synthetic")
      syntheticSubmitted.resolve()
      const ack = {
        id: input.id ?? `msg_unit_notice_${++syntheticSequence}`,
        sessionID: input.sessionID,
        time: { created: Date.now() },
        type: "synthetic",
        delivery: input.delivery ?? "steer",
        payload: {
          text: input.text,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        },
      }
      synthetics.push({ input: structuredClone(input), ack })
      emit("session.inbox.enqueued", input.sessionID, { inboxID: ack.id, item: ack })
      if (holdSynthetic) {
        syntheticEntered.resolve()
        await new Promise<void>((resolve, reject) => {
          const signal = options?.signal
          const abort = () => {
            signal?.removeEventListener("abort", abort)
            calls.push("synthetic-abort-joined")
            reject(signal?.reason)
          }
          signal?.addEventListener("abort", abort, { once: true })
          syntheticRelease.promise.then(() => {
            signal?.removeEventListener("abort", abort)
            resolve()
          }, reject)
          if (signal?.aborted) abort()
        })
      }
      emit("session.inbox.delivered", input.sessionID, { inboxID: ack.id })
      return ack
    },
    async prompt(input: { id: string; sessionID: string; text: string }, options?: { signal?: AbortSignal }) {
      calls.push("prompt")
      for (const cb of hooks.get("context") ?? []) await cb({ sessionID: input.sessionID, system: [], tools: {} })
      if (input.id.startsWith("msg_omo_") && holdInput) {
        inputEntered.resolve()
        await new Promise<void>((resolve, reject) => {
          const signal = options?.signal
          const abort = () => {
            signal?.removeEventListener("abort", abort)
            reject(signal?.reason)
          }
          signal?.addEventListener("abort", abort, { once: true })
          inputRelease.promise.then(() => {
            signal?.removeEventListener("abort", abort)
            resolve()
          }, reject)
          if (signal?.aborted) abort()
        })
      }
      const priorAssistant = activeAssistants.get(input.sessionID)
      if (input.id.startsWith("msg_omo_") && blocked.has(input.sessionID)) {
        // Controlled running-steer checkpoint: one execution, next model step after the input.
        if (priorAssistant)
          emit("session.step.ended", input.sessionID, { assistantMessageID: priorAssistant, finish: "tool-calls" })
      } else emit("session.execution.started", input.sessionID)
      emit("session.inbox.delivered", input.sessionID, { inboxID: input.id })
      activeAssistants.set(input.sessionID, `assistant:${input.id}`)
      emit("session.step.started", input.sessionID, {
        assistantMessageID: `assistant:${input.id}`,
        model: { providerID: "qa", id: "model" },
      })
      if (input.text.includes("block")) {
        blocked.add(input.sessionID)
        return { id: input.id, sessionID: input.sessionID }
      }
      emit("session.text.started", input.sessionID, { assistantMessageID: `assistant:${input.id}`, ordinal: 0 })
      emit("session.text.ended", input.sessionID, {
        assistantMessageID: `assistant:${input.id}`,
        ordinal: 0,
        text: `result:${input.text}`,
      })
      emit("session.step.ended", input.sessionID, { assistantMessageID: `assistant:${input.id}`, finish: "stop" })
      emit("session.execution.succeeded", input.sessionID)
      activeAssistants.delete(input.sessionID)
      blocked.delete(input.sessionID)
      return { id: input.id, sessionID: input.sessionID }
    },
    async interrupt({ sessionID }: { sessionID: string }) {
      calls.push("interrupt")
      if (blocked.delete(sessionID)) {
        emit("session.execution.interrupted", sessionID)
        return { interrupted: true }
      }
      return { interrupted: false }
    },
    async wait({ sessionID }: { sessionID: string }) {
      // This unit host has no parent agent loop unless the test explicitly
      // models it. A missing model is not a successful public idle observation.
      if (!createdChildren.has(sessionID) && !idleParents.has(sessionID)) {
        calls.push("parent-wait-unsupported")
        throw Error("Controlled parent loop quiescence unavailable")
      }
      calls.push("wait")
      waitEntered.resolve()
      if (failWait) {
        failWait = false
        throw Error("controlled real idle wait failure")
      }
      if (holdWait) {
        heldWaitEntered.resolve()
        await waitRelease.promise
      }
      if (blocked.has(sessionID)) throw Error("Controlled child loop is still running")
    },
    async remove({ sessionID }: { sessionID: string }) {
      calls.push("remove")
      sessions.delete(sessionID)
    },
    async context() {
      return {}
    },
    instructions: {
      entry: {
        async list() {
          return []
        },
        async put() {},
        async remove() {},
      },
    },
  }
  withJoinedSessionCancellation(api, "controlled-test")
  const ctx = {
    app: { version: "2.2.6" },
    location: { directory: dir },
    session: api,
    agent: {
      async list() {
        return { data: [{ id: "build" }] }
      },
    },
    tool: {
      async hook(name: string, callback: (value: unknown) => unknown) {
        const list = toolHooks.get(name) ?? new Set()
        toolHooks.set(name, list)
        list.add(callback)
        return {
          async dispose() {
            list.delete(callback)
          },
        }
      },
    },
    model: {
      async list() {
        catalogs++
        catalogEntered.resolve()
        if (holdCatalog) await catalogRelease.promise
        if (catalogError) throw catalogError
        return {
          data: [
            {
              providerID: "qa",
              id: "model",
              modelID: "model",
              name: "model",
              type: "chat",
              status: "active",
              enabled: true,
              variants: [],
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 32000, output: 1000 },
            },
          ],
        }
      },
    },
    provider: {
      async list() {
        return { data: [{ id: "qa", activation: "enabled" }] }
      },
    },
    event: {
      subscribe({ signal }: { signal: AbortSignal }) {
        const s: { queue: unknown[]; wake?: (r: IteratorResult<unknown>) => void; ended: boolean } = {
          queue: [],
          ended: false,
        }
        streams.add(s)
        signal.addEventListener(
          "abort",
          () => {
            s.ended = true
            s.wake?.({ done: true, value: undefined })
            streams.delete(s)
          },
          { once: true },
        )
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (s.queue.length) return { done: false, value: s.queue.shift() }
                if (s.ended) return { done: true, value: undefined }
                return new Promise<IteratorResult<unknown>>((resolve) => {
                  s.wake = resolve
                })
              },
            }
          },
        }
      },
    },
  } as unknown as OwnedTaskHost
  const releaseScope = Promise.withResolvers<void>(),
    metadataReady = Promise.withResolvers<Parameters<typeof createNativeTaskService>[1]["metadataSource"]>()
  const metadataOwner = Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const source = yield* acquireEffectToolMetadataSource({ hook: () => Effect.void } as never)
        metadataReady.resolve(source)
        yield* Effect.promise(() => releaseScope.promise)
      }),
    ),
  )
  void metadataOwner.catch((error) => metadataReady.reject(error))
  closers.push(async () => {
    releaseScope.resolve()
    await metadataOwner
  })
  const metadataSource = await metadataReady.promise
  let service!: Service
  const initializationWaits: Promise<Facade>[] = []
  const secondInitialization = Promise.withResolvers<void>()
  const handlers = new Map<string, (facade: Facade, caller: ToolContext) => Promise<unknown>>()
  let next = 0
  const tool: Info & { id: string } = {
    id: "native_probe",
    name: "native_probe",
    description: "Unit callback",
    input: z.object({ key: z.string() }),
    async execute(input, caller) {
      const handler = handlers.get(String(input.key))
      if (!handler) throw Error("Unknown unit action")
      const pending = service.forCall(caller)
      initializationWaits.push(pending)
      if (initializationWaits.length === 2) secondInitialization.resolve()
      const facade = await pending
      return { content: JSON.stringify((await handler(facade, caller)) ?? null) }
    },
  }
  const registry = createToolRegistry([tool], {
    native_probe: () => [{ action: "native_probe", resources: ["controlled-parent"] }],
  })
  let kernel = createToolKernel({
    registry,
    scopes,
    pipeline: createPolicyPipeline({}),
    permission: { async assert() {} },
  })
  let configuredConcurrency: number | undefined,
    configuredMaxDepth = 2
  const agents: Record<string, AgentDefinition> = {}
  const policy = { tools: ["native_probe"], authorize() {} }
  const options: Parameters<typeof createNativeTaskService>[1] = {
    scopes,
    callAuthority: kernel.callAuthority,
    policy,
    metadataSource,
    agents,
    stateDirFor: (id) => join(dir, String(id)),
    config: () => ({
      categories: { qa: { model: "qa/model" } },
      task: OmoTaskSettingsSchema.parse({
        max_depth: configuredMaxDepth,
        ...(configuredConcurrency === undefined ? {} : { default_concurrency: configuredConcurrency }),
      }),
    }),
  }
  service = createNativeTaskService(ctx, options)
  closers.push(() => service.close())
  closers.push(() => {
    catalogRelease.resolve()
    createRelease.resolve()
    waitRelease.resolve()
    inputRelease.resolve()
    syntheticRelease.resolve()
    observerUpdateRelease.resolve()
  })
  function raw(id = "parent") {
    const controller = new AbortController()
    sessions.set(id, { id, location: { directory: dir } })
    const caller = {
      sessionID: id,
      agent: "build",
      messageID: `message:${next}`,
      id: `call:${next}`,
      signal: controller.signal,
      async progress() {},
    } as unknown as ToolContext
    return { caller, controller }
  }
  const leases: unknown[] = []
  async function invoke(action: (facade: Facade, caller: ToolContext) => Promise<unknown>, origin = raw()) {
    const lease = await service.parent(origin.caller)
    leases.push(lease)
    const key = String(++next)
    handlers.set(key, action)
    const binding = kernel.bind(origin.caller, lease)
    try {
      const result = await binding.invoke("native_probe", { key })
      return JSON.parse(result.content as string)
    } finally {
      binding.dispose()
      handlers.delete(key)
    }
  }
  return {
    options,
    get service() {
      return service
    },
    emit,
    async reopen() {
      await service.close()
      service = createNativeTaskService(ctx, options)
      return service
    },
    /** A plugin reload: the old service closes and a new one starts over the same state with FRESH session scopes. */
    async reload() {
      await service.close()
      scopes.dispose()
      scopes = createSessionScopes()
      kernel = createToolKernel({
        registry,
        scopes,
        pipeline: createPolicyPipeline({}),
        permission: { async assert() {} },
      })
      Object.assign(options, { scopes, callAuthority: kernel.callAuthority })
      service = createNativeTaskService(ctx, options)
      return service
    },
    get scopes() {
      return scopes
    },
    registry,
    tool,
    raw,
    invoke,
    leases,
    calls,
    blocked,
    dir,
    ctx,
    synthetics,
    async useHostGrant(hostGrant: NonNullable<Parameters<typeof createNativeTaskService>[1]["hostGrant"]>) {
      await service.close()
      Object.assign(options, { hostGrant })
      service = createNativeTaskService(ctx, options)
    },
    enableParentQuiescence(sessionID: string) {
      idleParents.add(sessionID)
    },
    finishChild(sessionID: string, text: string) {
      const assistantMessageID = activeAssistants.get(sessionID)
      if (!createdChildren.has(sessionID) || !blocked.has(sessionID) || !assistantMessageID)
        throw Error("No original controlled child model frame")
      emit("session.text.started", sessionID, { assistantMessageID, ordinal: 0 })
      emit("session.text.ended", sessionID, { assistantMessageID, ordinal: 0, text })
      emit("session.step.ended", sessionID, { assistantMessageID, finish: "stop" })
      emit("session.execution.succeeded", sessionID)
      activeAssistants.delete(sessionID)
      blocked.delete(sessionID)
    },
    endStreams() {
      for (const stream of [...streams]) {
        stream.ended = true
        stream.wake?.({ done: true, value: undefined })
        stream.wake = undefined
      }
      streams.clear()
    },
    async idle(sessionID: string) {
      for (const callback of [...(hooks.get("experimental.idle") ?? [])]) await callback({ sessionID, background: [] })
    },
    async afterTool(caller: ToolContext) {
      for (const callback of [...(toolHooks.get("execute.after") ?? [])])
        await callback({
          tool: "native_probe",
          sessionID: caller.sessionID,
          agent: caller.agent,
          messageID: caller.messageID,
          id: caller.id,
          input: {},
          status: "completed",
          result: { content: "unit returned" },
        })
    },
    holdSynthetic() {
      holdSynthetic = true
    },
    syntheticEntered: syntheticEntered.promise,
    syntheticSubmitted: syntheticSubmitted.promise,
    releaseSynthetic() {
      syntheticRelease.resolve()
    },
    holdObserverUpdate() {
      holdObserverUpdate = true
    },
    observerUpdateEntered: observerUpdateEntered.promise,
    releaseObserverUpdate() {
      observerUpdateRelease.resolve()
    },
    setConcurrency(value: number) {
      configuredConcurrency = value
    },
    setMaxDepth(value: number) {
      configuredMaxDepth = value
    },
    addAgent(agent: AgentDefinition) {
      agents[agent.name] = agent
    },
    setPolicyTools(tools: string[]) {
      policy.tools.splice(0, policy.tools.length, ...tools)
    },
    initializationWaits,
    secondInitialization: secondInitialization.promise,
    catalogs: () => catalogs,
    holdCatalog() {
      holdCatalog = true
    },
    catalogEntered: catalogEntered.promise,
    releaseCatalog() {
      catalogRelease.resolve()
    },
    holdCreate() {
      holdCreate = true
    },
    createEntered: createEntered.promise,
    releaseCreate() {
      createRelease.resolve()
    },
    failCatalog(error: Error) {
      catalogError = error
    },
    holdInput() {
      holdInput = true
    },
    inputEntered: inputEntered.promise,
    releaseInput() {
      inputRelease.resolve()
    },
    holdWait() {
      holdWait = true
    },
    waitEntered: waitEntered.promise,
    heldWaitEntered: heldWaitEntered.promise,
    releaseWait() {
      waitRelease.resolve()
    },
    failWaitOnce() {
      failWait = true
    },
    failChildGetOnce() {
      failChildGet = true
    },
    failPolicyDisposeOnce() {
      failPolicyDispose = true
    },
  }
}

test("parallel C1 abort during shared initialization cannot poison live C2 or create a second manager", async () => {
  await fixture(async (f) => {
    f.holdCatalog()
    const c1 = f.raw(),
      c2 = f.raw()
    const first = f
      .invoke(async (api) => {
        const result = await api.start({ category: "qa", prompt: "C1" })
        return result
      }, c1)
      .catch((error) => String(error))
    await Promise.race([
      f.catalogEntered,
      first.then((result) => {
        throw Error(`C1 failed before catalog entry: ${result}`)
      }),
    ])
    const second = f.invoke(async (api) => {
      const start = await api.start({ category: "qa", prompt: "C2" })
      if (start.kind !== "started") throw Error("start")
      const record = await api.wait(start.task_id)
      return { id: start.task_id, text: record.final_response }
    }, c2)
    await f.secondInitialization
    const reason = new Error("C1 interrupted"),
      inner = defined(f.initializationWaits[0]).then(
        () => "unexpected facade",
        (error) => error,
      )
    c1.controller.abort(reason)
    expect(await first).toContain("C1 interrupted")
    const beforeRelease = await Promise.race([inner, Bun.sleep(100).then(() => "inner initialization still pending")])
    expect(f.calls.filter((x) => x === "create")).toHaveLength(0)
    expect(f.catalogs()).toBe(1)
    expect(f.initializationWaits).toHaveLength(2)
    f.releaseCatalog()
    const result = await second
    expect(result.text).toBe("result:C2")
    expect(f.calls.filter((x) => x === "create")).toHaveLength(1)
    expect(beforeRelease).toBe(reason)
    expect(f.leases[0]).toBe(f.leases[1])
    const db = new Database(join(f.dir, "parent", "owned-children.sqlite"), { readonly: true })
    const rows = db.query("SELECT body FROM owners").all() as { body: string }[]
    db.close()
    expect(rows.filter((row) => JSON.parse(row.body).released === 0)).toHaveLength(1)
  })
})

test("planned host grant uses each genuine operation source and Native SAME manager before child stage", async () => {
  const scope = Scope.makeUnsafe(),
    requests: PermissionRequest[] = []
  const permission = await Effect.runPromise(
    Effect.provideService(
      acquireEffectPermissionApi({
        assert: (input) =>
          Effect.sync(() => {
            requests.push(input)
          }),
      }),
      Scope.Scope,
      scope,
    ),
  )
  try {
    await fixture(async (f) => {
      let preparations = 0
      await f.useHostGrant({
        permission,
        assertCurrent() {},
        async preparationFor(spec, plan, signal) {
          signal.throwIfAborted()
          expect(spec.admission?.hostAuthority).toBeDefined()
          expect(plan.model).toBe("qa/model")
          preparations++
          return {
            nativeTools: [{ name: "read" }],
            catalog: [{ id: "opaque-read", name: "read", options: { codemode: false } }],
          }
        },
      })
      await Promise.all(
        ["ses_grant_A", "ses_grant_B"].map((id) =>
          f.invoke(async (api) => {
            const result = await api.start({ category: "qa", prompt: id })
            if (result.kind !== "started") throw Error("start")
            return (await api.wait(result.task_id)).final_response
          }, f.raw(id)),
        ),
      )
      expect(preparations).toBe(2)
      expect(requests.map((x) => x.sessionID).sort()).toEqual(["ses_grant_A", "ses_grant_B"])
      expect(
        requests.every((x) => x.action === "subagent" && x.resources[0] === "build" && x.source.type === "tool"),
      ).toBe(true)
      expect(f.calls.filter((x) => x === "create")).toHaveLength(2)
    })
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
  }
})

test("original target planned ASK stays under service close until genuine finalizer joins", async () => {
  const entered = Promise.withResolvers<void>(),
    cleaning = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    scope = Scope.makeUnsafe()
  const permission = await Effect.runPromise(
    Effect.provideService(
      acquireEffectPermissionApi({
        assert: () =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.promise(async () => {
                  cleaning.resolve()
                  await release.promise
                }),
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
  try {
    await fixture(async (f) => {
      await f.useHostGrant({
        permission,
        assertCurrent() {},
        async preparationFor() {
          return { nativeTools: [{ name: "read" }], catalog: [{ id: "r", name: "read", options: { codemode: false } }] }
        },
      })
      const origin = f.raw("ses_planned_ask"),
        outer = f.invoke((api) => api.start({ category: "qa", prompt: "never create" }), origin).catch((error) => error)
      try {
        await entered.promise
        origin.controller.abort(Error("actual unit caller stop"))
        await cleaning.promise
        await outer
        let done = false
        const close = f.service.close().then(() => {
          done = true
        })
        await new Promise<void>((yes) => setImmediate(yes))
        expect(done).toBe(false)
        expect(f.calls).not.toContain("create")
        release.resolve()
        await close
        expect(done).toBe(true)
      } finally {
        release.resolve()
        await outer
      }
    })
  } finally {
    release.resolve()
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
  }
})

test("parent retirement rejects inner initialization wait before catalog release and joins shared cleanup", async () => {
  await fixture(async (f) => {
    f.holdCatalog()
    const origin = f.raw()
    const outer = f
      .invoke(async () => {
        throw Error("retired callback must not run")
      }, origin)
      .catch((error) => error)
    await f.catalogEntered
    const inner = defined(f.initializationWaits[0]).then(
      () => "unexpected facade",
      (error) => error,
    )
    const lease = f.leases[0] as Awaited<ReturnType<Service["parent"]>>
    const retiring = f.service.retire(lease)
    const beforeRelease = await Promise.race([inner, Bun.sleep(100).then(() => "inner initialization still pending")])
    expect(lease.signal.aborted).toBe(false)
    expect(f.calls.filter((x) => x === "create")).toHaveLength(0)
    f.releaseCatalog()
    await retiring
    await outer
    expect(beforeRelease).toBeInstanceOf(Error)
    expect(String(beforeRelease)).toContain("Parent task service retiring")
    expect(lease.signal.aborted).toBe(true)
    expect(f.catalogs()).toBe(1)
  })
})

test("already aborted caller never enters service initialization", async () => {
  await fixture(async (f) => {
    const origin = f.raw(),
      reason = new Error("already interrupted")
    origin.controller.abort(reason)
    await expect(
      f.invoke(async () => {
        throw Error("aborted callback must not run")
      }, origin),
    ).rejects.toBe(reason)
    expect(f.initializationWaits).toHaveLength(0)
    expect(f.catalogs()).toBe(0)
    expect(f.calls).toHaveLength(0)
  })
})

test("caller abort leaves shared initialization rejection observed for the remaining live caller", async () => {
  await fixture(async (f) => {
    f.holdCatalog()
    const origin = f.raw(),
      reason = new Error("C1 leaves failed init"),
      failure = new Error("shared catalog unavailable")
    const first = f
      .invoke(async () => {
        throw Error("C1 callback must not run")
      }, origin)
      .catch((error) => error)
    await f.catalogEntered
    const inner = defined(f.initializationWaits[0]).then(
      () => "unexpected facade",
      (error) => error,
    )
    const second = f
      .invoke(async () => {
        throw Error("C2 callback must not run")
      })
      .catch((error) => error)
    await f.secondInitialization
    origin.controller.abort(reason)
    const beforeRelease = await Promise.race([inner, Bun.sleep(100).then(() => "inner initialization still pending")])
    f.failCatalog(failure)
    f.releaseCatalog()
    await first
    const result = await second
    expect(beforeRelease).toBe(reason)
    expect(String(result)).toContain("shared catalog unavailable")
    expect(f.catalogs()).toBe(1)
    expect(f.calls.filter((x) => x === "create")).toHaveLength(0)
  })
})

test("normal callback return and binding disposal do not cancel an already captured Native250ms launch", async () => {
  await fixture(async (f) => {
    f.holdCreate()
    const result = await f.invoke(async (api) =>
      api.start({ category: "qa", prompt: "background", run_in_background: true }),
    )
    expect(result.kind).toBe("started")
    expect(result.starting).toBe(true)
    expect(f.calls.filter((x) => x === "prompt")).toHaveLength(0)
    f.releaseCreate()
    const done = await f.invoke(async (api) => {
      const record = await api.wait(result.task_id)
      return record.final_response
    })
    expect(done).toBe("result:background")
    expect(f.calls.filter((x) => x === "create")).toHaveLength(1)
  })
})

test("actual Native initial receipt binds completion after its original unit Kernel frame closes", async () => {
  await fixture(async (f) => {
    const original = f.raw()
    const start = await f.invoke(
      (api) => api.start({ category: "qa", prompt: "initial completion", run_in_background: true }),
      original,
    )
    expect(start.kind).toBe("started")
    const done = await f.invoke((api) => api.wait(start.task_id), original)
    expect(done.status).toBe("completed")
    expect(f.synthetics).toHaveLength(0)
    const children = new Database(join(f.dir, "parent", "owned-children.sqlite"), { readonly: true })
    try {
      const saved = children.query("SELECT body FROM children WHERE key=?").get(done.owned_session.journalKey) as {
        body: string
      }
      const row = JSON.parse(saved.body)
      expect(row.turn).toBeUndefined()
      expect(row.admission).toBe("accepted")
      expect(row.receipts[row.inboxID]).toBe("accepted")
    } finally {
      children.close()
    }
    // Manually driven controlled host hook; actual hook/model behavior has a separate live gate.
    await f.afterTool(original.caller)
    expect(f.synthetics).toHaveLength(1)
    expect(defined(f.synthetics[0]).input.sessionID).toBe(original.caller.sessionID)
    expect(defined(f.synthetics[0]).input.text).toContain("result:initial completion")
    const current = await f.invoke(async (api) => api.get(start.task_id), original)
    expect(current.notification.notified_epoch).toBe(current.notification.run_epoch)
    const completions = new Database(join(f.dir, "parent", "owned-completions.sqlite"), { readonly: true })
    try {
      const saved = completions.query("SELECT body FROM intents").all() as { body: string }[]
      expect(saved).toHaveLength(1)
      const intent = JSON.parse(defined(saved[0]).body)
      expect(intent.phase).toBe("accepted")
      expect(intent.bookkeeping).toBe("complete")
      expect(intent.sources[0].taskId).toBe(start.task_id)
      expect(intent.acceptance.id).toBe(defined(f.synthetics[0]).ack.id)
    } finally {
      completions.close()
    }
  })
})

test("Native completion after the original parent idle returns uses fresh quiescence without a new parent call", async () => {
  await fixture(async (f) => {
    const original = f.raw()
    const start = await f.invoke(
      (api) => api.start({ category: "qa", prompt: "block late original model frame", run_in_background: true }),
      original,
    )
    const running = await f.invoke((api) => Promise.resolve(api.get(start.task_id)), original)
    await f.idle(original.caller.sessionID)
    expect(f.synthetics).toHaveLength(0)
    f.enableParentQuiescence(original.caller.sessionID)
    // Complete the SAME controlled child model frame, not another SDK input or a
    // fabricated Native task result. There is no following parent Kernel call/hook.
    f.finishChild(running.child_session_id, "late original model completion")
    let observationTimer: ReturnType<typeof setTimeout> | undefined
    const observed = await Promise.race([
      f.syntheticSubmitted.then(() => true),
      new Promise<boolean>((resolve) => {
        observationTimer = setTimeout(() => resolve(false), 1000)
      }),
    ])
    if (observationTimer) clearTimeout(observationTimer)
    if (!observed)
      console.info(
        "LATE_SERVICE_OBSERVATION",
        JSON.stringify({
          calls: f.calls,
          task: JSON.parse(readFileSync(join(f.dir, "parent", "tasks", start.task_id + ".json"), "utf8")),
        }),
      )
    expect(observed).toBe(true)
    await Bun.sleep(0)
    expect(f.synthetics).toHaveLength(1)
    expect(defined(f.synthetics[0]).input.sessionID).toBe(original.caller.sessionID)
    expect(defined(f.synthetics[0]).input.delivery).toBe("steer")
    expect(defined(f.synthetics[0]).input.text).toContain("late original model completion")
    const task = JSON.parse(readFileSync(join(f.dir, "parent", "tasks", start.task_id + ".json"), "utf8"))
    expect(task.status).toBe("completed")
    expect(task.final_response).toBe("late original model completion")
    expect(task.notification.notified_epoch).toBe(task.notification.run_epoch)
    const db = new Database(join(f.dir, "parent", "owned-completions.sqlite"), { readonly: true })
    try {
      const intents = (db.query("SELECT body FROM intents").all() as { body: string }[]).map((row) =>
        JSON.parse(row.body),
      )
      expect(intents).toHaveLength(1)
      expect(intents[0]).toMatchObject({ phase: "accepted", bookkeeping: "complete" })
    } finally {
      db.close()
    }
    expect(f.calls.filter((call) => call === "create")).toHaveLength(1)
    expect(f.calls.filter((call) => call === "prompt")).toHaveLength(1)
  })
})

test("closing a parent joins its original completion transport and preserves uncertain admission without retry", async () => {
  await fixture(async (f) => {
    const original = f.raw()
    const start = await f.invoke(
      (api) => api.start({ category: "qa", prompt: "held completion", run_in_background: true }),
      original,
    )
    await f.invoke((api) => api.wait(start.task_id), original)
    f.holdSynthetic()
    const hook = f.idle(original.caller.sessionID).then(
      () => undefined,
      (error) => error,
    )
    let observationTimer: ReturnType<typeof setTimeout> | undefined
    try {
      // Race observation signals only; the original hook/transport remains owned and joined below.
      const observed = await Promise.race([
        f.syntheticEntered.then(() => true),
        hook.then(() => false),
        new Promise<boolean>((resolve) => {
          observationTimer = setTimeout(() => resolve(false), 2000)
        }),
      ])
      if (observationTimer) clearTimeout(observationTimer)
      expect(observed).toBe(true)
      await f.service.close().catch(async () => {
        await f.service.close()
      })
      await hook
      expect(f.calls.filter((call) => call === "synthetic")).toHaveLength(1)
      expect(f.calls).toContain("synthetic-abort-joined")
      await f.service.close()
      expect(f.synthetics).toHaveLength(1)
      const db = new Database(join(f.dir, "parent", "owned-completions.sqlite"), { readonly: true })
      try {
        const saved = db.query("SELECT body FROM intents").all() as { body: string }[]
        expect(saved).toHaveLength(1)
        expect(JSON.parse(defined(saved[0]).body).phase).toBe("uncertain")
      } finally {
        db.close()
      }
      const task = JSON.parse(readFileSync(join(f.dir, "parent", "tasks", start.task_id + ".json"), "utf8"))
      expect(task.notification.notified_epoch).toBeLessThan(task.notification.run_epoch)
    } finally {
      if (observationTimer) clearTimeout(observationTimer)
      f.releaseSynthetic()
      await hook
    }
  })
})

test("accepted running steering preserves its original Native epoch completion source", async () => {
  await fixture(async (f) => {
    const original = f.raw()
    const start = await f.invoke(
      (api) => api.start({ category: "qa", prompt: "block until steer", run_in_background: true }),
      original,
    )
    const before = await f.invoke(async (api) => api.get(start.task_id), original)
    const sent = await f.invoke(
      (api) => api.send({ idOrName: start.task_id, message: "steer finishes original epoch", deliverAs: "steer" }),
      original,
    )
    expect(sent.kind).toBe("steered")
    const done = await f.invoke((api) => api.wait(start.task_id), original)
    expect(done.notification.run_epoch).toBe(before.notification.run_epoch)
    expect(done.final_response).toBe("result:steer finishes original epoch")
    const db = new Database(join(f.dir, "parent", "owned-children.sqlite"), { readonly: true })
    try {
      const row = JSON.parse(
        (db.query("SELECT body FROM children WHERE key=?").get(done.owned_session.journalKey) as { body: string }).body,
      )
      expect(row.turn).toBeUndefined()
      expect(row.admission).toBe("accepted")
      expect(row.receipts[row.inboxID]).toBe("accepted")
      expect(Object.values(row.receipts).filter((value) => value === "accepted")).toHaveLength(2)
    } finally {
      db.close()
    }
    await f.afterTool(original.caller)
    expect(f.synthetics).toHaveLength(1)
    expect(defined(f.synthetics[0]).input.text).toContain("result:steer finishes original epoch")
  })
})

test("real terminal reattach restores notification custody without replaying its initial input", async () => {
  await fixture(async (f) => {
    const original = f.raw()
    const start = await f.invoke(
      (api) => api.start({ category: "qa", prompt: "terminal recovered completion", run_in_background: true }),
      original,
    )
    const before = await f.invoke((api) => api.wait(start.task_id), original)
    expect(before.notification.notified_epoch).toBe(-1)
    await f.reopen()
    const recovered = await f.invoke((api) => api.recover(start.task_id), original)
    expect(recovered.status).toBe("completed")
    expect(recovered.notification.run_epoch).toBe(before.notification.run_epoch)
    expect(recovered.child_session_id).toBe(before.child_session_id)
    expect(recovered.owned_session.generation).toBeGreaterThan(before.owned_session.generation)
    expect(f.calls.filter((call) => call === "create")).toHaveLength(1)
    expect(f.calls.filter((call) => call === "prompt")).toHaveLength(1)
    await f.afterTool(original.caller)
    expect(f.synthetics).toHaveLength(1)
    expect(defined(f.synthetics[0]).input.text).toContain("result:terminal recovered completion")
    const current = await f.invoke(async (api) => api.get(start.task_id), original)
    expect(current.notification.notified_epoch).toBe(current.notification.run_epoch)
  })
})

test("Native parked send policy stays intact and real recovery enables its next owned turn", async () => {
  await fixture(async (f) => {
    const original = f.raw()
    const start = await f.invoke(
      (api) => api.start({ category: "qa", prompt: "automatic recovery original", run_in_background: true }),
      original,
    )
    const before = await f.invoke((api) => api.wait(start.task_id), original)
    await f.reopen()
    const parked = await f.invoke(
      (api) =>
        api.operation(async (manager) =>
          manager.sendToTask({
            idOrName: start.task_id,
            message: "automatic recovery next turn",
            deliverAs: "followUp",
            callerSessionId: original.caller.sessionID,
          }),
        ),
      original,
    )
    expect(parked.kind).toBe("not_continuable")
    expect(f.calls.filter((call) => call === "create")).toHaveLength(1)
    expect(f.calls.filter((call) => call === "prompt")).toHaveLength(1)
    await f.invoke((api) => api.recover(start.task_id), original)
    const sent = await f.invoke(
      (api) =>
        api.operation(async (manager) =>
          manager.sendToTask({
            idOrName: start.task_id,
            message: "automatic recovery next turn",
            deliverAs: "followUp",
            callerSessionId: original.caller.sessionID,
          }),
        ),
      original,
    )
    console.info(
      "C2_NATIVE_RECOVERED_SEND",
      JSON.stringify({
        sent,
        current: await f.invoke(
          (api) =>
            api.operation(async (manager) => {
              const record = manager.get(start.task_id)
              return {
                status: record?.status,
                residency: record?.residency_state,
                kind: record?.runner_kind,
                resident: manager.residentTaskIds().includes(start.task_id),
              }
            }),
          original,
        ),
      }),
    )
    expect(sent.kind).toBe("revived")
    const current = await f.invoke((api) => api.wait(start.task_id), original)
    expect(current.child_session_id).toBe(before.child_session_id)
    expect(current.notification.run_epoch).toBeGreaterThan(before.notification.run_epoch)
    expect(f.calls.filter((call) => call === "create")).toHaveLength(1)
    expect(f.calls.filter((call) => call === "prompt")).toHaveLength(2)
    await f.afterTool(original.caller)
    expect(f.synthetics).toHaveLength(1)
    expect(defined(f.synthetics[0]).input.text).toContain("result:automatic recovery next turn")
    const notified = await f.invoke(async (api) => api.get(start.task_id), original)
    expect(notified.notification.notified_epoch).toBe(current.notification.run_epoch)
  })
})

test("failed recovered idle barrier admits no input and releases preparation for a fresh authorized retry", async () => {
  await fixture(async (f) => {
    const original = f.raw()
    const start = await f.invoke(
      (api) => api.start({ category: "qa", prompt: "recovered barrier original", run_in_background: true }),
      original,
    )
    await f.invoke((api) => api.wait(start.task_id), original)
    await f.reopen()
    await f.invoke((api) => api.recover(start.task_id), original)
    f.failWaitOnce()
    const refused = await f.invoke(
      (api) => api.send({ idOrName: start.task_id, message: "must not be sent", deliverAs: "followUp" }),
      original,
    )
    expect(refused.kind).toBe("not_continuable")
    expect(f.calls.filter((call) => call === "prompt")).toHaveLength(1)
    const retried = await f.invoke(
      (api) => api.send({ idOrName: start.task_id, message: "fresh retry after idle barrier", deliverAs: "followUp" }),
      f.raw(),
    )
    expect(retried.kind).toBe("revived")
    const done = await f.invoke((api) => api.wait(start.task_id), f.raw())
    expect(done.final_response).toBe("result:fresh retry after idle barrier")
    expect(f.calls.filter((call) => call === "prompt")).toHaveLength(2)
  })
})

test("parent teardown joins an aborted recovered idle request even when its caller stops waiting", async () => {
  await fixture(async (f) => {
    const original = f.raw()
    const start = await f.invoke(
      (api) => api.start({ category: "qa", prompt: "abort barrier original", run_in_background: true }),
      original,
    )
    await f.invoke((api) => api.wait(start.task_id), original)
    await f.reopen()
    await f.invoke((api) => api.recover(start.task_id), original)
    f.holdWait()
    const cancelling = f.raw()
    const sending = f
      .invoke(
        (api) => api.send({ idOrName: start.task_id, message: "cancelled before new input", deliverAs: "followUp" }),
        cancelling,
      )
      .then(
        (value) => value,
        (error) => error,
      )
    let closing: Promise<void> | undefined,
      closeSettled = false
    try {
      await f.heldWaitEntered
      cancelling.controller.abort(new Error("controlled caller cancellation during original idle wait"))
      await Bun.sleep(0)
      expect(f.calls.filter((call) => call === "prompt")).toHaveLength(1)
      closing = f.service.close().then(
        () => {
          closeSettled = true
        },
        (error) => {
          closeSettled = true
          throw error
        },
      )
      await Bun.sleep(0)
      expect(closeSettled).toBe(false)
    } finally {
      f.releaseWait()
      await sending
      if (closing) await closing
    }
    expect(f.calls.filter((call) => call === "prompt")).toHaveLength(1)
    await f.reopen()
    await f.invoke((api) => api.recover(start.task_id), f.raw())
    const fresh = await f.invoke(
      (api) =>
        api.send({ idOrName: start.task_id, message: "new authorized input after wait joined", deliverAs: "followUp" }),
      f.raw(),
    )
    expect(fresh.kind).toBe("revived")
    const done = await f.invoke((api) => api.wait(start.task_id), f.raw())
    expect(done.final_response).toBe("result:new authorized input after wait joined")
  })
})

test("the captured recovered-terminal exception cannot authorize a later uncertain epoch", async () => {
  await fixture(async (f) => {
    const original = f.raw()
    const start = await f.invoke(
      (api) => api.start({ category: "qa", prompt: "historical recovered epoch", run_in_background: true }),
      original,
    )
    await f.invoke((api) => api.wait(start.task_id), original)
    await f.reopen()
    await f.invoke((api) => api.recover(start.task_id), original)
    const sent = await f.invoke(
      (api) => api.send({ idOrName: start.task_id, message: "first real new epoch", deliverAs: "followUp" }),
      f.raw(),
    )
    expect(sent.kind).toBe("revived")
    const first = await f.invoke((api) => api.wait(start.task_id), f.raw())
    expect(first.notification.run_epoch).toBe(1)
    f.endStreams()
    await Bun.sleep(0)
    const refused = await f.invoke(
      (api) =>
        api.send({
          idOrName: start.task_id,
          message: "must not reuse original recovery exception",
          deliverAs: "followUp",
        }),
      f.raw(),
    )
    expect(refused.kind).toBe("not_continuable")
    expect(f.calls.filter((call) => call === "prompt")).toHaveLength(2)
    const current = await f.invoke(async (api) => api.get(start.task_id), f.raw())
    expect(current.notification.run_epoch).toBe(first.notification.run_epoch)
  })
})

test("a residency claim changed during recovered idle wait refuses before any new input", async () => {
  await fixture(async (f) => {
    const original = f.raw()
    const start = await f.invoke(
      (api) => api.start({ category: "qa", prompt: "claim barrier original", run_in_background: true }),
      original,
    )
    await f.invoke((api) => api.wait(start.task_id), original)
    await f.reopen()
    await f.invoke((api) => api.recover(start.task_id), original)
    const path = join(f.dir, "parent", "tasks", start.task_id + ".json")
    const prior = JSON.parse(readFileSync(path, "utf8"))
    f.holdWait()
    const sending = f
      .invoke(
        (api) => api.send({ idOrName: start.task_id, message: "must not cross changed claim", deliverAs: "followUp" }),
        f.raw(),
      )
      .then(
        (value) => value,
        (error) => ({ kind: "rejected", message: String(error) }),
      )
    try {
      await f.heldWaitEntered
      const changed = JSON.parse(readFileSync(path, "utf8"))
      changed.residency_claim = "controlled-foreign-claim"
      changed.owned_session.residencyClaim = "controlled-foreign-claim"
      writeFileSync(path, JSON.stringify(changed))
      f.releaseWait()
      const result = await sending
      expect(result.kind).not.toBe("revived")
      expect(f.calls.filter((call) => call === "prompt")).toHaveLength(1)
    } finally {
      const current = JSON.parse(readFileSync(path, "utf8"))
      current.residency_claim = prior.residency_claim
      current.owned_session.residencyClaim = prior.owned_session.residencyClaim
      writeFileSync(path, JSON.stringify(current))
      f.releaseWait()
      await sending
    }
  })
})

test("an uncertain recovered admission ledger never authorizes a fresh input", async () => {
  await fixture(async (f) => {
    const original = f.raw()
    const start = await f.invoke(
      (api) => api.start({ category: "qa", prompt: "uncertain recovered ledger", run_in_background: true }),
      original,
    )
    const before = await f.invoke((api) => api.wait(start.task_id), original)
    await f.reopen()
    // Controlled durable fault, not a manufactured ACK or live SDK event.
    const db = new Database(join(f.dir, "parent", "owned-children.sqlite"))
    try {
      const key = before.owned_session.journalKey
      const row = JSON.parse((db.query("SELECT body FROM children WHERE key=?").get(key) as { body: string }).body)
      row.revision++
      row.phase = "uncertain"
      row.admission = "uncertain"
      row.receipts[row.inboxID] = "uncertain"
      db.query("UPDATE children SET body=? WHERE key=?").run(JSON.stringify(row), key)
    } finally {
      db.close()
    }
    await f.invoke((api) => api.recover(start.task_id), original)
    const result = await f.invoke(
      (api) => api.send({ idOrName: start.task_id, message: "must not infer old acceptance", deliverAs: "followUp" }),
      f.raw(),
    )
    expect(result.kind).toBe("not_continuable")
    expect(f.calls.filter((call) => call === "create")).toHaveLength(1)
    expect(f.calls.filter((call) => call === "prompt")).toHaveLength(1)
    const current = await f.invoke(async (api) => api.get(start.task_id), f.raw())
    expect(current.notification.run_epoch).toBe(before.notification.run_epoch)
  })
})

test.each(["observer-await", "native-stamp"] as const)(
  "recovered birth and root remain fenced at %s",
  async (point) => {
    await fixture(async (f) => {
      const original = f.raw()
      const start = await f.invoke(
        (api) => api.start({ category: "qa", prompt: "recovered final fence", run_in_background: true }),
        original,
      )
      await f.invoke((api) => api.wait(start.task_id), original)
      await f.reopen()
      await f.invoke((api) => api.recover(start.task_id), original)
      const path = join(f.dir, "parent", "tasks", start.task_id + ".json"),
        before = JSON.parse(readFileSync(path, "utf8"))
      let returnedTicket = false,
        restore = () => {}
      function alterRecord() {
        const row = JSON.parse(readFileSync(path, "utf8"))
        if (point === "observer-await") row.created_at = "2025-01-01T00:00:00.000Z"
        else row.root_session_id = "controlled-foreign-root"
        writeFileSync(path, JSON.stringify(row))
      }
      await f.invoke(
        (api) =>
          api.operation(async (manager) => {
            const handle = manager.getResidentHandle(start.task_id)
            if (!handle?.prepareFollowUp) throw Error("Actual recovered preparation unavailable")
            const method = handle.prepareFollowUp
            const observed = new Proxy(method, {
              apply(fn, receiver, args) {
                return Reflect.apply(fn, receiver, args).then((ticket: Awaited<ReturnType<typeof method>>) => {
                  returnedTicket = true
                  if (point === "native-stamp") alterRecord()
                  return ticket
                })
              },
            })
            if (!Reflect.set(handle, "prepareFollowUp", observed))
              throw Error("Actual preparation observer unavailable")
            restore = () => {
              if (handle.prepareFollowUp !== observed || !Reflect.set(handle, "prepareFollowUp", method))
                throw Error("Actual preparation observer changed")
            }
          }),
        original,
      )
      if (point === "observer-await") f.holdObserverUpdate()
      const sending = f
        .invoke(
          (api) => api.send({ idOrName: start.task_id, message: "must remain unadmitted", deliverAs: "followUp" }),
          f.raw(),
        )
        .then(
          (value) => value,
          (error) => ({ kind: "rejected", message: String(error) }),
        )
      try {
        if (point === "observer-await") {
          await f.observerUpdateEntered
          alterRecord()
          f.releaseObserverUpdate()
        }
        const result = await sending
        expect(result.kind).not.toBe("revived")
        expect(returnedTicket).toBe(point === "native-stamp")
        expect(f.calls.filter((call) => call === "prompt")).toHaveLength(1)
        const current = JSON.parse(readFileSync(path, "utf8"))
        expect(current.notification.run_epoch).toBe(before.notification.run_epoch)
      } finally {
        f.releaseObserverUpdate()
        await sending
        restore()
        const current = JSON.parse(readFileSync(path, "utf8"))
        current.created_at = before.created_at
        current.root_session_id = before.root_session_id
        writeFileSync(path, JSON.stringify(current))
      }
    })
  },
)

test("retained facade and copied authority cannot initiate new actions after authorized target return", async () => {
  await fixture(async (f) => {
    let retained: Facade | undefined
    await f.invoke(async (api) => {
      retained = api
      return { ok: true }
    })
    expect(() => defined(retained).start({ category: "qa", prompt: "forbidden" })).toThrow("authorized")
    expect(() => defined(retained).get("unknown")).toThrow("authorized")
    expect(() => defined(retained).end("unknown")).toThrow("authorized")
    expect(f.calls.filter((x) => x === "create")).toHaveLength(0)
  })
})

test("a different root's current frame cannot authorize a retained Native manager", async () => {
  await fixture(async (f) => {
    const original = f.raw("original-root"),
      other = f.raw("other-root")
    let retained: TaskManager | undefined
    await f.invoke(
      (api) =>
        api.operation(async (manager) => {
          retained = manager
          return { captured: true }
        }),
      original,
    )
    const spec = {
      category: "qa",
      prompt: "same original manager",
      run_in_background: true,
      parent_session_id: original.caller.sessionID,
      root_session_id: original.caller.sessionID,
      depth: 1,
    }
    const foreign = await f.invoke(
      (api) =>
        api.operation(async () =>
          defined(retained)
            .start(spec)
            .catch((error) => ({ kind: "thrown", message: String(error) })),
        ),
      other,
    )
    expect(foreign.kind).not.toBe("started")
    expect(f.calls.filter((call) => call === "create")).toHaveLength(0)
    const own = await f.invoke(
      (api) =>
        api.operation(async (manager) => {
          expect(manager === retained).toBe(true)
          return defined(retained).start(spec)
        }),
      original,
    )
    expect(own.kind).toBe("started")
    const completed = await f.invoke(async (api) => (await api.wait(own.task_id)).status, original)
    expect(completed).toBe("completed")
  })
})

test("parent replacement joins actual old quiescence before two callers share one new live lease", async () => {
  await fixture(async (f) => {
    await f.invoke(async (api) => api.start({ category: "qa", prompt: "block active", run_in_background: true }))
    const old = f.leases[0] as Awaited<ReturnType<Service["parent"]>>
    f.holdWait()
    const retiring = f.service.retire(old)
    await f.waitEntered
    const c2 = f.raw(),
      c3 = f.raw(),
      a = f.service.parent(c2.caller),
      b = f.service.parent(c3.caller)
    expect(old.signal.aborted).toBe(false)
    f.releaseWait()
    await retiring
    const [second, third] = await Promise.all([a, b])
    expect(second).toBe(third)
    expect(second).not.toBe(old)
    expect(old.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    expect(f.blocked.size).toBe(0)
  })
})

test("a call of the next plugin generation waits for the previous generation's park before it reads any task row", async () => {
  await fixture(async (f) => {
    // given: a previous generation of this project still closing in this process
    const previous = Promise.withResolvers<undefined>()
    let settledWaits = 0
    Object.assign(f.options, {
      predecessors: {
        async predecessorsSettled(signal?: AbortSignal) {
          signal?.throwIfAborted()
          await previous.promise
          settledWaits++
        },
      },
    })
    await f.reopen()
    const reads = f.calls.length,
      waiting = f.raw(),
      aborted = f.raw()
    // when
    let lease: unknown
    const parent = f.service.parent(waiting.caller).then((value) => {
      lease = value
    })
    const refused = f.service.parent(aborted.caller)
    aborted.controller.abort(Error("caller gone"))
    await Bun.sleep(20)
    // then
    expect(lease).toBeUndefined()
    expect(f.calls.length).toBe(reads)
    previous.resolve(undefined)
    await parent
    await expect(refused).rejects.toThrow("caller gone")
    expect(settledWaits).toBeGreaterThanOrEqual(1)
    expect(lease).toBeDefined()
  })
})

test("failed retirement retains old lease and rejects replacement until actual cleanup retry succeeds", async () => {
  await fixture(async (f) => {
    await f.invoke(async (api) => api.start({ category: "qa", prompt: "block active", run_in_background: true }))
    const old = f.leases[0] as Awaited<ReturnType<Service["parent"]>>
    f.failChildGetOnce()
    await expect(f.service.retire(old)).rejects.toThrow()
    expect(old.signal.aborted).toBe(false)
    await expect(f.service.parent(f.raw().caller)).rejects.toThrow("cleanup")
    await f.service.retire(old)
    expect(old.signal.aborted).toBe(true)
    expect(f.blocked.size).toBe(0)
    const next = await f.service.parent(f.raw().caller)
    expect(next).not.toBe(old)
    expect(next.signal.aborted).toBe(false)
  })
})

test("read-only Native wait is cancelled by callback binding disposal without cancelling its accepted child", async () => {
  await fixture(async (f) => {
    let query: Promise<string> | undefined
    const started = await f.invoke(async (api) => {
      const result = await api.start({ category: "qa", prompt: "block active", run_in_background: true })
      if (result.kind !== "started") throw Error("start")
      query = api.wait(result.task_id).then(
        () => "wrong completed",
        () => "query cancelled",
      )
      return result
    })
    expect(await Promise.race([defined(query), Bun.sleep(80).then(() => "waiter leaked")])).toBe("query cancelled")
    const status = await f.invoke(async (api) => api.get(started.task_id)?.status)
    expect(status).toBe("running")
    expect(f.blocked.size).toBe(1)
    await f.invoke(async (api) => {
      await api.end(started.task_id)
      return { ended: true }
    })
  })
})

test("actual caller abort during staged create admits zero input and independent service owner joins cleanup", async () => {
  await fixture(async (f) => {
    f.holdCreate()
    const c = f.raw()
    const pending = f
      .invoke(async (api) => api.start({ category: "qa", prompt: "never admitted", run_in_background: true }), c)
      .catch((error) => String(error))
    await f.createEntered
    c.controller.abort(new Error("actual current caller interrupted"))
    expect(await pending).toContain("actual current caller interrupted")
    f.releaseCreate()
    await f.service.close()
    expect(f.calls.filter((x) => x === "prompt")).toHaveLength(0)
    expect(f.calls.filter((x) => x === "create")).toHaveLength(1)
    expect(f.calls.filter((x) => x === "remove")).toHaveLength(1)
  })
})

test("retired registry aborts admission but keeps actual parent lease until old child quiescence joins", async () => {
  await fixture(async (f) => {
    await f.invoke(async (api) => api.start({ category: "qa", prompt: "block active", run_in_background: true }))
    const old = f.leases[0] as Awaited<ReturnType<Service["parent"]>>
    f.holdWait()
    f.registry.replace([f.tool])
    await f.waitEntered
    expect(old.signal.aborted).toBe(false)
    expect(f.calls).not.toContain("policy-disposed")
    const next = f.service.parent(f.raw().caller)
    f.releaseWait()
    const lease = await next
    expect(old.signal.aborted).toBe(true)
    expect(lease).not.toBe(old)
    expect(lease.signal.aborted).toBe(false)
    expect(f.blocked.size).toBe(0)
  })
})

test("initialization failure closes its real store/database before a same-parent fresh authorized retry", async () => {
  await fixture(async (f) => {
    const parent = f.raw()
    await f.service.parent(parent.caller)
    const dir = join(f.dir, "parent"),
      path = join(dir, "owned-children.sqlite")
    mkdirSync(dir, { recursive: true })
    const bad = new Database(path)
    bad.exec("CREATE TABLE foreign_data (id TEXT)")
    bad.close()
    await expect(f.invoke(async (api) => api.start({ category: "qa", prompt: "not created" }), parent)).rejects.toThrow(
      "Foreign",
    )
    expect(f.calls.filter((x) => x === "create")).toHaveLength(0)
    rmSync(path)
    const result = await f.invoke(async (api) => {
      const started = await api.start({ category: "qa", prompt: "healthy retry" })
      if (started.kind !== "started") throw Error("start")
      return (await api.wait(started.task_id)).final_response
    })
    expect(result).toBe("result:healthy retry")
    expect(f.calls.filter((x) => x === "create")).toHaveLength(1)
  })
})

test("raw unissued caller and a foreign parent's task ID refuse without child mutation", async () => {
  await fixture(async (f) => {
    const raw = f.raw()
    await f.service.parent(raw.caller)
    await expect(f.service.forCall(raw.caller)).rejects.toThrow("authorized")
    expect(f.catalogs()).toBe(0)
    const started = await f.invoke(async (api) => api.start({ category: "qa", prompt: "owned" }), raw)
    const before = f.calls.filter((x) => ["create", "prompt", "remove", "interrupt"].includes(x))
    await expect(f.invoke(async (api) => api.get(started.task_id), f.raw("foreign-parent"))).rejects.toThrow("scope")
    expect(f.calls.filter((x) => ["create", "prompt", "remove", "interrupt"].includes(x))).toEqual(before)
    await f.invoke(async (api) => {
      await api.end(started.task_id)
      return { ended: true }
    })
  })
})

test("policy disposal fails once before removal; parent retirement retries the actual registration", async () => {
  await fixture(async (f) => {
    await f.invoke(async (api) => api.start({ category: "qa", prompt: "block policy retry", run_in_background: true }))
    const lease = f.leases[0] as Awaited<ReturnType<Service["parent"]>>
    f.failPolicyDisposeOnce()
    const first = await f.service.retire(lease).then(
      () => null,
      (error) => String(error),
    )
    expect(first).not.toBe(null)
    expect(lease.signal.aborted).toBe(false)
    expect(f.calls.filter((x) => x === "policy-disposed")).toHaveLength(0)
    const second = await f.service.retire(lease).then(
      () => null,
      (error) => String(error),
    )
    console.log(
      "POLICY_RETIRE_RETRY",
      JSON.stringify({
        first,
        second,
        attempts: f.calls.filter((x) => x === "policy-dispose-attempt").length,
        disposed: f.calls.filter((x) => x === "policy-disposed").length,
        leaseAborted: lease.signal.aborted,
      }),
    )
    expect(second).toBe(null)
    expect(f.calls.filter((x) => x === "policy-dispose-attempt")).toHaveLength(2)
    expect(f.calls.filter((x) => x === "policy-disposed")).toHaveLength(1)
    expect(lease.signal.aborted).toBe(true)
  })
})

test("a durable closed child still finishes retained policy cleanup on explicit END retry", async () => {
  await fixture(async (f) => {
    const start = await f.invoke(async (api) =>
      api.start({ category: "qa", prompt: "END policy retry", run_in_background: true }),
    )
    f.failPolicyDisposeOnce()
    const first = await f
      .invoke(async (api) => {
        await api.end(start.task_id)
        return null
      })
      .then(
        () => null,
        (error) => String(error),
      )
    expect(first).not.toBe(null)
    expect(f.calls.filter((x) => x === "remove")).toHaveLength(1)
    expect(f.calls.filter((x) => x === "policy-disposed")).toHaveLength(0)
    const second = await f
      .invoke(async (api) => {
        await api.end(start.task_id)
        return null
      })
      .then(
        () => null,
        (error) => String(error),
      )
    console.log(
      "POLICY_END_RETRY",
      JSON.stringify({
        first,
        second,
        attempts: f.calls.filter((x) => x === "policy-dispose-attempt").length,
        disposed: f.calls.filter((x) => x === "policy-disposed").length,
        removed: f.calls.filter((x) => x === "remove").length,
      }),
    )
    expect(second).toBe(null)
    expect(f.calls.filter((x) => x === "policy-dispose-attempt")).toHaveLength(2)
    expect(f.calls.filter((x) => x === "policy-disposed")).toHaveLength(1)
    expect(f.calls.filter((x) => x === "remove")).toHaveLength(1)
  })
})

test("adopting a genuine owned child as a task parent must not replace its backend lease", async () => {
  await fixture(async (f) => {
    const origin = f.raw(),
      start = await f.invoke(async (api) => api.start({ category: "qa", prompt: "block" }), origin)
    if (start.kind !== "started") throw Error("start")
    const record = await f.invoke(async (api) => api.get(start.task_id), origin)
    const childCaller = { ...origin.caller, sessionID: record.child_session_id } as ToolContext
    await f.service.parent(childCaller)
    await f.invoke(async (api) => api.end(start.task_id), origin)
    expect(f.calls.filter((x) => x === "remove")).toHaveLength(1)
  })
})

test("child Native operation shares root manager, ancestry and the foreground parked lane", async () => {
  await fixture(async (f) => {
    f.setConcurrency(1)
    const root = f.raw()
    let rootManager: unknown, childManager: unknown
    const start = await f.invoke(
      (api) =>
        api.operation(async (manager) => {
          rootManager = manager
          return api.start({ category: "qa", prompt: "block" })
        }),
      root,
    )
    if (start.kind !== "started") throw Error("start")
    const parent = await f.invoke((api) => Promise.resolve(api.get(start.task_id)), root)
    const controller = new AbortController(),
      child = {
        caller: {
          ...root.caller,
          sessionID: parent.child_session_id,
          id: "child-call",
          messageID: "child-message",
          signal: controller.signal,
        } as ToolContext,
        controller,
      }
    const result = await f.invoke(
      (api) =>
        api.operation(async (manager, resolveAncestry, signal) => {
          childManager = manager
          expect(manager.findTaskByChildSession?.(child.caller.sessionID)?.task_id).toBe(start.task_id)
          expect(resolveAncestry(child.caller.sessionID)).toEqual({ rootSessionId: root.caller.sessionID, depth: 1 })
          let prepared = false
          return buildTaskExecute({
            manager,
            agents: {},
            omoConfig: {
              categories: { qa: { model: "qa/model" } },
              task: OmoTaskSettingsSchema.parse({ max_depth: 2, default_execution_mode: "in-process" }),
            },
            resolveAncestry,
            async prepareRuntime() {
              await f.ctx.model.list()
              prepared = true
            },
            loadSkills() {
              if (!prepared) throw Error("catalog not prepared")
              return { prepend: "", resolved: [], missing: [] }
            },
          })(child.caller.id, { category: "qa", prompt: "grandchild", run_in_background: false }, signal, undefined, {
            cwd: f.dir,
            sessionManager: { getSessionId: () => child.caller.sessionID },
          })
        }),
      child,
    )
    expect(childManager).toBe(rootManager)
    expect(result.details.status).toBe("completed")
    const grandchild = await f.invoke((api) => Promise.resolve(api.get(result.details.task_id)), root)
    expect(grandchild.parent_session_id).toBe(child.caller.sessionID)
    expect(grandchild.root_session_id).toBe(root.caller.sessionID)
    expect(grandchild.depth).toBe(2)
    await f.invoke((api) => api.end(start.task_id), root)
    expect(f.calls.filter((x) => x === "remove")).toHaveLength(2)
  })
})

test("parallel owned child callbacks reuse one lease and stale/foreign ancestry cannot mint a root", async () => {
  await fixture(async (f) => {
    const root = f.raw(),
      start = await f.invoke((api) => api.start({ category: "qa", prompt: "block" }), root)
    const row = await f.invoke((api) => Promise.resolve(api.get(start.task_id)), root)
    const child = { ...root.caller, sessionID: row.child_session_id } as ToolContext
    const [a, b] = await Promise.all([f.service.parent(child), f.service.parent(child)])
    expect(a).toBe(b)
    expect(a.signal.aborted).toBe(false)
    await expect(f.service.parent({ ...child, sessionID: "unknown" } as ToolContext)).rejects.toThrow()
    await f.invoke((api) => api.end(start.task_id), root)
    await expect(f.service.parent(child)).rejects.toThrow()
  })
})

test("ancestor END settles a foreground Native body with borrower stop before SDK lease retirement", async () => {
  await fixture(async (f) => {
    f.setConcurrency(1)
    const root = f.raw(),
      start = await f.invoke((api) => api.start({ category: "qa", prompt: "block" }), root)
    const row = await f.invoke((api) => Promise.resolve(api.get(start.task_id)), root)
    const controller = new AbortController(),
      child = {
        caller: {
          ...root.caller,
          sessionID: row.child_session_id,
          id: "foreground-child",
          messageID: "foreground-message",
          signal: controller.signal,
        } as ToolContext,
        controller,
      }
    let bodySettled = false
    const pending = f
      .invoke(
        (api) =>
          api.operation(async (manager, resolveAncestry, signal) => {
            try {
              return await buildTaskExecute({
                manager,
                agents: {},
                omoConfig: {
                  categories: { qa: { model: "qa/model" } },
                  task: OmoTaskSettingsSchema.parse({ max_depth: 2, default_execution_mode: "in-process" }),
                },
                resolveAncestry,
                prepareRuntime: async () => {
                  await f.ctx.model.list()
                },
                loadSkills: () => ({ prepend: "", resolved: [], missing: [] }),
              })(child.caller.id, { category: "qa", prompt: "block", run_in_background: false }, signal, undefined, {
                cwd: f.dir,
                sessionManager: { getSessionId: () => child.caller.sessionID },
              })
            } finally {
              bodySettled = true
            }
          }),
        child,
      )
      .catch((error) => String(error))
    const deadline = Date.now() + 2000
    while (f.blocked.size < 2 && Date.now() < deadline) await Bun.sleep(5)
    expect(f.blocked.size).toBe(2)
    await f.invoke((api) => api.end(start.task_id), root)
    await pending
    expect(bodySettled).toBe(true)
    expect(controller.signal.aborted).toBe(false)
    expect(f.calls.filter((x) => x === "remove")).toHaveLength(2)
  })
})

test("accepted child queue retains its original borrowed parent after the callback returns", async () => {
  await fixture(async (f) => {
    f.setConcurrency(1)
    const root = f.raw(),
      parent = await f.invoke((api) => api.start({ category: "qa", prompt: "block" }), root)
    const row = await f.invoke((api) => Promise.resolve(api.get(parent.task_id)), root)
    const child = {
      caller: {
        ...root.caller,
        sessionID: row.child_session_id,
        id: "queued-child",
        messageID: "queued-message",
      } as ToolContext,
      controller: root.controller,
    }
    const queued = await f.invoke(
      (api) => api.start({ category: "qa", prompt: "queued-grandchild", run_in_background: true }),
      child,
    )
    expect(queued.kind).toBe("started")
    expect(queued.status).toBe("pending")
    expect(f.calls.filter((x) => x === "create")).toHaveLength(1)
    let restore: (() => Promise<void>) | undefined
    await f.invoke(
      (api) =>
        api.operation(async (manager) => {
          const parked = manager.concurrency?.park(parent.task_id, row.notification.run_epoch)
          if (!parked) throw Error("No actual parent lane")
          restore = () => defined(manager.concurrency).unpark(parked)
          return null
        }),
      root,
    )
    const complete = await f.invoke((api) => api.wait(queued.task_id), root)
    expect(complete.parent_session_id).toBe(child.caller.sessionID)
    expect(complete.root_session_id).toBe(root.caller.sessionID)
    expect(complete.depth).toBe(2)
    expect(complete.final_response).toBe("result:queued-grandchild")
    await f.invoke(
      (api) =>
        api.operation(async () => {
          await defined(restore)()
          return null
        }),
      root,
    )
    await f.invoke((api) => api.end(parent.task_id), root)
    expect(f.calls.filter((x) => x === "remove")).toHaveLength(2)
  })
})

test("subtree detach removes an accepted queued grandchild before ancestor lane release", async () => {
  await fixture(async (f) => {
    f.setConcurrency(1)
    const root = f.raw(),
      parent = await f.invoke((api) => api.start({ category: "qa", prompt: "block" }), root)
    const row = await f.invoke((api) => Promise.resolve(api.get(parent.task_id)), root)
    const child = {
      caller: {
        ...root.caller,
        sessionID: row.child_session_id,
        id: "held-queue",
        messageID: "held-message",
      } as ToolContext,
      controller: root.controller,
    }
    const queued = await f.invoke(
      (api) => api.start({ category: "qa", prompt: "never-input", run_in_background: true }),
      child,
    )
    expect(queued.status).toBe("pending")
    await f.invoke((api) => api.detach(parent.task_id), root)
    const retained = await f.invoke((api) => Promise.resolve(api.get(queued.task_id)), root)
    expect(retained.residency_state).toBe("persisted_only")
    expect(retained.child_session_id).toBeUndefined()
    expect(f.calls.filter((x) => x === "create")).toHaveLength(1)
    expect(f.calls.filter((x) => x === "prompt")).toHaveLength(1)
  })
})

test("parent-first recovery keeps actual child IDs, rejects old borrowers and preserves rebound uncertainty", async () => {
  await fixture(async (f) => {
    const root = f.raw(),
      parent = await f.invoke((api) => api.start({ category: "qa", prompt: "block" }), root)
    const before = await f.invoke((api) => Promise.resolve(api.get(parent.task_id)), root)
    const child = {
      caller: {
        ...root.caller,
        sessionID: before.child_session_id,
        id: "recover-child",
        messageID: "recover-message",
      } as ToolContext,
      controller: root.controller,
    }
    const oldLease = await f.service.parent(child.caller)
    const grand = await f.invoke(
      (api) => api.start({ category: "qa", prompt: "block", run_in_background: true }),
      child,
    )
    const beforeGrand = await f.invoke((api) => Promise.resolve(api.get(grand.task_id)), root)
    await f.invoke((api) => api.detach(parent.task_id), root)
    expect(oldLease.signal.aborted).toBe(true)
    await f.invoke((api) => api.recover(grand.task_id), root)
    const after = await f.invoke((api) => Promise.resolve(api.get(parent.task_id)), root),
      afterGrand = await f.invoke((api) => Promise.resolve(api.get(grand.task_id)), root)
    expect(after.child_session_id).toBe(before.child_session_id)
    expect(afterGrand.child_session_id).toBe(beforeGrand.child_session_id)
    expect(after.owned_session.journalRevision).toBeGreaterThan(before.owned_session.journalRevision)
    expect(afterGrand.owned_session.generation).toBeGreaterThan(beforeGrand.owned_session.generation)
    const renewedLease = await f.service.parent(child.caller)
    expect(renewedLease).not.toBe(oldLease)
    await expect(f.invoke((api) => api.wait(parent.task_id), root)).rejects.toThrow("uncertain")
    expect(f.calls.filter((x) => x === "create")).toHaveLength(2)
    expect(f.calls.filter((x) => x === "prompt")).toHaveLength(2)
    await f.invoke((api) => api.end(parent.task_id), root)
  })
})

test("descendant inherits the immediate restricted policy and cannot widen or route around it", async () => {
  await fixture(async (f) => {
    f.setPolicyTools(["native_probe", "write"])
    f.addAgent({
      name: "reader",
      model: "qa/model",
      tools: [
        { pattern: "native_probe", allow: true },
        { pattern: "write", allow: false },
      ],
    })
    f.addAgent({ name: "writer", model: "qa/model", tools: [{ pattern: "write", allow: true }] })
    const root = f.raw(),
      parent = await f.invoke((api) => api.start({ subagent_type: "reader", prompt: "block" }), root)
    if (parent.kind !== "started") throw Error("reader")
    const row = await f.invoke((api) => Promise.resolve(api.get(parent.task_id)), root),
      childCaller = { ...root.caller, sessionID: row.child_session_id } as ToolContext
    const lease = await f.service.parent(childCaller)
    await expect(
      f.scopes.authorize(lease, { requested: "native_probe", routed: "native_probe", input: {} }),
    ).resolves.toBeUndefined()
    await expect(f.scopes.authorize(lease, { requested: "native_probe", routed: "write", input: {} })).rejects.toThrow(
      "outside session scope",
    )
    const child = { caller: childCaller, controller: root.controller }
    const denied = await f.invoke((api) => api.start({ subagent_type: "writer", prompt: "must-not-create" }), child)
    expect(denied.kind).toBe("start_failed")
    expect(f.calls.filter((x) => x === "create")).toHaveLength(1)
    const grand = await f.invoke((api) => api.start({ category: "qa", prompt: "block" }), child)
    const grandRow = await f.invoke((api) => Promise.resolve(api.get(grand.task_id)), root),
      grandCaller = { ...childCaller, sessionID: grandRow.child_session_id } as ToolContext
    const grandLease = await f.service.parent(grandCaller)
    await expect(f.scopes.authorize(grandLease, { requested: "write", routed: "write", input: {} })).rejects.toThrow(
      "outside session scope",
    )
    await f.invoke((api) => api.end(parent.task_id), root)
  })
})

test("Native depth refusal and configured allowed-subagent exception use the verified depth", async () => {
  await fixture(async (f) => {
    f.setMaxDepth(1)
    f.addAgent({ name: "keeper", model: "qa/model", allowedSubagents: ["keeper"] })
    const root = f.raw(),
      parent = await f.invoke((api) => api.start({ category: "qa", prompt: "block" }), root)
    const row = await f.invoke((api) => Promise.resolve(api.get(parent.task_id)), root),
      child = {
        caller: { ...root.caller, sessionID: row.child_session_id } as ToolContext,
        controller: root.controller,
      }
    const refused = await f.invoke((api) => api.start({ category: "qa", prompt: "too deep" }), child)
    expect(refused).toMatchObject({ kind: "depth_denied", child_depth: 2, max_depth: 1 })
    expect(f.calls.filter((x) => x === "create")).toHaveLength(1)
    const allowed = await f.invoke(
      (api) => api.start({ subagent_type: "keeper", prompt: "allowed", run_in_background: true }),
      child,
    )
    expect(allowed.kind).toBe("started")
    const complete = await f.invoke((api) => api.wait(allowed.task_id), root)
    expect(complete.depth).toBe(2)
    await f.invoke((api) => api.end(parent.task_id), root)
  })
})

test("subtree cleanup failure retains the live ancestor and retries the original leaf policy closer", async () => {
  await fixture(async (f) => {
    const root = f.raw(),
      parent = await f.invoke((api) => api.start({ category: "qa", prompt: "block" }), root)
    const row = await f.invoke((api) => Promise.resolve(api.get(parent.task_id)), root),
      child = {
        caller: { ...root.caller, sessionID: row.child_session_id } as ToolContext,
        controller: root.controller,
      }
    const grand = await f.invoke((api) => api.start({ category: "qa", prompt: "leaf", run_in_background: true }), child)
    await f.invoke((api) => api.wait(grand.task_id), root)
    f.failPolicyDisposeOnce()
    const first = await f
      .invoke((api) => api.end(parent.task_id), root)
      .then(
        () => null,
        (error) => String(error),
      )
    expect(first).toContain("policy dispose failed")
    const before = f.calls.filter((x) => x === "remove").length
    expect(before).toBe(1)
    expect((await f.ctx.session.get({ sessionID: row.child_session_id })).id).toBe(row.child_session_id)
    await f.invoke((api) => api.end(parent.task_id), root)
    expect(f.calls.filter((x) => x === "remove")).toHaveLength(2)
    expect(f.calls.filter((x) => x === "policy-dispose-failed")).toHaveLength(1)
  })
})

test("root close parks the complete shared tree after stopping foreground borrower waits", async () => {
  await fixture(async (f) => {
    f.setConcurrency(1)
    const root = f.raw(),
      parent = await f.invoke((api) => api.start({ category: "qa", prompt: "block" }), root)
    const row = await f.invoke((api) => Promise.resolve(api.get(parent.task_id)), root)
    const controller = new AbortController(),
      child = {
        caller: {
          ...root.caller,
          sessionID: row.child_session_id,
          id: "root-close-child",
          messageID: "root-close-message",
          signal: controller.signal,
        } as ToolContext,
        controller,
      }
    let settled = false
    const pending = f
      .invoke(
        (api) =>
          api.operation(async (manager, resolveAncestry, signal) => {
            try {
              return await buildTaskExecute({
                manager,
                agents: {},
                omoConfig: {
                  categories: { qa: { model: "qa/model" } },
                  task: OmoTaskSettingsSchema.parse({ max_depth: 2, default_execution_mode: "in-process" }),
                },
                resolveAncestry,
                prepareRuntime: async () => {
                  await f.ctx.model.list()
                },
                loadSkills: () => ({ prepend: "", resolved: [], missing: [] }),
              })(child.caller.id, { category: "qa", prompt: "block" }, signal, undefined, {
                cwd: f.dir,
                sessionManager: { getSessionId: () => child.caller.sessionID },
              })
            } finally {
              settled = true
            }
          }),
        child,
      )
      .catch((error) => String(error))
    const deadline = Date.now() + 2000
    while (f.blocked.size < 2 && Date.now() < deadline) await Bun.sleep(5)
    expect(f.blocked.size).toBe(2)
    await f.service.close()
    await pending
    expect(settled).toBe(true)
    expect(controller.signal.aborted).toBe(false)
    expect(f.calls.filter((x) => x === "policy-disposed")).toHaveLength(2)
    await expect(f.service.parent(root.caller)).rejects.toThrow("closing")
  })
})

test("a new root manager generation recovers the persisted tree parent-first without SDK child replay", async () => {
  await fixture(async (f) => {
    const root = f.raw()
    let oldManager: unknown, newManager: unknown
    const parent = await f.invoke(
      (api) =>
        api.operation(async (manager) => {
          oldManager = manager
          return api.start({ category: "qa", prompt: "block" })
        }),
      root,
    )
    const p = await f.invoke((api) => Promise.resolve(api.get(parent.task_id)), root),
      child = { caller: { ...root.caller, sessionID: p.child_session_id } as ToolContext, controller: root.controller }
    const oldLease = await f.service.parent(child.caller),
      grand = await f.invoke((api) => api.start({ category: "qa", prompt: "block", run_in_background: true }), child)
    const g = await f.invoke((api) => Promise.resolve(api.get(grand.task_id)), root)
    const next = await f.reopen()
    expect(oldLease.signal.aborted).toBe(true)
    const cold = await f.invoke((api) => Promise.resolve(api.get(grand.task_id)), root)
    expect(cold.child_session_id).toBe(g.child_session_id)
    await f.invoke(
      (api) =>
        api.operation(async (manager) => {
          newManager = manager
          return api.recover(grand.task_id)
        }),
      root,
    )
    expect(newManager).not.toBe(oldManager)
    const restored = await f.invoke((api) => Promise.resolve(api.get(parent.task_id)), root),
      restoredGrand = await f.invoke((api) => Promise.resolve(api.get(grand.task_id)), root)
    expect(restored.child_session_id).toBe(p.child_session_id)
    expect(restoredGrand.child_session_id).toBe(g.child_session_id)
    expect(restored.owned_session.journalOwner).not.toBe(p.owned_session.journalOwner)
    const renewedLease = await next.parent(child.caller)
    expect(renewedLease).not.toBe(oldLease)
    await expect(f.invoke((api) => api.wait(parent.task_id), root)).rejects.toThrow("uncertain")
    expect(f.calls.filter((x) => x === "create")).toHaveLength(2)
    expect(f.calls.filter((x) => x === "prompt")).toHaveLength(2)
    await f.invoke((api) => api.end(parent.task_id), root)
  })
})

test("rebound lease grants no action by itself; only a new current frame can start a distinct descendant", async () => {
  await fixture(async (f) => {
    const root = f.raw(),
      parent = await f.invoke((api) => api.start({ category: "qa", prompt: "block" }), root)
    const row = await f.invoke((api) => Promise.resolve(api.get(parent.task_id)), root),
      child = {
        caller: {
          ...root.caller,
          sessionID: row.child_session_id,
          id: "old-child-action",
          messageID: "old-child-message",
        } as ToolContext,
        controller: root.controller,
      }
    let oldFacade: Facade | undefined
    const oldGrand = await f.invoke(async (api) => {
      oldFacade = api
      return api.start({ category: "qa", prompt: "block", run_in_background: true })
    }, child)
    const next = await f.reopen()
    await f.invoke((api) => api.recover(oldGrand.task_id), root)
    await expect(f.invoke((api) => api.wait(parent.task_id), root)).rejects.toThrow("uncertain")
    const controller = new AbortController(),
      fresh = {
        caller: {
          ...child.caller,
          id: "fresh-child-action",
          messageID: "fresh-child-message",
          signal: controller.signal,
        } as ToolContext,
        controller,
      }
    const lease = await next.parent(fresh.caller)
    await expect(next.forCall(fresh.caller)).rejects.toThrow("authorized")
    expect(f.calls.filter((x) => x === "create")).toHaveLength(2)
    let retained: Facade | undefined
    const newGrand = await f.invoke(async (api) => {
      retained = api
      return api.start({ category: "qa", prompt: "fresh-descendant", run_in_background: true })
    }, fresh)
    expect(newGrand.kind).toBe("started")
    const completed = await f.invoke((api) => api.wait(newGrand.task_id), root)
    expect(completed.final_response).toBe("result:fresh-descendant")
    expect(completed.depth).toBe(2)
    const subsequent = {
      caller: { ...fresh.caller, id: "subsequent-child-action", messageID: "subsequent-child-message" } as ToolContext,
      controller,
    }
    expect(await next.parent(subsequent.caller)).toBe(lease)
    const refusal = await f.invoke(async () => {
      try {
        await defined(retained).start({ category: "qa", prompt: "forbidden-retained" })
        return "unexpected"
      } catch (error) {
        return String(error)
      }
    }, subsequent)
    expect(refusal).toContain("authorized")
    await expect(
      Promise.resolve().then(() => defined(oldFacade).start({ category: "qa", prompt: "forbidden-old-owner" })),
    ).rejects.toThrow()
    await expect(f.invoke((api) => api.wait(parent.task_id), root)).rejects.toThrow("uncertain")
    expect(f.calls.filter((x) => x === "create")).toHaveLength(3)
    expect(f.calls.filter((x) => x === "prompt")).toHaveLength(3)
    const oldParent = await f.invoke((api) => Promise.resolve(api.get(parent.task_id)), root)
    const again = await f.reopen()
    await f.invoke((api) => api.recover(oldGrand.task_id), root)
    const twice = await f.invoke((api) => Promise.resolve(api.get(parent.task_id)), root)
    expect(twice.child_session_id).toBe(row.child_session_id)
    expect(twice.notification.run_epoch).toBeGreaterThan(oldParent.notification.run_epoch)
    expect(twice.owned_session.runEpoch).toBe(twice.notification.run_epoch)
    await expect(f.invoke((api) => api.wait(parent.task_id), root)).rejects.toThrow("uncertain")
    expect(f.calls.filter((x) => x === "create")).toHaveLength(3)
    expect(f.calls.filter((x) => x === "prompt")).toHaveLength(3)
    await again.close()
  })
})

test("repeated canonical reattach advances bookkeeping without reprojecting an old partial assistant frame", async () => {
  await fixture(async (f) => {
    const root = f.raw(),
      start = await f.invoke((api) => api.start({ category: "qa", prompt: "block" }), root)
    const row = await f.invoke((api) => Promise.resolve(api.get(start.task_id)), root)
    const path = join(f.dir, "parent", "owned-children.sqlite")
    function saved() {
      const db = new Database(path, { readonly: true })
      try {
        return JSON.parse(
          (db.query("SELECT body FROM children WHERE key=?").get(row.owned_session.journalKey) as { body: string })
            .body,
        )
      } finally {
        db.close()
      }
    }
    const original = saved(),
      assistant = `assistant:${original.inboxID}`
    f.emit("session.text.started", row.child_session_id, { assistantMessageID: assistant, ordinal: 0 })
    f.emit("session.text.ended", row.child_session_id, {
      assistantMessageID: assistant,
      ordinal: 0,
      text: "original partial frame",
    })
    f.emit("session.step.ended", row.child_session_id, { assistantMessageID: assistant, finish: "stop" })
    await Bun.sleep(30)
    const frames = () =>
      readFileSync(join(f.dir, "parent", "logs", `${start.task_id}.jsonl`), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((event) => event.type === "assistant_message")
    expect(frames()).toHaveLength(1)
    for (let at = 1; at <= 2; at++) {
      await f.reopen()
      await f.invoke((api) => api.recover(start.task_id), root)
      const fresh = await f.invoke((api) => Promise.resolve(api.get(start.task_id)), root),
        journal = saved()
      expect(fresh.notification.run_epoch).toBe(at)
      expect(journal.turn.nativeEpoch).toBe(at)
      expect(journal.turn.observationKey).toBe(row.owned_session.journalKey)
      expect(journal.inboxID).toBe(original.inboxID)
      await expect(f.invoke((api) => api.wait(start.task_id), root)).rejects.toThrow("uncertain")
      expect(frames()).toHaveLength(1)
    }
    expect(f.calls.filter((x) => x === "create")).toHaveLength(1)
    expect(f.calls.filter((x) => x === "prompt")).toHaveLength(1)
    await f.invoke((api) => api.end(start.task_id), root)
  })
})

test.each([false, true])(
  "an original accepted queued descendant survives same-owner backend progress (progress=%s)",
  async (progress) => {
    await fixture(async (f) => {
      f.setConcurrency(1)
      const root = f.raw(),
        parent = await f.invoke(
          (api) => api.start({ category: "qa", prompt: "block original parent", run_in_background: true }),
          root,
        )
      const before = await f.invoke((api) => Promise.resolve(api.get(parent.task_id)), root)
      const child = {
        caller: {
          ...root.caller,
          sessionID: before.child_session_id,
          id: "queued-child-call",
          messageID: "queued-child-message",
        } as ToolContext,
        controller: root.controller,
      }
      const lease = await f.service.parent(child.caller)
      const queued = await f.invoke(
        (api) => api.start({ category: "qa", prompt: "accepted descendant", run_in_background: true }),
        child,
      )
      expect(queued.status).toBe("pending")
      expect(f.calls.filter((x) => x === "create")).toHaveLength(1)
      if (progress)
        await f.invoke((api) => api.send({ idOrName: parent.task_id, message: "block own revision progress" }), root)
      const after = await f.invoke((api) => Promise.resolve(api.get(parent.task_id)), root)
      expect(after.notification.run_epoch).toBe(before.notification.run_epoch)
      expect(after.residency_claim).toBe(before.residency_claim)
      expect(after.child_session_id).toBe(before.child_session_id)
      expect(after.owned_session.journalOwner).toBe(before.owned_session.journalOwner)
      expect(after.owned_session.journalRevision).toBe(
        progress ? before.owned_session.journalRevision + 2 : before.owned_session.journalRevision,
      )
      expect(() => f.scopes.assert(lease)).not.toThrow()
      const result = await f.invoke(
        (api) =>
          api.operation(async (manager) => {
            manager.getResidentHandle(parent.task_id)?.assertOwned?.()
            const parked = manager.concurrency?.park(parent.task_id, after.notification.run_epoch)
            try {
              return await manager.waitFor(queued.task_id)
            } finally {
              await manager.concurrency?.unpark(parked, undefined, { overflow: true })
            }
          }),
        root,
      )
      console.log(
        "ORIGINAL_QUEUED_PARENT_REVISION",
        JSON.stringify({
          progress,
          beforeRevision: before.owned_session.journalRevision,
          afterRevision: after.owned_session.journalRevision,
          status: result.status,
          creates: f.calls.filter((x) => x === "create").length,
        }),
      )
      expect(result.status).toBe("completed")
      expect(result.final_response).toBe("result:accepted descendant")
      expect(f.calls.filter((x) => x === "create")).toHaveLength(2)
      await f.invoke((api) => api.end(parent.task_id), root)
    })
  },
)

test("a raw file-only parent revision increment cannot release an original queued descendant", async () => {
  await fixture(async (f) => {
    f.setConcurrency(1)
    const root = f.raw(),
      parent = await f.invoke(
        (api) => api.start({ category: "qa", prompt: "block parent", run_in_background: true }),
        root,
      )
    const before = await f.invoke((api) => Promise.resolve(api.get(parent.task_id)), root)
    const child = {
      caller: { ...root.caller, sessionID: before.child_session_id } as ToolContext,
      controller: root.controller,
    }
    const queued = await f.invoke(
      (api) => api.start({ category: "qa", prompt: "must not start", run_in_background: true }),
      child,
    )
    expect(queued.status).toBe("pending")
    const file = join(f.dir, "parent", "tasks", `${parent.task_id}.json`),
      original = readFileSync(file, "utf8"),
      record = JSON.parse(original)
    record.owned_session.journalRevision += 2
    writeFileSync(file, JSON.stringify(record, null, 2))
    let parked:
      ReturnType<NonNullable<Parameters<Parameters<Facade["operation"]>[0]>[0]["concurrency"]>["park"]> | undefined
    try {
      const result = await f.invoke(
        (api) =>
          api.operation(async (manager) => {
            expect(() => manager.getResidentHandle(parent.task_id)?.assertOwned?.()).toThrow()
            parked = manager.concurrency?.park(parent.task_id, before.notification.run_epoch)
            return manager.waitFor(queued.task_id)
          }),
        root,
      )
      expect(result.status).toBe("error")
      expect(f.calls.filter((x) => x === "create")).toHaveLength(1)
    } finally {
      writeFileSync(file, original)
      await f.invoke(
        (api) => api.operation(async (manager) => manager.concurrency?.unpark(parked, undefined, { overflow: true })),
        root,
      )
    }
    await f.invoke((api) => api.end(parent.task_id), root)
  })
})

test("canonical reattach checkpoint failure never returns success or replays input and keeps real cleanup", async () => {
  await fixture(async (f) => {
    const root = f.raw(),
      start = await f.invoke((api) => api.start({ category: "qa", prompt: "block" }), root)
    await f.reopen()
    const db = new Database(join(f.dir, "parent", "owned-children.sqlite"))
    db.exec(
      "CREATE TRIGGER refuse_new_bookkeeping BEFORE UPDATE ON children WHEN json_extract(NEW.body,'$.turn.nativeEpoch') > 0 BEGIN SELECT RAISE(FAIL,'controlled epoch checkpoint failure'); END",
    )
    try {
      await expect(f.invoke((api) => api.recover(start.task_id), root)).rejects.toThrow()
    } finally {
      db.exec("DROP TRIGGER refuse_new_bookkeeping")
      db.close()
    }
    const fresh = await f.invoke((api) => Promise.resolve(api.get(start.task_id)), root)
    expect(fresh.notification.run_epoch).toBe(1)
    expect(f.calls.filter((x) => x === "create")).toHaveLength(1)
    expect(f.calls.filter((x) => x === "prompt")).toHaveLength(1)
    await f.invoke((api) => api.end(start.task_id), root)
    expect(f.calls.filter((x) => x === "remove")).toHaveLength(1)
  })
})

test("operation issues a private fourth owner while preserving its original three arguments", async () => {
  await fixture(async (f) => {
    await f.invoke((api) =>
      api.operation(async (...args) => {
        expect(args[0]).toBeDefined()
        expect(typeof args[1]).toBe("function")
        expect(args[2]).toBeInstanceOf(AbortSignal)
        const owner = (args as unknown[])[3]
        expect(owner).toBeDefined()
        return null
      }),
    )
  })
})

/** Actual service/kernel/guard/permission implementations over explicitly controlled UNIT domains. */
export async function withNativeTargetPermissionService(
  run: (value: {
    service: Service
    registry: ReturnType<typeof createToolRegistry>
    kernel: ReturnType<typeof createToolKernel>
    f: Awaited<ReturnType<typeof host>>
    requests: PermissionRequest[]
    targets: NativeTaskTargets
    options: Parameters<typeof createNativeTaskService>[1]
    setFence(callback: () => void): void
    retire(): void
  }) => Promise<void>,
  config: {
    denySubagent?: boolean
    childGuardBinding?: Parameters<typeof createNativeTaskService>[1]["childGuardBinding"]
    policyTools?: readonly string[]
  } = {},
) {
  await fixture(async (f) => {
    const scope = Scope.makeUnsafe(),
      requests: PermissionRequest[] = []
    const permission = await Effect.runPromise(
      Effect.provideService(
        acquireEffectPermissionApi({
          assert: (input) =>
            Effect.suspend(() => {
              requests.push(input)
              return config.denySubagent && input.action === "subagent"
                ? Effect.fail(new Error("Unit denied subagent"))
                : Effect.void
            }),
        }),
        Scope.Scope,
        scope,
      ),
    )
    const guard = await Effect.runPromise(
      Effect.provideService(
        acquireOwnedChildToolGuard({
          tool: { transform: () => Effect.succeed({ dispose: Effect.void }) },
          permission: { hook: () => Effect.succeed({ dispose: Effect.void }) },
        }),
        Scope.Scope,
        scope,
      ),
    )
    let current = true,
      fence: (() => void) | undefined
    const registry = createToolRegistry([], {}),
      kernel = createToolKernel({ registry, scopes: f.scopes, pipeline: createPolicyPipeline(), permission })
    const grantPort: NonNullable<Parameters<typeof createNativeTaskService>[1]["hostGrant"]> = {
      permission,
      assertCurrent() {
        if (this !== grantPort) throw Error("Original grant receiver lost")
        fence?.()
        if (!current) throw Error("Unit owner retired")
      },
      async preparationFor() {
        return {
          nativeTools: [{ name: "read" }],
          catalog: [{ id: "read", name: "read", options: { codemode: false } }],
        }
      },
    }
    const options: Parameters<typeof createNativeTaskService>[1] = {
      ...f.options,
      callAuthority: kernel.callAuthority,
      policy: { tools: config.policyTools ?? ["task", "task_output", "read"], authorize() {} },
      hostGrant: grantPort,
      childToolGuard: guard,
      childGuardBinding:
        config.childGuardBinding ??
        function (_spec, prepared) {
          return {
            assertCurrent() {
              if (!current) throw Error("Unit producer retired")
            },
            bind(child, assertBackendCurrent) {
              return { child, agent: prepared.buildAgentID, assertCurrent: assertBackendCurrent }
            },
          }
        },
    }
    const service = createNativeTaskService(f.ctx, options)
    // Obtain original canonical target objects from a deliberately unpublished UNIT bridge.
    const targetsReady = Promise.withResolvers<NativeTaskTargets>(),
      releaseTargets = Promise.withResolvers<void>(),
      finished = Error("Unit target inspection complete")
    const inspection = createNativeTaskBridge({
      tool: {} as never,
      prepared: {
        config: await f.options.config(),
        agents: {},
        authorizeSkills: async () => () => ({ prepend: "", resolved: [], missing: [] }),
      } as unknown as PreparedNativeTaskRuntime,
      async acquire(targets) {
        targetsReady.resolve(targets)
        await releaseTargets.promise
        throw finished
      },
      async rollbackAcquisition() {},
    })
    try {
      await run({
        service,
        registry,
        kernel,
        f,
        requests,
        targets: await targetsReady.promise,
        options,
        setFence(callback) {
          fence = callback
        },
        retire() {
          current = false
        },
      })
    } finally {
      releaseTargets.resolve()
      await inspection.ready.catch((error) => {
        if (error !== finished) throw error
      })
      await inspection.close()
      await service.close()
      await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    }
  })
}

// Causal UNIT regression: no pretarget canary/read adapter; the real service owns authorization.
test("canonical bridge registers real service targets without invented pretarget permission actions", async () => {
  await withNativeTargetPermissionService(
    async ({ service, registry, kernel, f, requests }) => {
      const publicTools: UnitPublicTool[] = []
      const tool = {
        async hook() {
          return { async dispose() {} }
        },
        async transform(change: (editor: ToolEditor) => void) {
          change({
            list: () => publicTools,
            get: (id: string) => publicTools.find((t) => t.id === id),
            namespace() {},
            add(value) {
              publicTools.push({ ...value, id: `public-${value.name}` })
            },
            update(id, edit) {
              edit(defined(publicTools.find((t) => t.id === id)))
            },
            remove() {},
          })
          return { async dispose() {} }
        },
        async list() {
          return publicTools
        },
        async reload() {},
      }
      const prepared = {
        config: await f.options.config(),
        agents: {},
        authorizeSkills: async () => () => ({ prepend: "", resolved: [], missing: [] }),
      } as unknown as PreparedNativeTaskRuntime
      const bridge = createNativeTaskBridge({
        tool,
        prepared,
        async rollbackAcquisition() {
          await service.close()
        },
        async acquire(targets) {
          const targetPermissions = targets.tools.map((tool) => ({ tool, permission: service.targetPermission(tool) }))
          registry.replace(targets.tools, targets.codecs, targets.normalizers, targetPermissions)
          return {
            registry,
            kernel,
            service,
            targetPermissions,
            context(caller) {
              return { cwd: f.dir, sessionManager: { getSessionId: () => caller.sessionID } }
            },
            taskDependencies: () => ({}),
            outputDependencies: () => ({ stateDir: f.dir }),
            async release() {},
          }
        },
      })
      try {
        await bridge.ready
        expect(publicTools.map((t) => t.name)).toEqual(["task", "task_output", "task_send", "task_cancel"])
        const caller = f.raw("ses_public_owned").caller
        const output = await publicTool(publicTools, "task_output").execute({ task_id: "missing" }, caller)
        expect(nativeDetails(output).kind).toBe("not_found")
        expect(requests).toHaveLength(0)
        // The genuine G2 request is observed and denied, so no guarded child is staged by this fake-session unit host.
        await expect(
          publicTool(publicTools, "task").execute(
            { category: "qa", prompt: "owned public", run_in_background: true },
            caller,
          ),
        ).rejects.toThrow()
        expect(requests).toHaveLength(1)
        expect(requests[0]).toMatchObject({ action: "subagent", resources: ["build"], sessionID: caller.sessionID })
      } finally {
        await bridge.close()
      }
    },
    { denySubagent: true },
  )
})

// Public-path G3 regression: createNativeTaskService must forward its configured childToolGuard/childGuardBinding into the owned runtime.
test("allowed public task start binds the configured G3 producer for the admitted spec before any child is staged", async () => {
  const bound: { taskId: string; buildAgentID: string }[] = [],
    refused = Error("Unit G3 producer refused staging")
  await withNativeTargetPermissionService(
    async ({ service, registry, kernel, f, requests }) => {
      const publicTools: UnitPublicTool[] = []
      const tool = {
        async hook() {
          return { async dispose() {} }
        },
        async transform(change: (editor: ToolEditor) => void) {
          change({
            list: () => publicTools,
            get: (id: string) => publicTools.find((t) => t.id === id),
            namespace() {},
            add(value) {
              publicTools.push({ ...value, id: `public-${value.name}` })
            },
            update(id, edit) {
              edit(defined(publicTools.find((t) => t.id === id)))
            },
            remove() {},
          })
          return { async dispose() {} }
        },
        async list() {
          return publicTools
        },
        async reload() {},
      }
      const prepared = {
        config: await f.options.config(),
        agents: {},
        authorizeSkills: async () => () => ({ prepend: "", resolved: [], missing: [] }),
      } as unknown as PreparedNativeTaskRuntime
      const bridge = createNativeTaskBridge({
        tool,
        prepared,
        async rollbackAcquisition() {
          await service.close()
        },
        async acquire(targets) {
          const targetPermissions = targets.tools.map((tool) => ({ tool, permission: service.targetPermission(tool) }))
          registry.replace(targets.tools, targets.codecs, targets.normalizers, targetPermissions)
          return {
            registry,
            kernel,
            service,
            targetPermissions,
            context(caller) {
              return { cwd: f.dir, sessionManager: { getSessionId: () => caller.sessionID } }
            },
            taskDependencies: () => ({}),
            outputDependencies: () => ({ stateDir: f.dir }),
            async release() {},
          }
        },
      })
      try {
        await bridge.ready
        const caller = f.raw("ses_public_guarded").caller
        // when
        const details = nativeDetails(
          await publicTool(publicTools, "task").execute(
            { category: "qa", prompt: "guarded public", run_in_background: true },
            caller,
          ),
        )
        // then
        expect(details.status).toBe("error")
        expect(requests).toHaveLength(1)
        expect(requests[0]).toMatchObject({ action: "subagent", resources: ["build"], sessionID: caller.sessionID })
        expect(bound).toEqual([{ taskId: details.task_id, buildAgentID: "build" }])
        expect(f.calls).not.toContain("create")
      } finally {
        await bridge.close()
      }
    },
    {
      childGuardBinding(spec, prepared) {
        bound.push({ taskId: spec.taskId, buildAgentID: prepared.buildAgentID })
        throw refused
      },
    },
  )
})

test("low-level actual service without G2 and G3 cannot issue target-phase permission", async () => {
  await fixture(async (f) => {
    const target = Object.freeze({
      id: "omo.native.task",
      name: "task",
      description: "unit",
      input: z.object({}),
      execute: async () => ({}),
    })
    expect(() => f.service.targetPermission(target)).toThrow("G2 authorizer and G3")
  })
})

test("actual service permission seals original target and owner; close and producer retirement revoke admissions", async () => {
  await withNativeTargetPermissionService(async ({ service, f, retire, targets }) => {
    const target = defined(targets.tools[0])
    expect(() => service.targetPermission(Object.freeze({ ...target, execute: async () => ({}) }))).toThrow(
      "Noncanonical",
    )
    const permission = service.targetPermission(target),
      stop = new AbortController()
    const bound = bindNativeTaskTargetPermission(permission, target, { signal: stop.signal, assertCurrent() {} })
    bound.assertOwner(service)
    expect(() => bound.assertOwner(f.service)).toThrow("Foreign")
    expect(() => bound.assertOwner({ ...service })).toThrow("Foreign")
    expect(() =>
      bindNativeTaskTargetPermission({ ...permission }, target, { signal: stop.signal, assertCurrent() {} }),
    ).toThrow("Unissued")
    expect(() =>
      bindNativeTaskTargetPermission(permission, Object.freeze({ ...target }), {
        signal: stop.signal,
        assertCurrent() {},
      }),
    ).toThrow("mismatched")
    expect(() => service.targetPermission(target)).toThrow("Duplicate")
    expect(() => service.targetPermission({ ...target })).toThrow("Noncanonical")
    retire()
    expect(() => bound.assertCurrent()).toThrow("retired")
  })
  await withNativeTargetPermissionService(async ({ service, targets }) => {
    const target = defined(targets.tools[1])
    const bound = bindNativeTaskTargetPermission(service.targetPermission(target), target, {
      signal: new AbortController().signal,
      assertCurrent() {},
    })
    await service.close()
    expect(() => bound.assertCurrent()).toThrow("closing")
    expect(() => service.targetPermission(target)).toThrow("closing")
  })
})

test("real service issuance requires BOTH configured G3 ports even with genuine G2 permission owner", async () => {
  await withNativeTargetPermissionService(async ({ f, options, targets }) => {
    for (const missing of ["childToolGuard", "childGuardBinding"] as const) {
      const incomplete = createNativeTaskService(f.ctx, { ...options, [missing]: undefined })
      try {
        expect(() => incomplete.targetPermission(defined(targets.tools[0]))).toThrow("G2 authorizer and G3 binding")
      } finally {
        await incomplete.close()
      }
    }
    const noGrant = createNativeTaskService(f.ctx, { ...options, hostGrant: undefined })
    try {
      expect(() => noGrant.targetPermission(defined(targets.tools[0]))).toThrow("G2 authorizer and G3 binding")
    } finally {
      await noGrant.close()
    }
  })
})
