import type { ToolDomain } from "@opencode/plugin/promise/tool"
import { OmoTaskSettingsSchema, type OmoConfig } from "@oh-my-opencode/omo-config-core"
import type { DagNodeSpawnPolicy } from "@oh-my-opencode/senpi-task/dag"
import type { SkillInvocationState } from "@oh-my-opencode/senpi-task"
import { evaluateSpawnPolicy } from "@oh-my-opencode/senpi-task/task-operations"
import { createTaskRecordStore } from "@oh-my-opencode/senpi-task/manager-kernel"
import { join } from "node:path"
import type { createToolKernel } from "../../host/tool-kernel"
import type { ToolRegistry } from "../../host/tool-registry"
import { createNativeDagBridge, type NativeDagTargets } from "../../tools/native-dag"
import type { NativeTaskOperationCall } from "../../tools/native-task"
import type { PreparedNativeTaskRuntime } from "../../tools/native-task-preparation"
import { nativeTaskStateDir } from "../native-task/component"
import type { NativeTaskTargetPermissionAssociation, createNativeTaskService } from "../native-task/service"
import { discoverDagRoots } from "./discovery"
import { createNativeDagGenerationLease } from "./lease"
import type { NativeDagExecutionSources } from "./refusals"
import { createNativeDagRuntime, type NativeDagRuntime } from "./runtime"
import { nativeDagSkillAuthority } from "./skills"
import { nativeDagCallPort } from "./task-port"
import { createNativeDagWakeOwner, type DagWakeOptions } from "./wake"
import { runNativeWorkflow } from "./workflow-call"

const TERMINAL_RUN: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])

/** The Native task component's shared owner, handed to the workflow component during its assembly. */
export interface NativeDagHost {
  readonly tool: ToolDomain
  readonly directory: string
  readonly prepared: { readonly config: OmoConfig; readonly agents: NativeDagExecutionSources["agents"]; readonly authorizeSkills: PreparedNativeTaskRuntime["authorizeSkills"] }
  readonly registry: ToolRegistry
  readonly kernel: ReturnType<typeof createToolKernel>
  readonly service: ReturnType<typeof createNativeTaskService>
  readonly assertCurrent: () => void
  readonly resolveSkillInvocations?: (sessionID: string) => SkillInvocationState
  /** Trusted ports of the component-owned run wake (S6d). */
  readonly delivery: Pick<DagWakeOptions, "session" | "assertGeneration">
  /** Hands the workflow target to the shared registry; resolves with its issued permission once the
   * registry owns it together with the task targets. */
  register(targets: NativeDagTargets): Promise<readonly NativeTaskTargetPermissionAssociation[]>
}

export interface NativeDagComponent {
  readonly ready: Promise<void>
  close(): Promise<void>
}

/** `workflow` runs only for a root session, like the lead team tools: an owned child never drives a run. */
export function assertRootWorkflowCaller(sessionID: string, call: Pick<NativeTaskOperationCall, "resolveAncestry">): void {
  const ancestry = call.resolveAncestry(sessionID)
  if (ancestry === undefined || ancestry.rootSessionId !== sessionID || ancestry.depth !== 0) throw Error("The workflow tool is available only to a root session")
}

/** Publishes the Native `workflow` tool over the Native task component's SAME registry, kernel and
 * service. Every call runs inside that service's per-call operation, so node starts use THAT call's
 * host authority; no authority is stored for later admissions. */
