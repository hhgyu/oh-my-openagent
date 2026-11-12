import { Skill } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { Effect, Schema, Scope } from "effect"
import { describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import { acquireEffectPermissionApi } from "../host/effect-permission-api"
import {
  prepareNativeTaskRuntime,
  requestedTaskSkillNames,
  type NativeSkillCaller,
  type NativeTaskPreparationOptions,
  type PreparedNativeTaskRuntime,
} from "./native-task-preparation"

type SkillAssert = {
  readonly sessionID: string
  readonly agent?: string
  readonly action: string
  readonly resources: readonly string[]
  readonly source?: unknown
}
const caller: NativeSkillCaller = {
  sessionID: "ses_prep_parent",
  agent: "prep-agent",
  messageID: "prep-message",
  id: "prep-call",
}
/** The GENUINE joined owner over a UNIT SDK permission domain (acquisition is synchronous). */
function joinedPermission(
  requests: SkillAssert[],
  decide: (request: SkillAssert) => Effect.Effect<void, unknown> = () => Effect.void,
) {
  return Effect.runSync(
    Effect.provideService(
      acquireEffectPermissionApi({
        assert: (request) => {
          requests.push(request)
          return decide(request) as Effect.Effect<void, ToolError>
        },
      }),
      Scope.Scope,
      Scope.makeUnsafe(),
    ),
  )
}
/** Authorize then load through the per-call loader, as the bridge does. */
async function load(prepared: PreparedNativeTaskRuntime, names: readonly string[], cwd: string) {
  return (await prepared.authorizeSkills(caller, names, new AbortController().signal))(names, cwd)
}

type ModelResult = Awaited<ReturnType<NativeTaskPreparationOptions["models"]["model"]["list"]>>
type ProviderResult = Awaited<ReturnType<NativeTaskPreparationOptions["models"]["provider"]["list"]>>
type SkillsResult = Awaited<ReturnType<NativeTaskPreparationOptions["skills"]["list"]>>
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const microtasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
function fixture() {
  const home = resolve("virtual-preparation-home"),
    cwd = join(home, "project"),
    user = join(home, ".omo", "omo.jsonc")
  const files: Record<string, unknown> = {
    [user]: {
      models: { selected: { model: "unit-provider/unit-model" } },
      categories: { current: { model: "selected" } },
      disabled_skills: ["disabled"],
      memory: { enabled: false },
      "[opencode]": { agents: { explore: { displayName: "Host display only" } } },
    },
  }
  const reads: string[] = [],
    receiverRows: unknown[] = [],
    argumentRows: unknown[][] = [],
    resolverInputs: unknown[] = [],
    formatterInputs: unknown[] = []
  const models: ModelResult = {
    location: { directory: cwd },
    data: [
      {
        id: "unit-model",
        modelID: "unit-underlying",
        providerID: "unit-provider",
        name: "Unit model",
        enabled: true,
        status: "active",
        type: "chat",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: [],
        limit: { context: 4096, output: 256 },
        time: { released: 0 },
        cost: [],
      },
    ],
  }
  const providers: ProviderResult = {
    location: { directory: cwd },
    data: [{ id: "unit-provider", name: "Unit provider", package: "unit-port", activation: "enabled" }],
  }
  const skills: SkillsResult = {
    location: { directory: cwd },
    data: [
      { id: "alpha-id", name: "alpha", path: join(home, "skills", "alpha", "SKILL.md"), content: "ALPHA CONTENT" },
      {
        id: "beta-id",
        name: "beta",
        path: join(cwd, ".agents", "skills", "beta", "SKILL.md"),
        content: "BETA CONTENT",
      },
      {
        id: "disabled-id",
        name: "disabled",
        path: join(home, "skills", "disabled", "SKILL.md"),
        content: "DISABLED CONTENT",
      },
    ],
  }
  const modelPort: NativeTaskPreparationOptions["models"]["model"] = {
    async list(this: unknown, ...args) {
      receiverRows.push(this)
      argumentRows.push(args)
      return models
    },
  }
  const providerPort: NativeTaskPreparationOptions["models"]["provider"] = {
    async list(this: unknown, ...args) {
      receiverRows.push(this)
      argumentRows.push(args)
      return providers
    },
  }
  const skillPort: NativeTaskPreparationOptions["skills"] = {
    async list(this: unknown, ...args) {
      receiverRows.push(this)
      argumentRows.push(args)
      return skills
    },
  }
  const nativeAgents = {
    selectedByNative: {
      name: "selectedByNative",
      prompt: "Native port result",
      tools: [{ pattern: "read", allow: true }],
    },
  }
  const canonical: NativeTaskPreparationOptions["canonical"] = {
    resolveTaskAgents(config) {
      resolverInputs.push(config)
      return nativeAgents
    },
    buildSkillPrepend(selected, prompt) {
      formatterInputs.push({ selected, prompt, receiver: this })
      return `CANONICAL_PORT:${selected.map((skill) => skill.name).join(",")}:${prompt}`
    },
  }
  const controller = new AbortController()
  let current = true
  const stale = Error("component generation retired")
  const permissionRequests: SkillAssert[] = []
  let decide: (request: SkillAssert) => Effect.Effect<void, unknown> = () => Effect.void
  const permission = joinedPermission(permissionRequests, (request) => decide(request))
  const options: NativeTaskPreparationOptions = {
    cwd,
    models: { model: modelPort, provider: providerPort },
    skills: skillPort,
    canonical,
    signal: controller.signal,
    assertCurrent() {
      if (!current) throw stale
    },
    permission,
    configOptions: {
      env: { HOME: home },
      platform: "linux",
      fileSystem: {
        existsSync: (path) => Object.hasOwn(files, path),
        readFileSync: (path) => {
          reads.push(path)
          if (!Object.hasOwn(files, path)) throw Error("Virtual config only")
          return JSON.stringify(files[path])
        },
      },
    },
  }
  return {
    options,
    home,
    cwd,
    files,
    reads,
    models,
    providers,
    skills,
    modelPort,
    providerPort,
    skillPort,
    canonical,
    nativeAgents,
    receiverRows,
    argumentRows,
    resolverInputs,
    formatterInputs,
    controller,
    stale,
    retire() {
      current = false
    },
    permissionRequests,
    setDecision(value: typeof decide) {
      decide = value
    },
  }
}

test("prepares canonical config/agents, real catalog metadata and named SDK content before synchronous loading", async () => {
  const f = fixture(),
    prepared = await prepareNativeTaskRuntime(f.options)
  expect(f.reads).toEqual([join(f.home, ".omo", "omo.jsonc")])
  expect(prepared.config.categories?.current.model).toBe("unit-provider/unit-model")
  expect(prepared.runtimeConfig.agents.agents.explore.displayName).toBe("Host display only")
  expect(f.resolverInputs).toEqual([prepared.config])
  expect(prepared.agents).toEqual(f.nativeAgents)
  expect(f.receiverRows).toEqual([f.modelPort, f.providerPort, f.skillPort])
  expect(f.argumentRows).toEqual([[], [], [{ location: { directory: f.cwd } }]])
  expect(prepared.models[0].availability).toMatchObject({
    providerListed: true,
    enabled: true,
    authentication: "unknown",
  })
  const loaded = await load(prepared, ["beta", "missing", "alpha", "beta", "disabled", "missing"], f.cwd)
  expect(loaded.resolved).toEqual(["beta", "alpha", "beta"])
  expect(loaded.missing).toEqual(["missing", "missing"])
  expect(loaded.rejected).toEqual([{ name: "disabled", reason: "Skill is disabled by configuration" }])
  expect(loaded.skills).toEqual(
    [f.skills.data[1], f.skills.data[0], f.skills.data[1]].map((skill) => ({
      name: skill.name,
      content: skill.content,
      location: skill.path,
    })),
  )
  expect(f.formatterInputs).toEqual([{ selected: loaded.skills, prompt: "", receiver: f.canonical }])
  expect(loaded.prepend).toBe("CANONICAL_PORT:beta,alpha,beta:")
  f.skills.data[0].content = "CHANGED AFTER SNAPSHOT"
  f.nativeAgents.selectedByNative.prompt = "CHANGED AFTER SNAPSHOT"
  f.models.data[0].enabled = false
  // Skill content is call-time host data; the agent and model snapshots stay registration-time.
  expect((await load(prepared, ["alpha"], f.cwd)).skills?.[0].content).toBe("CHANGED AFTER SNAPSHOT")
  expect(prepared.agents.selectedByNative.prompt).toBe("Native port result")
  expect(prepared.models[0].availability.enabled).toBe(true)
  expect(Object.isFrozen(prepared.config)).toBe(true)
  expect(Object.isFrozen(f.nativeAgents.selectedByNative)).toBe(false)
})

test("missing and disabled names remain nonfatal Native SkillResolution data; empty list still forwards formatter", async () => {
  const f = fixture(),
    prepared = await prepareNativeTaskRuntime(f.options)
  expect(await load(prepared, ["absent", "disabled"], f.cwd)).toMatchObject({
    resolved: [],
    missing: ["absent"],
    rejected: [{ name: "disabled", reason: "Skill is disabled by configuration" }],
  })
  expect(await load(prepared, [], f.cwd)).toMatchObject({ resolved: [], missing: [], skills: [], rejected: [] })
  expect(f.formatterInputs).toHaveLength(2)
  await expect(load(prepared, ["alpha"], join(f.cwd, "other"))).rejects.toThrow("location")
})

test("foreign response location, ambiguous names and malformed actual paths refuse the whole snapshot", async () => {
  for (const kind of ["location", "duplicate", "path"] as const) {
    const f = fixture()
    if (kind === "location") f.skills.location.directory = join(f.cwd, "other")
    if (kind === "duplicate") f.skills.data.push({ ...f.skills.data[0], id: "another" })
    if (kind === "path") f.skills.data[0].path = "relative/SKILL.md"
    await expect(prepareNativeTaskRuntime(f.options)).rejects.toThrow(
      kind === "location" ? "Foreign" : kind === "duplicate" ? "Ambiguous" : "Invalid",
    )
    expect(f.resolverInputs).toHaveLength(0)
    expect(f.formatterInputs).toHaveLength(0)
  }
})

test("catalog failure joins its ORIGINAL provider sibling and skill request before preserving the error", async () => {
  const f = fixture(),
    provider = deferred<ProviderResult>(),
    skills = deferred<SkillsResult>(),
    failure = Error("original model failure")
  f.options.models.model.list = () => Promise.reject(failure)
  f.options.models.provider.list = () => provider.promise
  f.options.skills.list = () => skills.promise
  let settled = false
  const work = prepareNativeTaskRuntime(f.options)
  void work.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await microtasks()
  expect(settled).toBe(false)
  skills.resolve(f.skills)
  await microtasks()
  expect(settled).toBe(false)
  provider.resolve(f.providers)
  await expect(work).rejects.toBe(failure)
  expect(f.resolverInputs).toHaveLength(0)
})

test("skill failure joins original model/provider requests and preserves actual rejection identity", async () => {
  const f = fixture(),
    models = deferred<ModelResult>(),
    providers = deferred<ProviderResult>(),
    failure = Error("original skill failure")
  f.options.models.model.list = () => models.promise
  f.options.models.provider.list = () => providers.promise
  f.options.skills.list = () => Promise.reject(failure)
  let settled = false
  const work = prepareNativeTaskRuntime(f.options)
  void work.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await microtasks()
  expect(settled).toBe(false)
  models.resolve(f.models)
  await microtasks()
  expect(settled).toBe(false)
  providers.resolve(f.providers)
  await expect(work).rejects.toBe(failure)
  expect(f.resolverInputs).toHaveLength(0)
})

test("cancellation drains ALL original work and never publishes a canceled snapshot", async () => {
  const f = fixture(),
    models = deferred<ModelResult>(),
    providers = deferred<ProviderResult>(),
    skills = deferred<SkillsResult>()
  f.options.models.model.list = () => models.promise
  f.options.models.provider.list = () => providers.promise
  f.options.skills.list = () => skills.promise
  let settled = false
  const work = prepareNativeTaskRuntime(f.options)
  void work.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  const reason = Error("owner canceled")
  f.controller.abort(reason)
  models.resolve(f.models)
  providers.resolve(f.providers)
  await microtasks()
  expect(settled).toBe(false)
  expect(f.resolverInputs).toHaveLength(0)
  skills.resolve(f.skills)
  await expect(work).rejects.toBe(reason)
  expect(f.resolverInputs).toHaveLength(0)
})

test("stale generation waits for original requests and refuses prepared loader after retirement", async () => {
  const f = fixture(),
    skills = deferred<SkillsResult>()
  f.options.skills.list = () => skills.promise
  const work = prepareNativeTaskRuntime(f.options)
  f.retire()
  skills.resolve(f.skills)
  await expect(work).rejects.toBe(f.stale)
  expect(f.resolverInputs).toHaveLength(0)
  const fresh = fixture(),
    prepared = await prepareNativeTaskRuntime(fresh.options)
  fresh.retire()
  await expect(prepared.authorizeSkills(caller, ["alpha"], new AbortController().signal)).rejects.toBe(fresh.stale)
  const canceled = fixture(),
    another = await prepareNativeTaskRuntime(canceled.options)
  canceled.controller.abort(Error("closed lifetime"))
  await expect(another.authorizeSkills(caller, ["alpha"], new AbortController().signal)).rejects.toThrow(
    "closed lifetime",
  )
})

test("synchronous host throws still join other original work and do not replace its identity", async () => {
  const f = fixture(),
    providers = deferred<ProviderResult>(),
    failure = Error("synchronous model failure")
  f.options.models.model.list = () => {
    throw failure
  }
  f.options.models.provider.list = () => providers.promise
  let settled = false
  const work = prepareNativeTaskRuntime(f.options)
  void work.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  await microtasks()
  expect(settled).toBe(false)
  providers.resolve(f.providers)
  await expect(work).rejects.toBe(failure)
})

test("canonical helper errors propagate and generation change during formatting does not return resolution", async () => {
  const f = fixture(),
    failure = Error("canonical resolver failure")
  const broken = {
    ...f.options,
    canonical: {
      ...f.canonical,
      resolveTaskAgents() {
        throw failure
      },
    },
  }
  await expect(prepareNativeTaskRuntime(broken)).rejects.toBe(failure)
  const formatting = fixture(),
    prepared = await prepareNativeTaskRuntime({
      ...formatting.options,
      canonical: {
        ...formatting.canonical,
        buildSkillPrepend() {
          formatting.retire()
          return "not publishable"
        },
      },
    })
  await expect(load(prepared, ["alpha"], formatting.cwd)).rejects.toBe(formatting.stale)
})

test("each host response is copied on settlement without mutating SDK data or Native shared definitions", async () => {
  const f = fixture(),
    skillGate = deferred<SkillsResult>()
  f.options.skills.list = () => skillGate.promise
  const work = prepareNativeTaskRuntime(f.options)
  await microtasks()
  f.models.data[0].name = "MUTATED WHILE SKILL PENDING"
  skillGate.resolve(f.skills)
  const prepared = await work
  expect(prepared.models[0].name).toBe("Unit model")
  expect(Object.isFrozen(f.models.data[0])).toBe(false)
  expect(Object.isFrozen(f.skills.data[0])).toBe(false)
})

test("pre-canceled owner starts no config/catalog work, and formatter errors keep their identity", async () => {
  const f = fixture(),
    reason = Error("already canceled")
  f.controller.abort(reason)
  await expect(prepareNativeTaskRuntime(f.options)).rejects.toBe(reason)
  expect(f.reads).toEqual([])
  expect(f.receiverRows).toEqual([])
  const healthy = fixture(),
    failure = Error("canonical formatter failed")
  const prepared = await prepareNativeTaskRuntime({
    ...healthy.options,
    canonical: {
      ...healthy.canonical,
      buildSkillPrepend() {
        throw failure
      },
    },
  })
  await expect(load(prepared, ["alpha"], healthy.cwd)).rejects.toBe(failure)
})

for (const port of ["model", "provider", "skill"] as const) {
  test.each([null, undefined, false, 0, new Error("distinct original request failure")])(
    `${port} rejection racing owner abort retains distinct original failure (%s)`,
    async (failure) => {
      const f = fixture(),
        models = deferred<ModelResult>(),
        providers = deferred<ProviderResult>(),
        skills = deferred<SkillsResult>()
      f.options.models.model.list = () => models.promise
      f.options.models.provider.list = () => providers.promise
      f.options.skills.list = () => skills.promise
      let settled = false
      const work = prepareNativeTaskRuntime(f.options).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason) => ({ status: "rejected" as const, reason }),
      )
      void work.then(() => {
        settled = true
      })
      f.controller.abort(Error("owner cancellation is different"))
      if (port === "model") {
        models.reject(failure)
        skills.resolve(f.skills)
      } else if (port === "provider") {
        providers.reject(failure)
        models.resolve(f.models)
      } else {
        skills.reject(failure)
        models.resolve(f.models)
      }
      await microtasks()
      expect(settled).toBe(false)
      if (port === "provider") skills.resolve(f.skills)
      else providers.resolve(f.providers)
      const result = await work
      expect(result.status).toBe("rejected")
      if (result.status === "rejected") expect(result.reason).toBe(failure)
      expect(f.resolverInputs).toHaveLength(0)
      expect(f.formatterInputs).toHaveLength(0)
    },
  )
}

