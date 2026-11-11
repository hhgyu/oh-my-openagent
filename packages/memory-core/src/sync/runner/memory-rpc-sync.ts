// The `sync` field of the `omo.memory.status` snapshot (#10637): the same failure state the TUI
// footer reads, so the desktop shows what the TUI shows. Omitted while this device does not sync the
// repository (sync off, signed out, or another process holds the engine), and when the read fails.

import type { SyncFailureKind } from "../engine"

export interface MemoryRpcSync {
  readonly state: "never_synced" | "synced" | "paused" | "failing" | "unavailable"
  readonly lastSyncedAtISO?: string
  readonly failure?: {
    readonly kind: SyncFailureKind
    readonly reason: string
    readonly action: string
    readonly sinceISO: string
    readonly attempts: number
    readonly paths?: readonly string[]
  }
}
