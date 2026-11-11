import type { ToolDomain } from "@opencode/plugin/promise/tool"
import { OmoTaskSettingsSchema, type OmoConfig } from "@oh-my-opencode/omo-config-core"
import type { DagNodeSpawnPolicy } from "@oh-my-opencode/senpi-task/dag"
import { evaluateSpawnPolicy } from "@oh-my-opencode/senpi-task/task-operations"
import { createTaskRecordStore } from "@oh-my-opencode/senpi-task/manager-kernel"
import { join } from "node:path"
import type { createToolKernel } from "../../host/tool-kernel"
import type { ToolRegistry } from "../../host/tool-registry"
import { createNativeDagBridge, type NativeDagTargets } from "../../tools/native-dag"
import type { NativeTaskOperationCall } from "../../tools/native-task"
import { nativeTaskStateDir } from "../native-task/component"
import type { NativeTaskTargetPermissionAssociation, createNativeTaskService } from "../native-task/service"
import { createNativeDagGenerationLease } from "./lease"
import type { NativeDagExecutionSources } from "./refusals"
import { createNativeDagRuntime, type NativeDagRuntime } from "./runtime"
import { nativeDagCallPort } from "./task-port"
import { createNativeDagWakeOwner, type DagWakeOptions } from "./wake"
import { runNativeWorkflow } from "./workflow-call"

/** The Native task component's shared owner, handed to the workflow component during its assembly. */
export interface NativeDagHost {
  readonly tool: ToolDomain
  readonly directory: string
  readonly prepared: { readonly config: OmoConfig; readonly agents: NativeDagExecutionSources["agents"] }
  readonly registry: ToolRegistry
  readonly kernel: ReturnType<typeof createToolKernel>
  readonly service: ReturnType<typeof createNativeTaskService>
  readonly assertCurrent: () => void
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
    childStatus: (root, taskId) => taskRecordsFor(root).load(taskId)?.status })
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
          // The V2 task tool's own spawn policy deps: no skill-invocation resolver, so plan-gated agents fail closed.
          const spawnPolicy: DagNodeSpawnPolicy = node => evaluateSpawnPolicy({ manager: call.operation.task, omoConfig: host.prepared.config,
            agents: host.prepared.agents }, node.subagentType, node.prompt, node.parentSessionId)
          return params => runNativeWorkflow({ runtime, parentSessionID: caller.sessionID, executionMode,
            call: { port: nativeDagCallPort(call.operation), signal: call.signal, spawnPolicy } }, params)
        },
        // The registry, scopes and service are released by the Native task component.
        async release() {} }
    },
  })
  return Object.freeze({
    ready: bridge.ready,
    async close() {
      try { await bridge.close() } finally {
        try { await wake.close() } finally {
          for (const store of taskRecords.values()) store.close()
          taskRecords.clear(); lease.dispose(); runtimes.clear()
        }
      }
    },
  })
}
