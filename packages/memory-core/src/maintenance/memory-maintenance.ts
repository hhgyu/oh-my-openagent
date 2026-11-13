// Background memory repo maintenance, moved here from omo-senpi `components/memory/memory-maintenance.ts`
// so every host packs the repo the same way. The scheduler is generic over the host's identity context:
// it reads only `identity` and the repo, locks, runtime and transcripts paths.

import { join } from "node:path"

import { GitMemoryRepo } from "../git/repo"
import { sweepEmptyTranscriptJournals } from "../journal"
import { LockContentionError, createLockRecord, memoryMaintenanceLockPath, withLock } from "../locks"
import { existsSync, mkdir } from "../fs/resilient"
import type { MemoryIdentityPaths } from "../identity/layout"
import { readHostSweepState } from "../reflection/host-sweep"
import { RETENTION_STAMP_CONFIG_KEY, retentionCursorPath } from "../retention"
import { readMaintenanceJson, writeMaintenanceJsonAtomic } from "./stamp-file"

/** The identity slice the scheduler reads; a host passes its own richer context. */
export interface MemoryMaintenanceContext {
  readonly identity: string
  readonly identityPaths: Pick<MemoryIdentityPaths, "repo" | "locks" | "runtime" | "transcripts">
}

/** Logger surface the scheduler needs. */
export interface MemoryMaintenanceLogger {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
}

export interface MemoryMaintenanceOptions<C extends MemoryMaintenanceContext = MemoryMaintenanceContext> {
  readonly logger?: MemoryMaintenanceLogger
  /** Prefix of every log message (`<prefix> repo packed`); defaults to `memory`. */
  readonly logPrefix?: string
  readonly createRepo?: (context: C) => GitMemoryRepo
  /** Wait after a session binds, so maintenance never competes with startup or the first prompt. */
  readonly delayMs?: number
  /** At most one run per identity in this interval, across every session and process. */
  readonly intervalMs?: number
  readonly minLooseObjects?: number
  readonly timeoutMs?: number
  readonly now?: () => number
  readonly isLiveSession?: (sessionId: string) => boolean
  /**
   * Runtime retention (#10144) inside the same gate, after the pack. Undefined disables it; the host
   * supplies the pass (it resolves the identity's `memory.runtime` windows and cap and may load the pass lazily).
   */
  readonly retention?: MemoryMaintenanceRetention<C>
  /**
   * Driver 2 of the host sweep (design 6b): undefined, or a call returning undefined, disables it (CI, task
   * children, print runs); otherwise it names the memory root to sweep and runs one bounded slice of it.
   */
  readonly hostSweep?: (context: C) => MemoryMaintenanceHostSweep | undefined
}

export interface MemoryMaintenanceRetention<C extends MemoryMaintenanceContext = MemoryMaintenanceContext> {
  /** True when an interrupted pass left work to resume (memory-core retentionResumePending); a rejection counts as due. */
  readonly resumePending: (runtimeDir: string) => Promise<boolean>
  /** One identity's retention pass; it writes the completion stamp (`omo.retentionAt`) after the work. */
  readonly run: (context: C, repo: GitMemoryRepo, signal: AbortSignal) => Promise<void>
}

export interface MemoryMaintenanceHostSweep {
  /** The memory root whose foreign identities the sweep visits. */
  readonly memoryRoot: string
  readonly run: (input: {
    readonly isHostedIdentity: (identity: string) => boolean
    readonly signal: AbortSignal
    readonly now: () => number
  }) => Promise<void>
}

export interface MemoryMaintenance<C extends MemoryMaintenanceContext = MemoryMaintenanceContext> {
  /** Schedules one background pass for this identity; repeated calls in this process are no-ops. */
  schedule(context: C): void
  /**
   * Cancels passes not yet started and stops a running one (session exit). The scheduler stays usable:
   * a shared host keeps serving other sessions, and the next session to bind schedules a fresh pass.
   */
  dispose(): void
  /** Resolves once every scheduled pass has run (or failed, or been disposed). */
  settled(): Promise<void>
}

const LEGACY_STAMP_KEY = "omo.maintenanceAt"
const STAMP_FILENAME = "maintenance.json"
const DEFAULT_DELAY_MS = 30_000
const DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000
// git's own gc.auto default is 6,700; packing earlier keeps history walks fast on slower disks.
const DEFAULT_MIN_LOOSE_OBJECTS = 2_000
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const HOST_SWEEP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

