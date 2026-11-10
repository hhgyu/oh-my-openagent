import { isAbsolute, resolve } from "node:path"
import type { SkillDomain } from "@opencode/plugin/promise/skill"
import type { resolveTaskAgents, buildSkillPrepend } from "@oh-my-opencode/senpi-task"
import type { LoadedSkill, SkillLoader } from "@oh-my-opencode/senpi-task/task-operations"
import { loadRuntimeConfig } from "../config/runtime"
import { createModelCatalog, type ModelCatalogDomains } from "../host/model-catalog"

export type NativeTaskPreparationOptions = {
  readonly cwd: string
  readonly configOptions?: Omit<NonNullable<Parameters<typeof loadRuntimeConfig>[0]>, "cwd">
  readonly models: ModelCatalogDomains
  readonly skills: Pick<SkillDomain, "list">
  /** Supply the SAME Native algorithms via narrow exports at component assembly. */
  readonly canonical: { readonly resolveTaskAgents: typeof resolveTaskAgents; readonly buildSkillPrepend: typeof buildSkillPrepend }
  /** Owning component lifetime/generation, not a fabricated or retained SDK caller. */
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
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
  return location.slice("skill://".length).replace(/\/+$/, "").split("/").every(segment =>
    segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("\\") && !segment.includes("\0"))
}

/** One owned snapshot for a component lifetime. No registration or default-profile selection.
 * Original host requests are joined even when the catalog rejects before its sibling request.
 * On cancellation, only the exact signal.reason is ordinary abort: a single
 * different joined failure is rethrown unchanged, or multiple distinct failures
 * are retained in AggregateError.errors without adding the cancellation reason. */
export async function prepareNativeTaskRuntime(options: NativeTaskPreparationOptions) {
  const check = () => { options.signal.throwIfAborted(); options.assertCurrent() }
  check()
  if (!isAbsolute(options.cwd)) throw Error("Native task preparation requires an absolute location")
  const cwd = resolve(options.cwd)
  const runtimeConfig = freeze(structuredClone(loadRuntimeConfig({ ...options.configOptions, cwd })))
  check()
  const originalWork: Promise<unknown>[] = []
  const copiedWork: Promise<unknown>[] = []
  function track<T>(invoke: () => Promise<T>): Promise<T> {
    let work: Promise<T>
    try { work = invoke() } catch (error) { work = Promise.reject(error) }
    originalWork.push(work)
    // Copy each response on settlement, not after another host request finishes.
    const copied = work.then(value => structuredClone(value))
    copiedWork.push(copied)
    return copied
  }
  const catalog = createModelCatalog({
    model: { list: (...args) => track(() => options.models.model.list(...args)) },
    provider: { list: (...args) => track(() => options.models.provider.list(...args)) },
  })
  const results = await Promise.allSettled([
    catalog.list(), track(() => options.skills.list({ location: { directory: cwd } })),
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
    if (result.status !== "rejected" || options.signal.aborted && Object.is(result.reason, options.signal.reason)) continue
    if (!failures.some(error => Object.is(error, result.reason))) failures.push(result.reason)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, "Joined Native task preparation failures")
  check()
  if (models.status === "rejected") throw models.reason
  if (skillList.status === "rejected") throw skillList.reason
  if (!isAbsolute(skillList.value.location.directory) || resolve(skillList.value.location.directory) !== cwd) throw Error("Foreign skill catalog location")
  const byName = new Map<string, LoadedSkill>()
  for (const skill of skillList.value.data) {
    if (typeof skill.name !== "string" || !skill.name || typeof skill.content !== "string" || typeof skill.path !== "string" || !validSkillLocation(skill.path)) throw Error("Invalid host skill entry")
    if (byName.has(skill.name)) throw Error(`Ambiguous host skill name: ${skill.name}`)
    byName.set(skill.name, Object.freeze({ name: skill.name, content: skill.content, location: skill.path }))
  }
  const canonical = options.canonical
  const agentResolver = canonical.resolveTaskAgents, prepend = canonical.buildSkillPrepend
  const agents = freeze(structuredClone(agentResolver.call(canonical, runtimeConfig.config)))
  const modelSnapshot = freeze(structuredClone(models.value))
  const disabled = new Set(runtimeConfig.config.disabled_skills ?? [])
  check()
  const loadSkills: SkillLoader = (names, location) => {
    check()
    if (!isAbsolute(location) || resolve(location) !== cwd) throw Error("Skill loader location differs from prepared snapshot")
    const skills: LoadedSkill[] = [], missing: string[] = [], rejected: { name: string; reason: string }[] = []
    for (const name of names) {
      if (disabled.has(name)) rejected.push({ name, reason: "Skill is disabled by configuration" })
      else {
        const skill = byName.get(name)
        if (skill) skills.push(skill)
        else missing.push(name)
      }
    }
    const text = prepend.call(canonical, skills, "")
    check()
    return { prepend: text, resolved: skills.map(skill => skill.name), missing, skills, rejected }
  }
  return Object.freeze({ runtimeConfig, config: runtimeConfig.config, agents, models: modelSnapshot, loadSkills })
}

export type PreparedNativeTaskRuntime = Awaited<ReturnType<typeof prepareNativeTaskRuntime>>
