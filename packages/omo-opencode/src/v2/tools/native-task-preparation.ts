import { isAbsolute, resolve } from "node:path"
import type { SkillDomain } from "@opencode/plugin/promise/skill"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { resolveTaskAgents, buildSkillPrepend } from "@oh-my-opencode/senpi-task"
import type { LoadedSkill, SkillLoader, TaskToolParamsStatic } from "@oh-my-opencode/senpi-task/task-operations"
import { loadRuntimeConfig } from "../config/runtime"
import { hasJoinedPermissionCancellation, type JoinedPermissionApi } from "../host/effect-permission-api"
import { createModelCatalog, type ModelCatalogDomains } from "../host/model-catalog"

export type NativeTaskPreparationOptions = {
  readonly cwd: string
  readonly configOptions?: Omit<NonNullable<Parameters<typeof loadRuntimeConfig>[0]>, "cwd">
  readonly models: ModelCatalogDomains
  readonly skills: Pick<SkillDomain, "list">
  /** Supply the SAME Native algorithms via narrow exports at component assembly. */
  readonly canonical: {
    readonly resolveTaskAgents: typeof resolveTaskAgents
    readonly buildSkillPrepend: typeof buildSkillPrepend
  }
  /** Owning component lifetime/generation, not a fabricated or retained SDK caller. */
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
  /** The ORIGINAL joined permission owner of the component; skill content reaches a child only after its `skill` decision. */
  readonly permission: JoinedPermissionApi
}

/** Genuine fields of the calling tool frame; no raw ToolContext is retained. */
export type NativeSkillCaller = Pick<ToolContext, "sessionID" | "agent" | "messageID" | "id">

/** Every skill name a task call can load, with Native batch inheritance (an item's own
 * load_skills, else the top-level list). First-appearance order, each name once. */
export function requestedTaskSkillNames(input: TaskToolParamsStatic): string[] {
  const names = new Set<string>()
  const add = (list: readonly string[] | undefined) => {
    for (const name of list ?? []) names.add(name)
  }
  if (input.tasks !== undefined) for (const item of input.tasks) add(item.load_skills ?? input.load_skills)
  else if (input.prompt !== undefined) add(input.load_skills)
  return [...names]
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

/** SDK 2.2.6 read.parseSkillUri validates raw safe segments, not URL syntax.
 * Trim trailing separators only for validation; retain the original locator. */
function validSkillLocation(location: string): boolean {
  if (isAbsolute(location)) return true
  if (!location.startsWith("skill://")) return false
  return location
    .slice("skill://".length)
    .replace(/\/+$/, "")
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\\") && !segment.includes("\0"),
    )
}

type SkillCatalogIndex = {
  readonly byName: ReadonlyMap<string, LoadedSkill>
  readonly idByName: ReadonlyMap<string, string>
}

/** Validates one host listing and indexes it by name. The SDK permission resource is the skill ID,
 * never the display name; an entry without a usable ID is unavailable (Native "missing"). */
function indexSkillCatalog(list: Awaited<ReturnType<SkillDomain["list"]>>, cwd: string): SkillCatalogIndex {
  if (!isAbsolute(list.location.directory) || resolve(list.location.directory) !== cwd)
    throw Error("Foreign skill catalog location")
  const byName = new Map<string, LoadedSkill>(),
    idByName = new Map<string, string>(),
    nameById = new Map<string, string>()
  for (const skill of list.data) {
    if (
      typeof skill.name !== "string" ||
      !skill.name ||
      typeof skill.content !== "string" ||
      typeof skill.path !== "string" ||
      !validSkillLocation(skill.path)
    )
      throw Error("Invalid host skill entry")
    if (byName.has(skill.name)) throw Error(`Ambiguous host skill name: ${skill.name}`)
    byName.set(skill.name, Object.freeze({ name: skill.name, content: skill.content, location: skill.path }))
    if (typeof skill.id !== "string" || !skill.id) continue
    const other = nameById.get(skill.id)
    if (other !== undefined) throw Error(`Ambiguous host skill id: ${other}, ${skill.name}`)
    nameById.set(skill.id, skill.name)
    idByName.set(skill.name, skill.id)
  }
  return { byName, idByName }
}

/** One owned snapshot for a component lifetime. No registration or default-profile selection.
 * Original host requests are joined even when the catalog rejects before its sibling request.
 * On cancellation, only the exact signal.reason is ordinary abort: a single
 * different joined failure is rethrown unchanged, or multiple distinct failures
 * are retained in AggregateError.errors without adding the cancellation reason. */