test("a distinct late ORIGINAL provider failure is not hidden by catalog's earlier exact cancellation", async () => {
  const f = fixture(),
    models = deferred<ModelResult>(),
    providers = deferred<ProviderResult>(),
    skills = deferred<SkillsResult>()
  f.options.models.model.list = () => models.promise
  f.options.models.provider.list = () => providers.promise
  f.options.skills.list = () => skills.promise
  const work = prepareNativeTaskRuntime(f.options).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason) => ({ status: "rejected" as const, reason }),
  )
  const canceled = Error("exact owner cancel"),
    distinct = Error("late provider backend failure")
  f.controller.abort(canceled)
  models.reject(canceled)
  skills.resolve(f.skills)
  await microtasks()
  providers.reject(distinct)
  const result = await work
  expect(result.status).toBe("rejected")
  if (result.status === "rejected") expect(result.reason).toBe(distinct)
  expect(f.resolverInputs).toHaveLength(0)
})

test.each([null, false, 0, new Error("ordinary exact cancellation")])(
  "exact cancellation creates no invented backend failure or aggregate (%s)",
  async (reason) => {
    const f = fixture(),
      models = deferred<ModelResult>(),
      providers = deferred<ProviderResult>(),
      skills = deferred<SkillsResult>()
    f.options.models.model.list = () => models.promise
    f.options.models.provider.list = () => providers.promise
    f.options.skills.list = () => skills.promise
    const work = prepareNativeTaskRuntime(f.options).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    )
    f.controller.abort(reason)
    models.reject(reason)
    providers.reject(reason)
    skills.reject(reason)
    const result = await work
    expect(result.status).toBe("rejected")
    if (result.status === "rejected") expect(result.reason).toBe(reason)
    expect(f.resolverInputs).toHaveLength(0)
  },
)