async function readRuntimeAttemptedAt(path: string): Promise<number> {
  let value: unknown
  try {
    value = await readMaintenanceJson(path)
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")
    ) {
      return Number.NaN
    }
    throw error
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return Number.NaN
  const stamp = value as { version?: unknown; attemptedAt?: unknown }
  return stamp.version === 1 && typeof stamp.attemptedAt === "number" && Number.isFinite(stamp.attemptedAt)
    ? stamp.attemptedAt
    : Number.NaN
}

/**
 * Keeps the memory repo packed off the hot path (#9667). Commits set `gc.auto=0` so no commit waits on
 * a repack; this background pass is what packs the loose objects instead.
 *
 * - One runner per identity across every session and process: the pass holds the identity's
 *   `memory-maintenance` lock and a session that finds it held skips (it never waits). This lock, not
 *   git, is what keeps two passes apart.
 * - At most once per interval: the attempt stamp lives in identity runtime storage under that lock.
 *   Legacy Git stamps are read only: writing Git config would invalidate active reflection snapshots.
 * - Safe with concurrent commits: `GitMemoryRepo.maintain()` only packs and then deletes loose copies of
 *   objects a pack already holds (`prune-packed`); it never prunes unreachable objects, so an object a
 *   writer has just created is never removed.
 * - Off the hot path: it starts after a delay, the timer never keeps a process alive, `dispose()` (session
 *   exit) cancels it and stops a running git, and every failure is logged, never raised.
 * - Runtime retention (#10144) runs inside the same gate, after the pack, when the host supplies it: one
 *   pass per identity per interval removes folded reflection runs, idle journals, sidecars and legacy stores
 *   past their `memory.runtime` windows; the size cap then evicts oldest-first down to `max_bytes`. An
 *   interrupted pass resumes at the next bind; a failure is logged like any other failure of that step.
 * - Empty transcript journals left by older builds (#9737) are swept once per identity per process, at
 *   once rather than behind the delay: control sessions exit within seconds and dispose() would cancel it.
 */