export async function prepareNativeTaskRuntime(options: NativeTaskPreparationOptions) {
  const check = () => {
    options.signal.throwIfAborted()
    options.assertCurrent()
  }
  check()
  const permission = options.permission
  if (!hasJoinedPermissionCancellation(permission)) throw Error("Original genuine joined permission owner required")
  if (!isAbsolute(options.cwd)) throw Error("Native task preparation requires an absolute location")
  const cwd = resolve(options.cwd)
  const runtimeConfig = freeze(structuredClone(loadRuntimeConfig({ ...options.configOptions, cwd })))
  check()
  const originalWork: Promise<unknown>[] = []
  const copiedWork: Promise<unknown>[] = []
  function track<T>(invoke: () => Promise<T>): Promise<T> {
    let work: Promise<T>
    try {
      work = invoke()
    } catch (error) {
      work = Promise.reject(error)
    }
    originalWork.push(work)
    // Copy each response on settlement, not after another host request finishes.
    const copied = work.then((value) => structuredClone(value))
    copiedWork.push(copied)
    return copied
  }
  const catalog = createModelCatalog({
    model: { list: (...args) => track(() => options.models.model.list(...args)) },
    provider: { list: (...args) => track(() => options.models.provider.list(...args)) },
  })
  const results = await Promise.allSettled([
    catalog.list(),
    track(() => options.skills.list({ location: { directory: cwd } })),
  ])
  // createModelCatalog uses Promise.all internally: its rejection alone does not
  // mean that the original model/provider requests have finished.
  const joined = await Promise.allSettled([...originalWork, ...copiedWork])
  const [models, skillList] = results
  // Preserve the existing non-canceled error identity/priority.
  if (!options.signal.aborted) {
    if (models.status === "rejected") throw models.reason
    if (skillList.status === "rejected") throw skillList.reason
  }
  // Cancellation invalidates publication, not evidence of a different backend
  // failure. Inspect originals too: catalog Promise.all may have reported an
  // earlier cancellation while a provider later failed for another reason.
  const failures: unknown[] = []
  for (const result of [...joined, ...results]) {
    if (result.status !== "rejected" || (options.signal.aborted && Object.is(result.reason, options.signal.reason)))
      continue
    if (!failures.some((error) => Object.is(error, result.reason))) failures.push(result.reason)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "Joined Native task preparation failures")
  check()
  if (models.status === "rejected") throw models.reason
  if (skillList.status === "rejected") throw skillList.reason
  // Registration validates the host catalog shape only; skill resolution is call-time because the
  // host discovers directory skills (project/user) after this first listing.
  indexSkillCatalog(skillList.value, cwd)
  const canonical = options.canonical
  const agentResolver = canonical.resolveTaskAgents,
    prepend = canonical.buildSkillPrepend
  const agents = freeze(structuredClone(agentResolver.call(canonical, runtimeConfig.config)))
  const modelSnapshot = freeze(structuredClone(models.value))
  const disabled = new Set(runtimeConfig.config.disabled_skills ?? [])
  check()
  /** A FRESH host listing for this call, copied so later host mutation cannot change what was authorized. */
  async function listSkills(signal: AbortSignal): Promise<SkillCatalogIndex> {
    const live = structuredClone(await options.skills.list({ location: { directory: cwd } }))
    signal.throwIfAborted()
    check()
    return indexSkillCatalog(live, cwd)
  }
  /** Per-call authorization against a call-time listing. The genuine caller asserts `skill` for
   * each distinct resolved SDK ID, in request order, under the joined owner and the operation
   * signal; after each assert a re-listing must still map the name to the SAME ID. Disabled and
   * missing names are never asserted; they stay Native SkillResolution data. The returned loader
   * serves only names authorized here, with content from this call's listing. */
  async function authorizeSkills(
    caller: NativeSkillCaller,
    names: readonly string[],
    signal: AbortSignal,
  ): Promise<SkillLoader> {
    check()
    signal.throwIfAborted()
    // A call that requests no skills makes no host request; its loader then treats every name as missing.
    const catalog: SkillCatalogIndex = names.length
      ? await listSkills(signal)
      : { byName: new Map(), idByName: new Map() }
    const pending = new Map<string, string>()
    for (const name of names) {
      const id = disabled.has(name) ? undefined : catalog.idByName.get(name)
      if (id !== undefined && !pending.has(id)) pending.set(id, name)
    }
    const authorized = new Map<string, LoadedSkill>()
    for (const [id, name] of pending) {
      await permission.assert(
        {
          sessionID: caller.sessionID,
          agent: caller.agent,
          action: "skill",
          resources: [id],
          source: { type: "tool", messageID: caller.messageID, id: caller.id },
        },
        { signal },
      )
      signal.throwIfAborted()
      check()
      const recheck = await listSkills(signal)
      const skill = catalog.byName.get(name)
      if (recheck.idByName.get(name) !== id || !skill)
        throw Error(`Host skill identity changed during authorization: ${name}`)
      authorized.set(name, skill)
    }
    return (requested, location) => {
      check()
      if (!isAbsolute(location) || resolve(location) !== cwd)
        throw Error("Skill loader location differs from prepared location")
      const skills: LoadedSkill[] = [],
        missing: string[] = [],
        rejected: { name: string; reason: string }[] = []
      for (const name of requested) {
        if (disabled.has(name)) {
          rejected.push({ name, reason: "Skill is disabled by configuration" })
          continue
        }
        const skill = authorized.get(name)
        if (skill) skills.push(skill)
        else if (catalog.idByName.has(name)) throw Error(`Skill was not authorized for this call: ${name}`)
        else missing.push(name)
      }
      const text = prepend.call(canonical, skills, "")
      check()
      return { prepend: text, resolved: skills.map((skill) => skill.name), missing, skills, rejected }
    }
  }
  return Object.freeze({ runtimeConfig, config: runtimeConfig.config, agents, models: modelSnapshot, authorizeSkills })
}

export type PreparedNativeTaskRuntime = Awaited<ReturnType<typeof prepareNativeTaskRuntime>>
