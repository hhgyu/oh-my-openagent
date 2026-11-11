import type { ToolDomain } from "@opencode/plugin/promise/tool"
import { OmoTaskSettingsSchema, type OmoConfig } from "@oh-my-opencode/omo-config-core"
import type { DagNodeSpawnPolicy } from "@oh-my-opencode/senpi-task/dag"
import { evaluateSpawnPolicy } from "@oh-my-opencode/senpi-task/task-operations"
import type { createToolKernel } from "../../host/tool-kernel"
import type { ToolRegistry } from "../../host/tool-registry"
import { createNativeDagBridge, type NativeDagTargets } from "../../tools/native-dag"
import type { NativeTaskOperationCall } from "../../tools/native-task"
import type { NativeTaskTargetPermissionAssociation, createNativeTaskService } from "../native-task/service"
import { createNativeDagGenerationLease } from "./lease"
import type { NativeDagExecutionSources } from "./refusals"
import { createNativeDagRuntime, type NativeDagRuntime } from "./runtime"
import { nativeDagCallPort } from "./task-port"
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
  function runtimeFor(sessionID: string): NativeDagRuntime {
    const existing = runtimes.get(sessionID)
    if (existing) return existing
    const created = createNativeDagRuntime({ directory: host.directory, parentSessionID: sessionID, executionMode, lease, ...(settings && { settings }) })
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
      try { await bridge.close() } finally { lease.dispose(); runtimes.clear() }
    },
  })
}