test("multiple distinct joined failures retain exact values once, without adding owner cancellation", async () => {
  const f = fixture(),
    models = deferred<ModelResult>(),
    providers = deferred<ProviderResult>(),
    skills = deferred<SkillsResult>()
  f.options.models.model.list = () => models.promise
  f.options.models.provider.list = () => providers.promise
  f.options.skills.list = () => skills.promise
  const work = prepareNativeTaskRuntime(f.options).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason) => ({ status: "rejected" as const, reason }),
  )
  const failure = Error("model backend failed"),
    canceled = Error("owner canceled")
  f.controller.abort(canceled)
  models.reject(failure)
  providers.reject(null)
  skills.reject(0)
  const result = await work
  expect(result.status).toBe("rejected")
  if (result.status === "rejected") {
    expect(result.reason).toBeInstanceOf(AggregateError)
    if (result.reason instanceof AggregateError) {
      expect(result.reason.errors).toEqual([failure, null, 0])
      expect(result.reason.errors[0]).toBe(failure)
      expect(result.reason.errors).not.toContain(canceled)
    }
  }
  expect(f.resolverInputs).toHaveLength(0)
})

test("without cancellation the original first catalog failure retains its identity despite other failures", async () => {
  const f = fixture(),
    models = deferred<ModelResult>(),
    providers = deferred<ProviderResult>(),
    skills = deferred<SkillsResult>()
  f.options.models.model.list = () => models.promise
  f.options.models.provider.list = () => providers.promise
  f.options.skills.list = () => skills.promise
  const work = prepareNativeTaskRuntime(f.options).then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason) => ({ status: "rejected" as const, reason }),
  )
  const first = Error("first provider failure")
  providers.reject(first)
  await microtasks()
  models.reject(Error("later model failure"))
  skills.reject(Error("later skill failure"))
  const result = await work
  expect(result.status).toBe("rejected")
  if (result.status === "rejected") expect(result.reason).toBe(first)
})