export function registerNativeDagComponent(host: NativeDagHost): NativeDagComponent {
  const lease = createNativeDagGenerationLease()
  const settings = OmoTaskSettingsSchema.parse(host.prepared.config.task ?? {}).dag
  const executionMode: NativeDagExecutionSources = { agents: host.prepared.agents, config: host.prepared.config }
  const runtimes = new Map<string, NativeDagRuntime>()
  // Read-only views of each root's persisted task records: the wake reads child status with no call.
  const taskRecords = new Map<string, ReturnType<typeof createTaskRecordStore>>()
  function taskRecordsFor(root: string) {
    let store = taskRecords.get(root)
    if (!store) {
      store = createTaskRecordStore({ project_dir: host.directory, task: { state_dir: nativeTaskStateDir(host.directory, root) } })
      taskRecords.set(root, store)
    }
    return store
  }
  const wake = createNativeDagWakeOwner({ session: host.delivery.session, directory: host.directory, assertGeneration: host.delivery.assertGeneration,
    journalPathFor: root => join(nativeTaskStateDir(host.directory, root), "dag-wakes.sqlite"),
    runtimeFor: root => runtimes.get(root),
    childState: (root, taskId) => {
      const child = taskRecordsFor(root).load(taskId)
      return child ? { status: child.status, runEpoch: child.notification.run_epoch } : undefined
    } })
  function runtimeFor(sessionID: string): NativeDagRuntime {
    const existing = runtimes.get(sessionID)
    if (existing) return existing
    const created = createNativeDagRuntime({ directory: host.directory, parentSessionID: sessionID, executionMode, lease, ...(settings && { settings }),
      onDriveEnded: runId => wake.arm(sessionID, runId) })
    runtimes.set(sessionID, created)
    return created
  }
  const bridge = createNativeDagBridge({
    tool: host.tool,
    async rollbackAcquisition() { await host.service.close() },
    async acquire(targets) {
      host.assertCurrent()
      const targetPermissions = await host.register(targets)
      host.assertCurrent()
      return { registry: host.registry, kernel: host.kernel, service: host.service, targetPermissions,
        workflow(caller, call) {
          assertRootWorkflowCaller(caller.sessionID, call)
          const runtime = runtimeFor(caller.sessionID)
          const spawnPolicy: DagNodeSpawnPolicy = node => evaluateSpawnPolicy({ manager: call.operation.task, omoConfig: host.prepared.config,
            agents: host.prepared.agents, resolveSkillInvocations: host.resolveSkillInvocations }, node.subagentType, node.prompt, node.parentSessionId)
          // S2 per-call skill authorization for THIS caller (the root session and its agent), at call time.
          const skillSignal = AbortSignal.any([caller.signal, call.signal])
          const skills = nativeDagSkillAuthority({ store: runtime.store, cwd: host.directory,
            authorize: names => host.prepared.authorizeSkills(caller, names, skillSignal) })
          return params => runNativeWorkflow({ runtime, parentSessionID: caller.sessionID, executionMode, skills,
            call: { port: nativeDagCallPort(call.operation), signal: call.signal, spawnPolicy } }, params)
        },
        // The registry, scopes and service are released by the Native task component.
        async release() {} }
    },
  })
  // Startup after a reload: every root with a DAG store gets its runs watched again by THIS
  // generation's wake owner, so an un-ACKed wake is re-posted with its same id and text once every
  // re-check passes. A wake is a notification: nothing is admitted or recovered without a call.
  const startup = bridge.ready.then(() => {
    for (const root of discoverDagRoots(host.directory)) {
      const runtime = runtimeFor(root)
      for (const run of runtime.manager.list(root, { limit: 256 })) if (!TERMINAL_RUN.has(run.status)) wake.arm(root, run.runId)
    }
  }).catch((error: unknown) => { console.warn("[oh-my-openagent/v2] workflow wake resume held", error instanceof Error ? error.message : String(error)) })
  /** Native shutdown pause of every live run this generation knows, once its drives retired: the
   * next generation's call recovers each lazily. Children are parked by the closing task service. */
  async function pauseRuns(): Promise<void> {
    const failures: unknown[] = []
    for (const runtime of runtimes.values()) await runtime.pauseForShutdown().catch((error: unknown) => { failures.push(error) })
    if (failures.length > 0) throw new AggregateError(failures, "Native workflow shutdown pause incomplete")
  }
  return Object.freeze({
    ready: bridge.ready,
    async close() {
      try { await bridge.close() } finally {
        try { await startup; await pauseRuns() } finally {
          try { await wake.close() } finally {
            for (const store of taskRecords.values()) store.close()
            taskRecords.clear(); lease.dispose(); runtimes.clear()
          }
        }
      }
    },
  })
}
