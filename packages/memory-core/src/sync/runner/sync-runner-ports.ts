// What a host injects into the sync runner: its lazily loaded engine sidecar and its log channel.

import type { openDeviceSync } from "../engine"

/** The engine sidecar a host loads lazily, so the Loro runtime stays out of its eager bundle. */
export interface SyncRuntime {
  readonly openDeviceSync: typeof openDeviceSync
}

/** The host log channel a runner writes its idle, unavailable and failure lines to. */
export interface SyncRunnerLogger {
  info(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
}