test.each([null, undefined, false, 0])(
  "non-canceled falsy original rejection remains unchanged (%s)",
  async (failure) => {
    const f = fixture()
    f.options.models.model.list = () => Promise.reject(failure)
    const result = await prepareNativeTaskRuntime(f.options).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason) => ({ status: "rejected" as const, reason }),
    )
    expect(result.status).toBe("rejected")
    if (result.status === "rejected") expect(result.reason).toBe(failure)
  },
)

test("real SDK builtin skill URI catalog preserves all content and opaque locations", async () => {
  const f = fixture()
  const builtin = [
    Schema.decodeUnknownSync(Skill.Info)({
      id: "opencode",
      name: "OpenCode",
      path: "skill://opencode/SKILL.md",
      content: "SDK OPENCODE CONTENT",
    }),
    Schema.decodeUnknownSync(Skill.Info)({
      id: "report",
      name: "Report",
      path: "skill://report/SKILL.md",
      content: "SDK REPORT CONTENT",
    }),
  ]
  f.skills.data.push(...builtin)
  const prepared = await prepareNativeTaskRuntime(f.options)
  const loaded = await load(prepared, ["OpenCode", "alpha", "Report"], f.cwd)
  expect(loaded.resolved).toEqual(["OpenCode", "alpha", "Report"])
  expect(loaded.skills).toEqual(
    [builtin[0], f.skills.data[0], builtin[1]].map((skill) => ({
      name: skill.name,
      content: skill.content,
      location: skill.path,
    })),
  )
  expect(f.formatterInputs).toEqual([{ selected: loaded.skills, prompt: "", receiver: f.canonical }])
  expect(loaded.prepend).toBe("CANONICAL_PORT:OpenCode,alpha,Report:")
  expect((await load(prepared, ["beta"], f.cwd)).skills?.[0].content).toBe("BETA CONTENT")
  expect(f.reads).toEqual([join(f.home, ".omo", "omo.jsonc")])
})

