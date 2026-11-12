import { join } from "node:path"
import type { DeviceAccountSource } from "@oh-my-opencode/memory-core/sync-runner"
import type { MemoryRpcSync } from "./memory-rpc-sync"
import { createSyncRpcClaims } from "./sync-rpc-claims"
import { registerSyncRpc, type SyncRpcAccount, type SyncRpcRegistration } from "@oh-my-opencode/memory-core/sync-runner"

export function wireSyncRpc(options: {
  readonly rpc: SyncRpcRegistration
  readonly source: DeviceAccountSource | (() => Promise<SyncRpcAccount | null>)
  readonly memoryRoot: string
  readonly pinDir: string
  readonly signal: AbortSignal
  readonly syncStatus: () => Promise<MemoryRpcSync | undefined>
  readonly enabled?: () => boolean
}) {
  return registerSyncRpc(options.rpc, {
    source: async () => {
      const account = await options.source()
      // Legacy CLI sources cannot prove a captured generation. Only the selected source's
      // operation-capable branch may be used; there is deliberately no credential fallback.
      return account !== null && "descriptor" in account && "forOperation" in account ? account : null
    },
    runtime: {
      enableSync: async (input) => (await import("#omo-memory-sync-runtime")).enableSync(input),
      joinAccount: async (input) => (await import("#omo-memory-sync-runtime")).joinAccount(input),
      approveDevice: async (input) => (await import("#omo-memory-sync-runtime")).approveDevice(input),
    },
    claims: createSyncRpcClaims(join(options.memoryRoot, "runtime", "sync-rpc-claims")),
    pinDir: options.pinDir,
    signal: options.signal,
    syncStatus: options.syncStatus,
    enabled: options.enabled,
  })
}
