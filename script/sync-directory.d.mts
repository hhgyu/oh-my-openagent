import type { LockRetryOptions } from "./windows-safe-replace.mjs"

export interface SyncSummary {
  written: number
  unchanged: number
  removed: number
}

export function syncDirectory(source: string, target: string, options?: LockRetryOptions): Promise<SyncSummary>
