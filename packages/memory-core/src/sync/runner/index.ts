// The host-neutral memory sync runner shared with explicit host adapters: the per-repo engine
// refcount, the device-session resolver, the device account types a host source answers with, and
// the `omo.memory.sync.*` RPC coordinator. Types only from the engine: a host injects the lazily
// loaded engine sidecar, so the Loro runtime never reaches its eager bundle through this barrel.
export {
  createSyncRunner,
  SYNC_CONFIG_INVALID,
  SYNC_IDLE_NO_DEVICE_SESSION,
  SYNC_IDLE_NOT_JOINED,
  SYNC_UNAVAILABLE,
  SyncSidecarUnavailableError,
} from "./sync-runner"
export type {
  DeviceSyncSession,
  SyncConfigInvalidStatus,
  SyncRunner,
  SyncRunnerOptions,
  SyncSessionRequest,
  SyncSessionResolution,
  SyncSessionResolver,
  SyncSpaceInputs,
  SyncUnavailableStatus,
} from "./sync-runner"
export type { SyncRunnerLogger, SyncRuntime } from "./sync-runner-ports"
export { SyncConfigError } from "./sync-config-error"
export { SyncSessionDeferredError } from "./sync-session-deferred"
export { createDeviceSessionResolver } from "./device-session-resolver"
export type { DeviceSessionRuntime } from "./device-session-resolver"
export type { CliDeviceAccount, DesktopSyncUnavailable, DeviceAccount, DeviceAccountSource, KeyringFactory } from "./device-account"
export type { MemoryRpcSync } from "./memory-rpc-sync"
export { registerSyncRpc } from "./sync-rpc-registration"
export type {
  SyncRpcAccount,
  SyncRpcAuthority,
  SyncRpcClaim,
  SyncRpcClaims,
  SyncRpcContext,
  SyncRpcIdentity,
  SyncRpcOptions,
  SyncRpcRegistration,
  SyncRpcRuntime,
} from "./sync-rpc-ports"
export type {
  ApprovalProgress,
  JoinProgress,
  PendingDeviceApproval,
  SyncApproveRequest,
  SyncApproveResponse,
  SyncDevicesResponse,
  SyncEnableResponse,
  SyncPendingResponse,
  SyncRpcProblem,
  SyncRpcDisabled,
  SyncStatusResponse,
} from "./sync-rpc-contract"
