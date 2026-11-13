// Background memory repo maintenance for OpenCode 2 (plan S7b): the memory-core scheduler Senpi runs at
// `session_start`, scheduled here when a root session binds and disposed when the component closes. Its
// timer is unref'd and starts after `delayMs` (30s by default), so it never competes with the first prompt
// and never keeps the host alive; one pass per identity per 12 hours across every process, under the
// identity's `memory-maintenance` lock. The empty-journal sweep runs at once on the first bind.

import {
  createMemoryMaintenance,
  type MemoryMaintenance,
  type MemoryMaintenanceContext,
  type MemoryMaintenanceOptions,
} from "@oh-my-opencode/memory-core/maintenance"
import type { BoundMemorySession } from "./binding"
import type { MemoryLogger } from "./config"

/** Test seams over the scheduler's timing and packing thresholds. */
export type MemoryMaintenanceSeams = Pick<
  MemoryMaintenanceOptions,
  "delayMs" | "intervalMs" | "minLooseObjects" | "timeoutMs" | "now" | "createRepo"
>

export interface V2MemoryMaintenance {
  /** Schedules this identity's pass (a no-op once scheduled in this component instance). */
  onBound(bound: BoundMemorySession): void
  /** Cancels a pending pass, stops a running git, then waits for the scheduler to settle. */
  close(): Promise<void>
}

export function createV2MemoryMaintenance(
  logger: MemoryLogger,
  seams: MemoryMaintenanceSeams = {},
): V2MemoryMaintenance {
  // Sessions this component bound: the empty-journal sweep never removes a live session's journal.
  const bound = new Set<string>()
  const maintenance: MemoryMaintenance = createMemoryMaintenance<MemoryMaintenanceContext>({
    ...seams,
    isLiveSession: (sessionID) => bound.has(sessionID),
    logPrefix: "memory",
    logger: {
      info: (message, data) => {
        logger.info?.(message, data)
      },
      warn: (message, data) => {
        logger.warn(message, data)
      },
    },
  })
  return {
    onBound(session) {
      bound.add(session.sessionID)
      maintenance.schedule({ identity: session.identity, identityPaths: session.paths })
    },
    async close() {
      bound.clear()
      maintenance.dispose()
      await maintenance.settled()
    },
  }
}
