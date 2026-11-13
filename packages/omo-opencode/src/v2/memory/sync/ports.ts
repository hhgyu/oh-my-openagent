// The seam between the eager V2 memory component and its lazily loaded sync host. Everything here is
// type-only or dependency-free: the memory chunk imports this file, so it must never pull the sync
// runner, the account source or the Loro engine into that chunk (see `./runtime.ts`).

import type { MemoryIdentityPaths } from "@oh-my-opencode/memory-core"
import type {
  DeviceAccountSource,
  MemoryRpcSync,
  SyncRpcContext,
  SyncSpaceInputs,
} from "@oh-my-opencode/memory-core/sync-runner"
import type { BoundMemorySession } from "../binding"
import type { MemoryEnv, MemoryLogger } from "../config"

export type { MemoryRpcSync } from "@oh-my-opencode/memory-core/sync-runner"

/** The five Senpi `omo.memory.sync.*` verbs, served by memory-core's coordinator on both hosts. */
export type SyncRpcVerb = "enable" | "pending" | "approve" | "status" | "devices"

export interface SyncHostOptions {
  readonly env: MemoryEnv
  /** The component's memory root; the trust pins and the RPC claims live under it. */
  readonly memoryRoot: string
  readonly logger: MemoryLogger
  /** The component's lifetime: aborted in cleanup, it retires every pairing ceremony. */
  readonly signal: AbortSignal
  /** A repo's shown sync failure appeared, changed or cleared. */
  readonly onStatusChange: (repo: string) => void
  /** A repo's HEAD moved: a local commit or a converge that applied remote changes. */
  readonly onHeadChange: (repo: string) => void
  /** The `sync` field the `omo.memory.sync` status verb reports. */
  readonly syncStatus: () => Promise<MemoryRpcSync | undefined>
  readonly enabled?: () => boolean
  /** The signed-in device; defaults to the CLI account source over the service-auth credential store. */
  readonly source?: DeviceAccountSource
}

/** The lazily loaded half: the memory-core sync runner, the CLI account source and the RPC coordinator. */
export interface SyncHost {
  acquire(identity: string, paths: MemoryIdentityPaths, space: SyncSpaceInputs): Promise<void>
  release(repo: string): Promise<void>
  /** The repo's `sync` snapshot field; undefined while this device does not sync it. */
  rpcSync(repo: string): Promise<MemoryRpcSync | undefined>
  call(verb: SyncRpcVerb, data: unknown, owner: SyncRpcContext): Promise<unknown>
  dispose(): Promise<void>
}

export interface SyncHostModule {
  createSyncHost(options: SyncHostOptions): SyncHost
}

export interface MemorySyncSeams {
  /** Loads the sync host; production imports `./host` lazily. */
  readonly loadHost?: () => Promise<SyncHostModule>
  /** Replaces the CLI account source (tests: no OS credential store, no network). */
  readonly accountSource?: DeviceAccountSource
}

/** `memory.sync.enabled` with the bound identity's `agents.<id>.sync` override, as Senpi resolves it. */
export function syncEnabled(bound: Pick<BoundMemorySession, "settings" | "identity">): boolean {
  return bound.settings.agents[bound.identity]?.sync?.enabled ?? bound.settings.sync.enabled
}

const record = (details: unknown): Record<string, unknown> | undefined => {
  if (details === undefined) return undefined
  return typeof details === "object" && details !== null && !Array.isArray(details) ? { ...details } : { details }
}

/** The runner's three-level log channel over the V2 memory logger (errors are warnings there). */
export function runnerLogger(logger: MemoryLogger) {
  return {
    info: (message: string, details?: unknown) => logger.info?.(message, record(details)),
    warn: (message: string, details?: unknown) => logger.warn(message, record(details)),
    error: (message: string, details?: unknown) => logger.warn(message, record(details)),
  }
}
