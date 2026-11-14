/** Temporary Native-support kernel entry. This is the SAME manager, not a Core facade. */
export { createTaskManagerImplementation } from "./manager-implementation"
export type { ReattachingTaskManager, TaskManagerPlanningPreparation } from "./manager-implementation"
export type { TaskManagerImplOptions, TaskRecoveryRuntime, TaskRecoveryRequest } from "./recovery-runtime"
export type {
  TaskManagerOptions,
  TaskManager,
  ManagedRunner,
  ManagedStartSpec,
  ManagerStartSpec,
  ChildPlanner,
  ResolvedChildPlan,
} from "./types"
export type {
  ManagedChildHandle,
  ManagedChildEvent,
  ManagedChildListener,
  PreparedFollowUp,
  PreparedFollowUpResult,
} from "./child-handle"
export { ChildObservationUncertain } from "./observation-uncertain"
export { InputUncertainError } from "../runners/input-effects"
export { createTaskRecordStore } from "../store/record-store"
export type { TaskRecordStore } from "../store/types"
export type { TaskRecord, OwnedSessionIdentity, TaskRunStats } from "../state"
export { AdmissionBarrier } from "../pause/admission-barrier"
export type { HostStartAuthority, StartAdmission } from "./start-admission"
export type { ChildCreationPort } from "../pause/ports"
export { createTaskLifecycle } from "../lifecycle/create"
export { runTaskOutput } from "../tools/output/output"
export type { TaskOutputInput } from "../tools/output/output"
export type { TaskOutputToolResult } from "../tools/output/types"
export { RunnerError } from "../runners/in-process/runner-error"
export { withTaskRecordLock } from "../store/record-lock"
export type { OwnedSessionLifecyclePort, ResidencyRegistry, DestroyCause } from "../lifecycle/port"
export type { TaskLifecycle } from "../lifecycle/types"
export { buildRespawnManagedSpec } from "./manager-helpers"
export { NO_HOST_ENDPOINT } from "../lifecycle/host-session"
export { createHeldTurnSettlement, createWakeSourceLedger, sessionIsIdle } from "../runners/turn-settlement-core"
export type {
  HeldTurnSettlement,
  TurnSettlementProbe,
  TurnSettlementScheduler,
  WakeSourceLedger,
} from "../runners/turn-settlement-core"
