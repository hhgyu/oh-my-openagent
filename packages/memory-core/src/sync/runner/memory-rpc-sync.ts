// The `sync` field of the `omo.memory.status` snapshot (#10637): the same failure state the TUI
// footer reads, so the desktop shows what the TUI shows. Omitted while this device does not sync the
// repository (sync off, signed out, or another process holds the engine), and when the read fails.

import type { SyncFailureKind } from "../engine"

/** The failure kinds the desktop's status schema accepts (omo-desktop-app contracts); any other kind fails its whole status call. */
type DesktopFailureKind = Exclude<SyncFailureKind, "oversized_item">

export interface MemoryRpcSync {
  readonly state: "never_synced" | "synced" | "paused" | "failing" | "unavailable"
  readonly lastSyncedAtISO?: string
  /** For `failing`, and for `paused` while files are held out of the push too (#12284). */
  readonly failure?: {
    readonly kind: DesktopFailureKind
    readonly reason: string
    readonly action: string
    readonly sinceISO: string
    readonly attempts: number
    readonly paths?: readonly string[]
    /** A held file (#12284, shown as "unknown"): every held file, the ones shrinking will not fix, and the size limit. */
    readonly keys?: readonly string[]
    readonly stuckKeys?: readonly string[]
    readonly limitBytes?: number
  }
}
