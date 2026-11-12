// The `sync` field of the memory status snapshot (Senpi `memory-rpc-sync.ts`): the runner's status of
// one repo mapped onto memory-core's `MemoryRpcSync`. A failing or frozen status exists only while the
// engine runs, so its mapping is passed in from the engine chunk (`./status-copy.ts`).

import type { EngineStatus } from "@oh-my-opencode/memory-core/sync-engine"
import type { SyncConfigInvalidStatus, SyncUnavailableStatus } from "@oh-my-opencode/memory-core/sync-runner"
import type { MemoryRpcSync } from "./ports"

export type RunnerStatus = EngineStatus | SyncUnavailableStatus | SyncConfigInvalidStatus
export type FailingStatus = Extract<EngineStatus, { readonly kind: "failing" | "frozen" }>

export async function readRpcSync(
  read: () => Promise<RunnerStatus | null>,
  failure: (status: FailingStatus) => Promise<MemoryRpcSync>,
): Promise<MemoryRpcSync | undefined> {
  const status = await read().catch(() => null)
  if (status === null) return undefined
  switch (status.kind) {
    case "never_synced":
    case "paused":
      return { state: status.kind }
    case "synced":
      return { state: "synced", lastSyncedAtISO: new Date(status.at).toISOString() }
    case "failing":
    case "frozen":
      return failure(status)
    // An unloadable sidecar or an invalid sync setting both mean this device does not sync; the runner logged why.
    case "sync-unavailable":
    case "sync-config-invalid":
      return { state: "unavailable" }
    default: {
      const unhandled: never = status
      return unhandled
    }
  }
}