test.each([
  "skill://opaque",
  "skill://opaque/docs/reference.md",
  "skill://opaque/SKILL.md///",
  "skill://opaque/Raw%2Fsegment?query#fragment.md",
])("SDK-compatible locator remains opaque and unchanged: %s", async (path) => {
  const f = fixture(),
    skill = Schema.decodeUnknownSync(Skill.Info)({ id: "opaque", name: "opaque", path, content: "OPAQUE SDK CONTENT" })
  f.skills.data.push(skill)
  const prepared = await prepareNativeTaskRuntime(f.options),
    loaded = await load(prepared, ["opaque", "alpha"], f.cwd)
  expect(loaded.skills?.[0]).toEqual({ name: "opaque", content: "OPAQUE SDK CONTENT", location: path })
  expect(loaded.skills?.[1].location).toBe(f.skills.data[0].path)
  expect(f.formatterInputs).toEqual([{ selected: loaded.skills, prompt: "", receiver: f.canonical }])
})

test.each([
  "relative/SKILL.md",
  "file:///skills/SKILL.md",
  "https://example.invalid/SKILL.md",
  "Skill://opencode/SKILL.md",
  "skill://",
  "skill:///opencode/SKILL.md",
  "skill://./SKILL.md",
  "skill://../SKILL.md",
  "skill://opencode/../SKILL.md",
  "skill://opencode/./SKILL.md",
  "skill://opencode//SKILL.md",
  "skill://opencode/dir\\SKILL.md",
  "skill://opencode/SKILL\0.md",
  "skill://opencode\\other/SKILL.md",
])("malformed or foreign skill locator rejects the whole catalog: %s", async (path) => {
  const f = fixture()
  f.skills.data[0].path = path
  await expect(prepareNativeTaskRuntime(f.options)).rejects.toThrow("Invalid host skill entry")
  expect(f.resolverInputs).toHaveLength(0)
  expect(f.formatterInputs).toHaveLength(0)
})

