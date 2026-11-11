import type * as EffectPlugin from "@opencode/plugin/effect/plugin"
import type * as PromisePlugin from "@opencode/plugin/promise/plugin"
import { readEventLogTranscriptResult } from "@oh-my-opencode/orchestration-core/transcript/event-log"
import { buildSkillPrepend, CHILD_HOST_TOOLS, childStructuralToolNames, parseTaskId, resolveTaskAgents, syncTaskIdFloor } from "@oh-my-opencode/senpi-task/task-operations"
import { createTeamMailboxReconciler, teamStorageBaseDir, toTeamCoreConfig } from "@oh-my-opencode/senpi-task/team-operations"
import { listActiveTeams } from "@oh-my-opencode/team-core/team-state-store"
import { OmoTaskSettingsSchema, type OmoConfig } from "@oh-my-opencode/omo-config-core"
import { Effect, type Scope } from "effect"
import { createHash } from "node:crypto"
import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { acquireEffectPermissionApi, type JoinedPermissionApi } from "../../host/effect-permission-api"
import type { acquireEffectSessionBackendApi } from "../../host/effect-session-backend-api"
import { acquireEffectToolMetadataSource } from "../../host/effect-tool-metadata-source"
import { acquireOwnedChildToolGuard, type OwnedChildToolGuard } from "../../host/owned-child-tool-guard"
import { createPolicyPipeline } from "../../host/policy-pipeline"
import { createSessionScopes } from "../../host/session-state"
import { createToolKernel } from "../../host/tool-kernel"
import { createToolRegistry, type ListedTool } from "../../host/tool-registry"
import { createNativeTaskBridge } from "../../tools/native-task"
import { prepareNativeTaskRuntime } from "../../tools/native-task-preparation"
import { createNativeChildGuardBinding } from "./child-guard-binding"
import { acquireTeamMemberOwner, type TeamMemberOwner } from "./live-member-owner"
import { acquireReadonlyBroker, type ReadonlyBrokerOwner } from "./live-readonly-producer"
import { acquireCodemodeReadonly, type CodemodeReadonlyOwner } from "./live-codemode-readonly"
import { CODEMODE_READONLY_NATIVE_NAME } from "../../tools/codemode-readonly"
import { createNativeTaskService } from "./service"
import { READONLY_BROKER_TOOL_NAME } from "../../tools/curated-readonly"
import { TEAM_MEMBER_SEND_TOOL_NAME } from "../../tools/team-member-send"
import { NATIVE_TASK_TOOL_NAMES } from "../../tools/native-task"
import { NATIVE_TEAM_TOOL_NAMES } from "../../tools/native-team-codecs"
import type { NativeTeamTargets } from "../../tools/native-team"
import type { NativeTeamComponent, NativeTeamHost } from "../native-team/component"
import { NATIVE_DAG_TOOL_NAME } from "../../tools/native-dag-codecs"
import type { NativeDagTargets } from "../../tools/native-dag"
import type { NativeDagComponent, NativeDagHost } from "../native-dag/component"
import type { NativeTaskTargetPermissionAssociation } from "./service"

type MetadataSource = Parameters<typeof createNativeTaskService>[1]["metadataSource"]
type JoinedSession = Effect.Success<ReturnType<typeof acquireEffectSessionBackendApi>>

/** Effect-scoped owners acquired in the genuine plugin Effect scope BEFORE the Promise
 * component. Scope finalization is LIFO, so these close after the component's own cleanup. */
export interface NativeTaskEffectOwners {
  readonly session: JoinedSession
  readonly metadataSource: MetadataSource
  readonly permission: JoinedPermissionApi
  readonly guard: OwnedChildToolGuard
  /** Dedicated curated read-only broker registration, executable only by its bound owned child. */
  readonly readonly: ReadonlyBrokerOwner
  /** Dedicated team member send registration, executable only by its bound in-process member. */
  readonly member: TeamMemberOwner
  /** Dedicated CodeMode `ls` counterpart registration, executable only by its bound owned child. */
  readonly codemodeReadonly: CodemodeReadonlyOwner
}

