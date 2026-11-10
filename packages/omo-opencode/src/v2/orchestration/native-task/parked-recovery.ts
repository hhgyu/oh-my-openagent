import { AsyncLocalStorage } from "node:async_hooks"
import { buildRespawnManagedSpec, type ManagedStartSpec, type TaskRecord } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { ChildGuardApproval, OwnedChildToolGuard } from "../../host/owned-child-tool-guard"
import type { PreparedHostTaskGrant } from "./host-grant"

/** DATA returned by the current call's genuine G2 recovery approval (host-grant authorizeRecovery). */
export interface RecoveryAuthorization { readonly buildAgentID: string; readonly selection: PreparedHostTaskGrant; readonly authorityIssued: false }
interface CurrentAuthority { assertAdmission(): void; assertLifetime(): void }
export interface FreshRecoveryApproval {
  readonly identity: object
  readonly taskId: string
  readonly footprint: string
  readonly prepared: RecoveryAuthorization
  readonly guardApproval: ChildGuardApproval
  readonly authority: CurrentAuthority
}

/** Persona/tool/ancestry/model identity of a rebuilt spec. A drift between the approved and the
 * actually relaunched rebuild refuses recovery instead of changing the child to fit. */
function footprint(spec: ManagedStartSpec): string {
  return JSON.stringify({ task: spec.taskId, cwd: spec.cwd, parent: spec.parentSessionId, root: spec.rootSessionId, depth: spec.depth,
    agent: spec.agentType, instructions: spec.instructions, allow: spec.toolAllowlist, deny: spec.toolDenylist,
    members: spec.memberScopedToolNames, includeTaskTools: spec.includeTaskTools, model: spec.model, resolved: spec.resolvedModel })
}

/**
 * Fresh-action recovery approvals for guarded children. A recovery approval is minted ONLY from a
 * genuine current call (captureStartAuthority throws without one) and that call's real joined
 * permission request; stale pre-reload custody, persisted names or a previous rule snapshot never
 * authorize. Autonomous recovery (no current call) therefore cannot reacquire a guarded child.
 */
export function createFreshRecoveryApprovals(options: {
  readonly guard: OwnedChildToolGuard
  readonly stateDir: string
  readonly authorize?: (spec: ManagedStartSpec) => Promise<RecoveryAuthorization>
  capture(): CurrentAuthority
}) {
  const scope = new AsyncLocalStorage<FreshRecoveryApproval>(), bySpec = new WeakMap<ManagedStartSpec, FreshRecoveryApproval>()
  return {
    /** Must run BEFORE residency admission and any claim/reattach. */
    async approve(record: TaskRecord): Promise<FreshRecoveryApproval> {
      if (!options.authorize) throw Error("Guarded recovery requires a fresh current-call authorization port")
      const authority = options.capture()
      authority.assertAdmission()
      const rebuilt = buildRespawnManagedSpec(record, options.stateDir)
      if (!rebuilt.ok) throw Error(rebuilt.reason)
      const prepared = await options.authorize(rebuilt.spec)
      authority.assertAdmission()
      const identity = Object.freeze({})
      const guardApproval = options.guard.approve(identity, { selection: prepared.selection, buildAgentID: prepared.buildAgentID, assertCurrent: () => authority.assertLifetime() })
      return Object.freeze({ identity, taskId: record.task_id, footprint: footprint(rebuilt.spec), prepared, guardApproval, authority })
    },
    run<T>(approval: FreshRecoveryApproval, work: () => Promise<T>): Promise<T> { return scope.run(approval, work) },
    /** Binds the approval to owned-recovery's EXACT rebuilt spec object before beforeLaunch. */
    verify(record: TaskRecord, spec: ManagedStartSpec): void {
      const approval = scope.getStore()
      if (!approval || approval.taskId !== record.task_id || spec.taskId !== record.task_id || approval.footprint !== footprint(spec)) throw Error("Guarded recovery has no fresh approval for this exact rebuilt spec")
      approval.authority.assertAdmission()
      bySpec.set(spec, approval)
    },
    forSpec(spec: ManagedStartSpec): FreshRecoveryApproval | undefined { return bySpec.get(spec) },
  }
}
