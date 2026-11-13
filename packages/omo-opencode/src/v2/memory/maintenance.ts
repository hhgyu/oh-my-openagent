// Background memory repo maintenance for OpenCode 2 (plan S7b): the memory-core scheduler Senpi runs at
// `session_start`, scheduled here when a root session binds and disposed when the component closes. Its
// timer is unref'd and starts after `delayMs` (30s by default), so it never competes with the first prompt
// and never keeps the host alive; one pass per identity per 12 hours across every process, under the
// identity's `memory-maintenance` lock. The empty-journal sweep runs at once on the first bind.
// Inside the pass, the memory-core runtime retention and size cap run with the bound session's
// `memory.runtime` settings, then one slice of the host sweep over identities this process does not host
// (global settings only; off under CI). The transient-run reclaim (Senpi `transient-sweep-once.ts`) is
// claimed once per memory root per day per process and starts after the bind, never inside it.

import { homedir } from "node:os"
import { dirname } from "node:path"
import {
  resolveRuntimeReflectionEnabled,
  retentionResumePending,
  runMaintenanceHostSweep,
  runMaintenanceRetention,
  type MemoryIdentityPaths,
} from "@oh-my-opencode/memory-core"
import {
  createMemoryMaintenance,
  type MemoryMaintenance,
  type MemoryMaintenanceContext,
  type MemoryMaintenanceOptions,
} from "@oh-my-opencode/memory-core/maintenance"
import { encodeKibitzerSessionId } from "@oh-my-opencode/memory-core/recall-sidecar"
import {
  scheduleTransientSweepOnce,
  sweepTransientMemoryRuns,
  type TransientSweepSchedule,
} from "@oh-my-opencode/memory-core/transient"
import type { OmoMemorySettings } from "@oh-my-opencode/omo-config-core"
import { describeError, type BoundMemorySession } from "./binding"
import type { MemoryEnv, MemoryLogger } from "./config"

const LOG_PREFIX = "memory"

/** Test seams over the scheduler's timing and packing thresholds. */
export type MemoryMaintenanceSeams = Pick<
  MemoryMaintenanceOptions,
  "delayMs" | "intervalMs" | "minLooseObjects" | "timeoutMs" | "now" | "createRepo"
> & {
  /** Delay before the once-per-day transient-run reclaim starts (1 s by default). */
  readonly transientSweepDeferMs?: number
}

export interface V2MemoryMaintenanceHost {
  /** Memory settings for a directory; the host sweep reads them at `$HOME`, where only the user layer applies. */
  readonly loadSettings: (cwd: string) => OmoMemorySettings
  readonly home: string | undefined
  readonly env: MemoryEnv
}

export interface V2MemoryMaintenance {
  /** Schedules this identity's pass (a no-op once scheduled in this component instance). */
  onBound(bound: BoundMemorySession): void
  /** Cancels a pending pass, stops a running git, then waits for the scheduler to settle. */
  close(): Promise<void>
}

interface V2MaintenanceContext extends MemoryMaintenanceContext {
  readonly identityPaths: MemoryIdentityPaths
  readonly settings: OmoMemorySettings
}

/** `<memory root>` of an identity: its root is `<memory root>/agents/<id>`. */
function memoryRootOf(identityRoot: string): string {
  return dirname(dirname(identityRoot))
}

export function createV2MemoryMaintenance(
  logger: MemoryLogger,
  host: V2MemoryMaintenanceHost,
  seams: MemoryMaintenanceSeams = {},
): V2MemoryMaintenance {
  const { transientSweepDeferMs, ...schedulerSeams } = seams
  // Sessions this component bound: the empty-journal sweep and retention never remove a live session's journal.
  const bound = new Set<string>()
  const now = schedulerSeams.now ?? Date.now
  const info = (message: string, data?: Record<string, unknown>): void => {
    logger.info?.(message, data)
  }
  const warn = (message: string, data?: Record<string, unknown>): void => {
    logger.warn(message, data)
  }
  const maintenance: MemoryMaintenance<V2MaintenanceContext> = createMemoryMaintenance<V2MaintenanceContext>({
    ...schedulerSeams,
    isLiveSession: (sessionID) => bound.has(sessionID),
    logPrefix: LOG_PREFIX,
    logger: { info, warn },
    retention: {
      resumePending: (runtimeDir) => retentionResumePending(runtimeDir),
      run: async (context, repo, signal) => {
        await runMaintenanceRetention({
          identity: context.identity,
          paths: context.identityPaths,
          repo,
          signal,
          now,
          settings: context.settings,
          reflectionEnabled: resolveRuntimeReflectionEnabled(context.settings, context.identity),
          isLiveSession: (sessionID) => bound.has(sessionID),
          ownedSidecars: new Set([...bound].map(encodeKibitzerSessionId)),
          logPrefix: LOG_PREFIX,
          info,
          warn,
        })
      },
    },
    hostSweep: (context) => {
      if (host.env.CI !== undefined) return undefined
      const memoryRoot = memoryRootOf(context.identityPaths.root)
      return {
        memoryRoot,
        run: async ({ isHostedIdentity, signal, now: clock }) => {
          await runMaintenanceHostSweep({
            memoryRoot,
            settings: host.loadSettings(host.home ?? homedir()),
            isHostedIdentity,
            signal,
            now: clock,
            logPrefix: LOG_PREFIX,
            info,
          })
        },
      }
    },
  })
  const transientSweeps: TransientSweepSchedule[] = []
  const sweeping = new Set<Promise<void>>()
  let closed = false
  function scheduleTransientSweep(memoryRoot: string): void {
    const schedule = scheduleTransientSweepOnce({
      memoryRoot,
      ...(transientSweepDeferMs === undefined ? {} : { deferMs: transientSweepDeferMs }),
      start: () => {
        if (closed) return
        const sweep: Promise<void> = sweepTransientMemoryRuns({ memoryRoot, logPrefix: LOG_PREFIX, warn })
          .then((result) => {
            if (result.removedRuns + result.removedIdentities + result.promoted > 0)
              info(`${LOG_PREFIX} transient runs reclaimed`, { memoryRoot, ...result })
          })
          .catch((error: unknown) => {
            warn(`${LOG_PREFIX} transient sweep failed`, { error: describeError(error) })
          })
          .finally(() => sweeping.delete(sweep))
        sweeping.add(sweep)
      },
    })
    if (schedule !== undefined) transientSweeps.push(schedule)
  }
  return {
    onBound(session) {
      bound.add(session.sessionID)
      maintenance.schedule({ identity: session.identity, identityPaths: session.paths, settings: session.settings })
      scheduleTransientSweep(memoryRootOf(session.paths.root))
    },
    async close() {
      closed = true
      bound.clear()
      for (const schedule of transientSweeps.splice(0)) schedule.cancel()
      maintenance.dispose()
      await Promise.allSettled([maintenance.settled(), ...sweeping])
    },
  }
}