/** The task settings of a lead's per-lead team service: its team storage lives in the lead's own
 * Native task state directory. */
export function nativeTeamSettings(projectDirectory: string, leadSessionID: string, config: OmoConfig) {
  return { ...OmoTaskSettingsSchema.parse(config.task ?? {}), state_dir: nativeTaskStateDir(projectDirectory, leadSessionID) }
}

/** The team-core config of a lead's team storage: the same root its per-lead team service writes. */
export function nativeTeamConfig(projectDirectory: string, leadSessionID: string, config: OmoConfig) {
  const settings = nativeTeamSettings(projectDirectory, leadSessionID, config)
  return toTeamCoreConfig(settings, teamStorageBaseDir({ project_dir: projectDirectory, task: { state_dir: settings.state_dir } }))
}

/** Leads with an active team in this project's Native state: each candidate comes from a team's own
 * runtime state and must hash to the very state directory that state was read from, so a state file
 * cannot name a lead whose storage lives elsewhere. Never scans when the project directory is $HOME. */
export async function discoverTeamLeads(projectDirectory: string, config: OmoConfig): Promise<string[]> {
  if (resolve(projectDirectory) === resolve(homedir())) return []
  const root = join(projectDirectory, ".omo", "tasks", "opencode-v2")
  if (!existsSync(root)) return []
  const leads = new Set<string>()
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue
    const stateDir = join(root, entry.name)
    const settings = { ...OmoTaskSettingsSchema.parse(config.task ?? {}), state_dir: stateDir }
    const teams = await listActiveTeams(toTeamCoreConfig(settings, teamStorageBaseDir({ project_dir: projectDirectory, task: { state_dir: stateDir } })))
    for (const team of teams) {
      const lead = team.leadSessionId
      if (lead !== undefined && nativeTaskStateDir(projectDirectory, lead) === stateDir) leads.add(lead)
    }
  }
  return [...leads]
}

export function acquireNativeTaskEffectOwners(context: EffectPlugin.Context, session: JoinedSession): Effect.Effect<NativeTaskEffectOwners, never, Scope.Scope> {
  return Effect.gen(function* () {
    const metadataSource = yield* acquireEffectToolMetadataSource(context.tool)
    const permission = yield* acquireEffectPermissionApi(context.permission)
    // Registered BEFORE the guard: transforms run in registration order, so the guard wraps it too.
    const readonly = yield* acquireReadonlyBroker({ tool: context.tool }, permission)
    const member = yield* acquireTeamMemberOwner({ tool: context.tool })
    const codemodeReadonly = yield* acquireCodemodeReadonly({ tool: context.tool }, permission)
    const guard = yield* acquireOwnedChildToolGuard({ tool: context.tool, permission: context.permission })
    return { session, metadataSource, permission, guard, readonly, member, codemodeReadonly }
  })
}

/** Non-builtin Native child names. Counterparts are resolved by the ORIGINAL host-grant
 * algorithm against the actual catalog; absent names stay unavailable, never invented. */
const CUSTOM_CANDIDATES = CHILD_HOST_TOOLS.filter(tool => tool.sessionBuiltin !== true).map(tool => tool.name)

/** The public Native targets: the 4 task tools, the 6 lead team tools and `workflow`. Never child catalog grants. */
const PUBLIC_TOOLS: readonly string[] = [...NATIVE_TASK_TOOL_NAMES, ...NATIVE_TEAM_TOOL_NAMES, NATIVE_DAG_TOOL_NAME]

const TASK_RECORD_FILE = /^(st_[0-9a-f]{8})\.json$/

/** Native seeds its process-wide id floor from ONE project store. V2 keeps one store per parent,
 * so the floor is seeded from every V2 parent store of this project; otherwise a reloaded module
 * can reissue an id another parent already holds. Only this component's own subtree is read, and
 * never when the project directory is $HOME (there `.omo` is the OmO home). */