export function createMemoryMaintenance<C extends MemoryMaintenanceContext = MemoryMaintenanceContext>(
  options: MemoryMaintenanceOptions<C> = {},
): MemoryMaintenance<C> {
  const createRepo =
    options.createRepo ??
    ((context: C) => new GitMemoryRepo({ dir: context.identityPaths.repo, agentId: context.identity }))
  const prefix = options.logPrefix ?? "memory"
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS
  const minLooseObjects = options.minLooseObjects ?? DEFAULT_MIN_LOOSE_OBJECTS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? Date.now
  let abort = new AbortController()
  const scheduled = new Set<string>()
  const swept = new Set<string>()
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>()
  const running = new Set<Promise<void>>()

  async function sweepJournals(context: C): Promise<void> {
    const result = await sweepEmptyTranscriptJournals({
      transcriptsDir: context.identityPaths.transcripts,
      now,
      ...(options.isLiveSession === undefined ? {} : { isLive: options.isLiveSession }),
    })
    if (result.removed.length > 0) {
      options.logger?.info(`${prefix} removed empty transcript journals`, {
        identity: context.identity,
        removed: result.removed.length,
        reason: "no messages, no reflection state, idle 10+ minutes",
        kept: result.kept,
      })
    }
  }

  /**
   * Due when no completed pass is stamped within the interval, or an interrupted pass left work to resume;
   * a cap resume point whose pass could not even measure waits for the interval (#12538 review r5 L1).
   */
  async function retentionDue(
    retention: MemoryMaintenanceRetention<C>,
    context: C,
    repo: GitMemoryRepo,
  ): Promise<boolean> {
    if (existsSync(retentionCursorPath(context.identityPaths.runtime))) {
      // A failed check counts as due, so the pass runs and logs that failure.
      const resumePending = await retention.resumePending(context.identityPaths.runtime).catch(() => true)
      if (resumePending) return true
    }
    const last = Number((await repo.configGet(RETENTION_STAMP_CONFIG_KEY)) ?? Number.NaN)
    return !(Number.isFinite(last) && now() - last < intervalMs)
  }

  async function retain(
    retention: MemoryMaintenanceRetention<C>,
    context: C,
    repo: GitMemoryRepo,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await retention.run(context, repo, signal)
    } catch (error) {
      if (signal.aborted) throw error
      options.logger?.warn(`${prefix} runtime retention failed`, {
        identity: context.identity,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Every identity a session in this process bound (REVIEW-5 M2). The host sweep skips them: their own
  // pass ran with live sessions, owned sidecars and the project layer, which a foreign visit lacks.
  // Kept after a session exits, which only ever keeps more.
  const hosted = new Set<string>()

  /** One bounded slice of the host-wide sweep, after this identity's own pass, when the round is due. */
  async function sweepHost(context: C, signal: AbortSignal): Promise<void> {
    const host = options.hostSweep?.(context)
    if (host === undefined) return
    const state = await readHostSweepState(host.memoryRoot)
    const completedAt = state.completedAt === undefined ? Number.NaN : Date.parse(state.completedAt)
    if (state.cursor === undefined && Number.isFinite(completedAt) && now() - completedAt < HOST_SWEEP_INTERVAL_MS)
      return
    signal.throwIfAborted()
    await host.run({ isHostedIdentity: (name) => hosted.has(name), signal, now })
  }

  async function run(context: C, signal: AbortSignal): Promise<void> {
    // A transient identity has no repo until it is promoted.
    if (!existsSync(context.identityPaths.repo)) return
    const record = await createLockRecord("memory-maintenance", { runId: `maintenance-${process.pid}` })
    try {
      await withLock(
        memoryMaintenanceLockPath(context.identityPaths.locks),
        record,
        async () => {
          signal.throwIfAborted()
          const repo = createRepo(context)
          const stampPath = join(context.identityPaths.runtime, STAMP_FILENAME)
          const runtimeAt = await readRuntimeAttemptedAt(stampPath)
          const legacyAt = Number((await repo.configGet(LEGACY_STAMP_KEY)) ?? Number.NaN)
          const last = Math.max(...[runtimeAt, legacyAt].filter(Number.isFinite))
          if (!(Number.isFinite(last) && now() - last < intervalMs)) {
            await mkdir(context.identityPaths.runtime, { recursive: true, mode: 0o700 })
            await writeMaintenanceJsonAtomic(stampPath, { version: 1, attemptedAt: now() })
            const result = await repo.maintain({ minLooseObjects, timeoutMs, signal })
            if (result.status === "packed") {
              options.logger?.info(`${prefix} repo packed`, {
                identity: context.identity,
                looseObjectsBefore: result.looseObjectsBefore,
                looseObjectsAfter: result.looseObjectsAfter,
              })
            }
          }
          const retention = options.retention
          if (retention !== undefined && (await retentionDue(retention, context, repo))) {
            await retain(retention, context, repo, signal)
          }
          await sweepHost(context, signal).catch((error: unknown) => {
            if (signal.aborted) throw error
            options.logger?.warn(`${prefix} host sweep failed`, {
              error: error instanceof Error ? error.message : String(error),
            })
          })
        },
        { waitTimeoutMs: 0 },
      )
    } catch (error) {
      // Another session or process holds the pass: it is that runner's job, not a failure.
      if (error instanceof LockContentionError) return
      throw error
    }
  }

  return {
    schedule(context): void {
      hosted.add(context.identity)
      if (scheduled.has(context.identity)) return
      scheduled.add(context.identity)
      if (!swept.has(context.identity)) {
        swept.add(context.identity)
        const sweep: Promise<void> = sweepJournals(context)
          .catch((error: unknown) => {
            options.logger?.warn(`${prefix} empty transcript sweep failed`, {
              identity: context.identity,
              error: error instanceof Error ? error.message : String(error),
            })
          })
          .finally(() => running.delete(sweep))
        running.add(sweep)
      }
      let finish = (): void => {}
      const pass = new Promise<void>((resolve) => {
        finish = resolve
      }).finally(() => running.delete(pass))
      running.add(pass)
      const timer = setTimeout(() => {
        timers.delete(timer)
        const signal = abort.signal
        void run(context, signal)
          .catch((error: unknown) => {
            if (signal.aborted) return
            options.logger?.warn(`${prefix} repo maintenance failed`, {
              identity: context.identity,
              error: error instanceof Error ? error.message : String(error),
            })
          })
          .finally(finish)
      }, delayMs)
      // A short-lived process (a print run, a test) exits without waiting for it.
      timer.unref?.()
      timers.set(timer, finish)
    },
    dispose(): void {
      abort.abort()
      abort = new AbortController()
      for (const [timer, finish] of timers) {
        clearTimeout(timer)
        finish()
      }
      timers.clear()
      scheduled.clear()
    },
    async settled(): Promise<void> {
      await Promise.all([...running])
    },
  }
}