describe("#given a prepared snapshot and the genuine joined permission owner", () => {
  const signal = () => new AbortController().signal
  test("#when skills are authorized #then each distinct SDK id is asserted once, in request order, with the genuine caller fields", async () => {
    // given
    const f = fixture(),
      prepared = await prepareNativeTaskRuntime(f.options)
    // when
    const loader = await prepared.authorizeSkills(caller, ["beta", "missing", "disabled", "alpha", "beta"], signal())
    // then
    expect(f.permissionRequests).toEqual([
      {
        sessionID: "ses_prep_parent",
        agent: "prep-agent",
        action: "skill",
        resources: ["beta-id"],
        source: { type: "tool", messageID: "prep-message", id: "prep-call" },
      },
      {
        sessionID: "ses_prep_parent",
        agent: "prep-agent",
        action: "skill",
        resources: ["alpha-id"],
        source: { type: "tool", messageID: "prep-message", id: "prep-call" },
      },
    ])
    expect(loader(["beta", "alpha", "missing", "disabled"], f.cwd)).toMatchObject({
      resolved: ["beta", "alpha"],
      missing: ["missing"],
      rejected: [{ name: "disabled" }],
    })
  })

  test("#when the per-call loader is asked for an available skill this call did not authorize #then it refuses", async () => {
    // given
    const f = fixture(),
      prepared = await prepareNativeTaskRuntime(f.options)
    // when
    const loader = await prepared.authorizeSkills(caller, ["alpha"], signal())
    // then
    expect(() => loader(["alpha", "beta"], f.cwd)).toThrow("Skill was not authorized for this call: beta")
    expect(f.formatterInputs).toHaveLength(0)
  })

  test("#when an earlier call authorized a skill #then a later call asserts it again instead of reusing the decision", async () => {
    // given
    const f = fixture(),
      prepared = await prepareNativeTaskRuntime(f.options)
    await prepared.authorizeSkills(caller, ["alpha"], signal())
    const denial = new ToolError({ message: "skill denied on second call" })
    f.setDecision(() => Effect.fail(denial))
    // when
    const second = prepared.authorizeSkills({ ...caller, id: "prep-call-2" }, ["alpha"], signal())
    // then
    await expect(second).rejects.toBe(denial)
    expect(f.permissionRequests.map((request) => request.source)).toEqual([
      { type: "tool", messageID: "prep-message", id: "prep-call" },
      { type: "tool", messageID: "prep-message", id: "prep-call-2" },
    ])
  })

  test("#when the live catalog drops the name while its assert is pending #then the post-assert recheck fails closed", async () => {
    // given
    const f = fixture(),
      prepared = await prepareNativeTaskRuntime(f.options)
    f.setDecision(() =>
      Effect.sync(() => {
        f.skills.data.splice(0, 1)
      }),
    )
    // when
    const work = prepared.authorizeSkills(caller, ["alpha"], signal())
    // then
    await expect(work).rejects.toThrow("Host skill identity changed during authorization: alpha")
    expect(f.permissionRequests).toHaveLength(1)
  })

  test("#when an SDK entry has no usable id #then it is unavailable and never asserted or delivered", async () => {
    // given
    const f = fixture()
    f.skills.data.push({ ...f.skills.data[0], id: "", name: "anonymous" } as SkillsResult["data"][number])
    const prepared = await prepareNativeTaskRuntime(f.options)
    // when
    const loaded = await load(prepared, ["anonymous"], f.cwd)
    // then
    expect(loaded).toMatchObject({ resolved: [], missing: ["anonymous"] })
    expect(f.permissionRequests).toHaveLength(0)
  })

  test("#when two SDK entries share one id #then the whole snapshot is refused", async () => {
    // given
    const f = fixture()
    f.skills.data.push({ ...f.skills.data[0], name: "alias" })
    // when
    const work = prepareNativeTaskRuntime(f.options)
    // then
    await expect(work).rejects.toThrow("Ambiguous host skill id")
  })

  test("#when the permission owner is a structural lookalike #then preparation refuses before any host work", async () => {
    // given
    const f = fixture()
    // when
    const work = prepareNativeTaskRuntime({
      ...f.options,
      permission: { assert: async () => {}, close: async () => {} },
    })
    // then
    await expect(work).rejects.toThrow("genuine joined permission owner")
    expect(f.receiverRows).toEqual([])
  })

  test("#when the operation signal aborts during the assert #then the abort reason rejects and no loader is returned", async () => {
    // given
    const f = fixture(),
      prepared = await prepareNativeTaskRuntime(f.options),
      controller = new AbortController(),
      reason = Error("operation aborted")
    f.setDecision(() => Effect.never)
    // when
    const work = prepared.authorizeSkills(caller, ["alpha"], controller.signal)
    for (let turn = 0; turn < 50 && f.permissionRequests.length === 0; turn++)
      await new Promise((done) => setTimeout(done, 1))
    controller.abort(reason)
    // then
    await expect(work).rejects.toBe(reason)
    expect(f.permissionRequests).toHaveLength(1)
  })

  test("#when task input carries batch items #then requested names follow Native inheritance, each once", () => {
    // given
    const batch = {
      load_skills: ["top"],
      tasks: [{ prompt: "a", load_skills: ["own", "top"] }, { prompt: "b" }, { prompt: "c", load_skills: [] }],
    }
    // when
    const names = requestedTaskSkillNames(batch)
    // then
    expect(names).toEqual(["own", "top"])
    expect(requestedTaskSkillNames({ prompt: "single" })).toEqual([])
    expect(requestedTaskSkillNames({ prompt: "single", load_skills: ["x", "x"] })).toEqual(["x"])
  })
})