export function seedTaskIdFloor(projectDirectory: string): void {
  if (resolve(projectDirectory) === resolve(homedir())) return
  const root = join(projectDirectory, ".omo", "tasks", "opencode-v2")
  if (!existsSync(root)) return
  let max: string | undefined
  for (const parent of readdirSync(root, { withFileTypes: true })) {
    if (!parent.isDirectory()) continue
    const tasks = join(root, parent.name, "tasks")
    if (!existsSync(tasks)) continue
    for (const file of readdirSync(tasks)) {
      const id = TASK_RECORD_FILE.exec(file)?.[1]
      if (id && (max === undefined || id > max)) max = id
    }
  }
  if (max) syncTaskIdFloor(parseTaskId(max))
}

export function nativeTaskStateDir(projectDirectory: string, parentSessionID: string): string {
  return join(projectDirectory, ".omo", "tasks", "opencode-v2", createHash("sha256").update(parentSessionID).digest("hex"))
}

/** Unnamespaced actual catalog entries a Native child may be granted. Namespaced CodeMode tools,
 * raw subagent/execute, this component's own public targets, the dedicated read-only broker
 * (bound only through its `curated-readonly-broker` slot) and the dedicated team member send
 * (bound only through its `member-live-bindings` slot) are never catalog grants. */
export function childCatalog(actual: readonly ListedTool[]): ListedTool[] {
  return actual.filter(tool => tool.options?.namespace === undefined && !["subagent", "execute", READONLY_BROKER_TOOL_NAME, TEAM_MEMBER_SEND_TOOL_NAME, ...PUBLIC_TOOLS].includes(tool.name))
}

type ModelContext = { readonly sessionID: string; readonly tools: Record<string, unknown> }
type BoundOwner = { readonly hostID: string; isBound(sessionID: string): boolean }

function hideUnbound(context: ModelContext, owner: BoundOwner): void {
  if (!owner.isBound(context.sessionID)) delete context.tools[owner.hostID]
}

/** Parents and non-curated children never see the broker; a bound curated child keeps it. */
export function hideUnboundReadonlyBroker(context: ModelContext, owner: Pick<ReadonlyBrokerOwner, "hostID" | "isBound">): void {
  hideUnbound(context, owner)
}

/** Parents and non-member sessions never see the member send; a bound in-process member keeps it. */
export function hideUnboundTeamMemberSend(context: ModelContext, owner: Pick<TeamMemberOwner, "hostID" | "isBound">): void {
  hideUnbound(context, owner)
}

/** Parents and children without the `ls` grant never see the CodeMode counterpart. */
export function hideUnboundCodemodeReadonly(context: ModelContext, owner: Pick<CodemodeReadonlyOwner, "hostID" | "isBound">): void {
  hideUnbound(context, owner)
}

export interface NativeTaskComponentOptions {
  /** The lead team component, assembled over this component's SAME registry, kernel and service. */
  readonly team?: (host: NativeTeamHost) => NativeTeamComponent
  /** The blocking `workflow` component, assembled over the SAME registry, kernel and service. */
  readonly dag?: (host: NativeDagHost) => NativeDagComponent
}

