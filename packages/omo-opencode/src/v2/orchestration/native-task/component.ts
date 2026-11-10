import type * as EffectPlugin from "@opencode/plugin/effect/plugin"
import type * as PromisePlugin from "@opencode/plugin/promise/plugin"
import { readEventLogTranscriptResult } from "@oh-my-opencode/orchestration-core/transcript/event-log"
import { buildSkillPrepend, CHILD_HOST_TOOLS, childStructuralToolNames, parseTaskId, resolveTaskAgents, syncTaskIdFloor } from "@oh-my-opencode/senpi-task/task-operations"
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
import { acquireReadonlyBroker, type ReadonlyBrokerOwner } from "./live-readonly-producer"
import { createNativeTaskService } from "./service"
import { READONLY_BROKER_TOOL_NAME } from "../../tools/curated-readonly"

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
}

export function acquireNativeTaskEffectOwners(context: EffectPlugin.Context, session: JoinedSession): Effect.Effect<NativeTaskEffectOwners, never, Scope.Scope> {
  return Effect.gen(function* () {
    const metadataSource = yield* acquireEffectToolMetadataSource(context.tool)
    const permission = yield* acquireEffectPermissionApi(context.permission)
    // Registered BEFORE the guard: transforms run in registration order, so the guard wraps it too.
    const readonly = yield* acquireReadonlyBroker({ tool: context.tool }, permission)
    const guard = yield* acquireOwnedChildToolGuard({ tool: context.tool, permission: context.permission })
    return { session, metadataSource, permission, guard, readonly }
  })
}

/** Non-builtin Native child names. Counterparts are resolved by the ORIGINAL host-grant
 * algorithm against the actual catalog; absent names stay unavailable, never invented. */
const CUSTOM_CANDIDATES = CHILD_HOST_TOOLS.filter(tool => tool.sessionBuiltin !== true).map(tool => tool.name)

const PUBLIC_TOOLS = ["task", "task_output", "task_send", "task_cancel"]

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
 * raw subagent/execute, this component's own public targets and the dedicated read-only broker
 * (bound only through its `curated-readonly-broker` slot) are never catalog grants. */
export function childCatalog(actual: readonly ListedTool[]): ListedTool[] {
  return actual.filter(tool => tool.options?.namespace === undefined && !["subagent", "execute", READONLY_BROKER_TOOL_NAME, ...PUBLIC_TOOLS].includes(tool.name))
}

/** Parents and non-curated children never see the broker; a bound curated child keeps it. */
export function hideUnboundReadonlyBroker(context: { readonly sessionID: string; readonly tools: Record<string, unknown> }, owner: Pick<ReadonlyBrokerOwner, "hostID" | "isBound">): void {
  if (!owner.isBound(context.sessionID)) delete context.tools[owner.hostID]
}

export async function registerNativeTaskComponent(control: PromisePlugin.Context, owners: NativeTaskEffectOwners): Promise<() => Promise<void>> {
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
    const routable = [...PUBLIC_TOOLS, ...initial.map(tool => tool.id)]
    const registry = createToolRegistry([], {})
    const kernel = createToolKernel({ registry, scopes, pipeline: createPolicyPipeline(), permission: owners.permission })
    const host = { ...control, session: { ...control.session, ...owners.session } }
    const assertGeneration = () => { current(); if (generation !== preparedGeneration) throw Error("Retired Native task generation") }
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
        return { nativeTools: childStructuralToolNames(CUSTOM_CANDIDATES).map(name => ({ name })), catalog }
      } },
      childToolGuard: owners.guard,
      // Only the read-only broker producer is installed. Kernel/member/network requirements stay
      // unbound, so a selection needing one is refused by the runner, never silently widened.
      childGuardBinding: createNativeChildGuardBinding({ assertGeneration, readonly: owners.readonly }),
    })
    closers.push(() => service.close())
    const bridge = createNativeTaskBridge({ tool: control.tool, prepared, async rollbackAcquisition() { await service.close() }, async acquire(targets) {
      current()
      const targetPermissions = targets.tools.map(tool => ({ tool, permission: service.targetPermission(tool) }))
      registry.replace(targets.tools, targets.codecs, targets.normalizers, targetPermissions)
      return { registry, kernel, service, targetPermissions,
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
    closers.splice(closers.length - 1, 1, async () => { await service.close(); await bridge.close() })
    await bridge.ready
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