describe("#given host skills that change after registration", () => {
  test("#when a directory skill is discovered after preparation #then the call resolves, asserts and delivers it from a fresh listing", async () => {
    // given
    const f = fixture(),
      prepared = await prepareNativeTaskRuntime(f.options)
    f.skills.data.push({
      id: "late-id",
      name: "late",
      path: join(f.cwd, ".opencode", "skills", "late", "SKILL.md"),
      content: "LATE CONTENT",
    } as SkillsResult["data"][number])
    // when
    const loaded = await load(prepared, ["late"], f.cwd)
    // then
    expect(f.permissionRequests.map((request) => request.resources)).toEqual([["late-id"]])
    expect(loaded).toMatchObject({
      resolved: ["late"],
      missing: [],
      skills: [{ name: "late", content: "LATE CONTENT" }],
    })
  })

  test("#when a skill is removed after preparation #then it is reported missing and never asserted", async () => {
    // given
    const f = fixture(),
      prepared = await prepareNativeTaskRuntime(f.options)
    f.skills.data.splice(
      f.skills.data.findIndex((skill) => skill.name === "alpha"),
      1,
    )
    // when
    const loaded = await load(prepared, ["alpha"], f.cwd)
    // then
    expect(f.permissionRequests).toHaveLength(0)
    expect(loaded).toMatchObject({ resolved: [], missing: ["alpha"] })
  })

  test("#when the call-time listing carries a duplicate id #then authorization refuses before any assert", async () => {
    // given
    const f = fixture(),
      prepared = await prepareNativeTaskRuntime(f.options)
    f.skills.data.push({ ...f.skills.data[0], name: "alias" })
    // when
    const work = prepared.authorizeSkills(caller, ["alpha"], new AbortController().signal)
    // then
    await expect(work).rejects.toThrow("Ambiguous host skill id")
    expect(f.permissionRequests).toHaveLength(0)
  })
})