export async function registerNativeTaskComponent(control: PromisePlugin.Context, owners: NativeTaskEffectOwners, options: NativeTaskComponentOptions = {}): Promise<() => Promise<void>> {
  const directory = control.location.directory
  const lifetime = new AbortController(), scopes = createSessionScopes()
  let accepting = true, generation = 1
  const current = () => { if (!accepting) throw Error("Native task component is closing"); lifetime.signal.throwIfAborted() }
  const closers: (() => Promise<void> | void)[] = []
  async function close() {
    accepting = false
    lifetime.abort(Error("Native task component closed"))
    generation++
    // Failed closers stay retained so a later close retries them; distinct failures are aggregated.
    const errors: unknown[] = []
    for (const closer of [...closers].reverse()) {
      try { await closer(); closers.splice(closers.indexOf(closer), 1) } catch (error) { errors.push(error) }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, "Native task component cleanup incomplete")
  }
  try {
    seedTaskIdFloor(directory)
    const prepared = await prepareNativeTaskRuntime({ cwd: directory, models: control, skills: control.skill,
      canonical: { resolveTaskAgents, buildSkillPrepend }, signal: lifetime.signal, assertCurrent: current, permission: owners.permission })
    const preparedGeneration = generation
    const initial = childCatalog(await control.tool.list())
    current()
    // The dedicated broker is exposed to a model request only in a session with a live bound producer.
    const brokerVisibility = await control.session.hook("context", context => hideUnboundReadonlyBroker(context, owners.readonly))
    closers.push(() => brokerVisibility.dispose())
    current()
    // The member send is exposed to a model request only in a session with a live bound member producer.
    const memberVisibility = await control.session.hook("context", context => hideUnboundTeamMemberSend(context, owners.member))
    closers.push(() => memberVisibility.dispose())
    current()
    const listingVisibility = await control.session.hook("context", context => hideUnboundCodemodeReadonly(context, owners.codemodeReadonly))
    closers.push(() => listingVisibility.dispose())
    current()
    const routable = [...PUBLIC_TOOLS, ...initial.map(tool => tool.id)]
    const registry = createToolRegistry([], {})
    const kernel = createToolKernel({ registry, scopes, pipeline: createPolicyPipeline(), permission: owners.permission })
    const host = { ...control, session: { ...control.session, ...owners.session } }
    const assertGeneration = () => { current(); if (generation !== preparedGeneration) throw Error("Retired Native task generation") }
    // The team component is assembled after the service; a member bound before it exists gets no delivery.
    let teamComponent: NativeTeamComponent | undefined
    const service = createNativeTaskService(host, {
      scopes, callAuthority: kernel.callAuthority, metadataSource: owners.metadataSource,
      agents: prepared.agents, config: () => prepared.config, stateDirFor: id => nativeTaskStateDir(directory, id),
      policy: { tools: routable, authorize(call) {
        if (call.requested !== call.routed || !routable.includes(call.requested)) throw Error("Native task route outside the owned surface")
      } },
      hostGrant: { permission: owners.permission, assertCurrent: assertGeneration, async preparationFor(_spec, _plan, signal) {
        signal.throwIfAborted(); assertGeneration()
        const catalog = childCatalog(await control.tool.list())
        signal.throwIfAborted(); assertGeneration()
        // Native `ls` maps to the CodeMode counterpart only while its registration is in the actual catalog.
        const listing = owners.codemodeReadonly.hostID
        const customCounterparts = catalog.some(tool => tool.id === listing) ? [{ nativeName: CODEMODE_READONLY_NATIVE_NAME, hostID: listing }] : []
        return { nativeTools: childStructuralToolNames(CUSTOM_CANDIDATES).map(name => ({ name })), catalog, customCounterparts }
      } },
      childToolGuard: owners.guard,
      // The read-only broker, member task_send and CodeMode `ls` producers are installed; CodeMode
      // fetch GET is bound only for a child granted Native `webfetch`, deny-all otherwise. Kernel requirements and other member slots stay
      // unbound, so a selection needing one is refused by the runner, never silently widened.
      childGuardBinding: createNativeChildGuardBinding({ assertGeneration, readonly: owners.readonly,
        codemodeReadonly: owners.codemodeReadonly, network: { guard: owners.guard },
        member: { owner: owners.member, teamConfigFor: lead => nativeTeamConfig(directory, lead, prepared.config),
          onBound: member => teamComponent?.memberBound(member) ?? (() => {}) } }),
    })
    closers.push(() => service.close())
    // The team targets join the task targets in ONE registry generation; the team bridge waits for it.
    const teamTargets = Promise.withResolvers<NativeTeamTargets | undefined>()
    const teamRegistered = Promise.withResolvers<readonly NativeTaskTargetPermissionAssociation[]>()
    void teamRegistered.promise.catch(() => {})
    const team = options.team?.({ tool: control.tool, directory, prepared, registry, kernel, service, assertCurrent: current,
      delivery: { session: owners.session, assertGeneration, isMemberBound: sessionID => owners.member.isBound(sessionID),
        teamConfigFor: lead => nativeTeamConfig(directory, lead, prepared.config),
        journalPathFor: lead => join(nativeTaskStateDir(directory, lead), "team-deliveries.sqlite"),
        discoverLeads: () => discoverTeamLeads(directory, prepared.config),
        reconcileMailbox: lead => createTeamMailboxReconciler({ cwd: directory, settings: nativeTeamSettings(directory, lead, prepared.config), leadSessionId: () => lead })() },
      register(targets) { teamTargets.resolve(targets); return teamRegistered.promise } })
    teamComponent = team
    if (!team) teamTargets.resolve(undefined)
    // The workflow target joins the same registry generation, the same way.
    const dagTargets = Promise.withResolvers<NativeDagTargets | undefined>()
    const dagRegistered = Promise.withResolvers<readonly NativeTaskTargetPermissionAssociation[]>()
    void dagRegistered.promise.catch(() => {})
    const dag = options.dag?.({ tool: control.tool, directory, prepared, registry, kernel, service, assertCurrent: current,
      delivery: { session: owners.session, assertGeneration },
      register(targets) { dagTargets.resolve(targets); return dagRegistered.promise } })
    if (!dag) dagTargets.resolve(undefined)
    const closeTeam = async () => {
      teamRegistered.reject(Error("Native task component closed")); dagRegistered.reject(Error("Native task component closed"))
      try { await dag?.close() } finally { await team?.close() }
    }
    closers.push(closeTeam)
    const bridge = createNativeTaskBridge({ tool: control.tool, prepared, async rollbackAcquisition() { await service.close() }, async acquire(targets) {
      current()
      let teamPermissions: NativeTaskTargetPermissionAssociation[] = [], dagPermissions: NativeTaskTargetPermissionAssociation[] = []
      let targetPermissions: NativeTaskTargetPermissionAssociation[]
      try {
        const [teamDefinitions, dagDefinitions] = await Promise.all([teamTargets.promise, dagTargets.promise])
        current()
        targetPermissions = targets.tools.map(tool => ({ tool, permission: service.targetPermission(tool) }))
        teamPermissions = teamDefinitions?.tools.map(tool => ({ tool, permission: service.targetPermission(tool) })) ?? []
        dagPermissions = dagDefinitions?.tools.map(tool => ({ tool, permission: service.targetPermission(tool) })) ?? []
        registry.replace([...targets.tools, ...teamDefinitions?.tools ?? [], ...dagDefinitions?.tools ?? []],
          [...targets.codecs, ...teamDefinitions?.codecs ?? [], ...dagDefinitions?.codecs ?? []], targets.normalizers,
          [...targetPermissions, ...teamPermissions, ...dagPermissions])
      } catch (error) { teamRegistered.reject(error); dagRegistered.reject(error); throw error }
      teamRegistered.resolve(teamPermissions)
      dagRegistered.resolve(dagPermissions)
      return { registry, kernel, service, targetPermissions,
        ...(team && { teamRouting: (caller: Parameters<NativeTeamComponent["teamRouting"]>[0], call: Parameters<NativeTeamComponent["teamRouting"]>[1]) => team.teamRouting(caller, call) }),
        async context(caller, signal) {
          const actual = await owners.session.get({ sessionID: caller.sessionID }, { signal })
          signal.throwIfAborted(); current()
          if (actual.id !== caller.sessionID || actual.location.directory !== directory) throw Error("Foreign Native task context")
          return { cwd: actual.location.directory, sessionManager: { getSessionId: () => actual.id } }
        },
        taskDependencies: () => ({ resolveChildToolNames: () => childStructuralToolNames(CUSTOM_CANDIDATES) }),
        outputDependencies: caller => ({ stateDir: nativeTaskStateDir(directory, caller.sessionID), transcriptReader: ({ stateDir, taskId }) => readEventLogTranscriptResult(stateDir, taskId) }),
        async release() { scopes.dispose() } }
    } })
    // Same order the actual public campaign proved: original service operations end first,
    // then the bridge joins public callbacks and disposes its registrations.
    closers.splice(closers.length - 2, 2, async () => { await service.close(); await closeTeam(); await bridge.close() })
    await bridge.ready
    await team?.ready
    await dag?.ready
  } catch (error) {
    try { await close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], "Native task component setup failed and cleanup is incomplete") }
    throw error
  }
  let closing: Promise<void> | undefined
  return () => {
    closing ??= close().catch(error => { closing = undefined; throw error })
    return closing
  }
}
