// Reflection crash recovery at bind and after each settled turn (plan S7f, correction 4; #11976, #11920).
// OpenCode 2 has no `session_shutdown`, and the reflection child is an in-process session that dies with
// its host, so a host killed mid-run leaves:
// - an open custody row under `REFLECTION_BACKEND_ID` in `reflectionChildJournalPath(bound)` and the hidden
//   child session in the host's table: reclaimed at bind by the shared memory child reclaim, exactly as
//   facts children are (dead-owner takeover, generation raised to the stored floor, bounded retry memo);
// - a held `active.lock`: decided by memory-core's one stale reflection-lock reaper (`runStaleLockReaper`,
//   the table Senpi's session and `omo doctor --fix` share). The reaper moves an old torn lock aside by
//   itself; every other provably gone holder is settled here, re-decided under the run's finalize lock:
//   `launch-interrupted` (the launcher on THIS host is gone, the 60 s launch window closed and no Senpi
//   `ledger.json` exists) discards the `prelaunch.json` worktree (stop if it cannot be removed), writes
//   `abandoned.json`, then `store.complete(runId, "failed")`; `release-settled` and `terminal-recorded`
//   (a sentinel already written, only the release missing) only release. A live holder, a young launch
//   and Senpi-ledger runs (`finalize`, `processes-dead`, `ledger-unreadable`, which Senpi's detached
//   supervisor reconciles) are never touched; anything not settled is reported once per session and run.
// Bind reconciles every time (`settleAlways`); a settled turn settles a given run at most once per session,
// so a holder that died after this session bound is reclaimed on its next settled turn.

import {
  createLockRecord,
  decideStaleReflectionLock,
  discardReflectionWorktree,
  GitMemoryRepo,
  LockContentionError,
  runFinalizationLockPath,
  runStaleLockReaper,
  withLock,
  type ReservedRun,
  type StaleLockDecision,
  type StaleLockProbe,
  type StaleLockReapAction,
} from "@oh-my-opencode/memory-core"
import type { Context } from "@opencode/plugin/promise/plugin"
import { join } from "node:path"
import type { probeJournalOwner } from "../host/child-journal"
import type { SessionBackendApi } from "../host/session-backend"
import { hasJoinedSessionCancellation } from "../host/session-cancellation"
import { describeError, type BoundMemorySession } from "./binding"
import { reclaimStrandedMemoryChildren } from "./memory-child-reclaim"
import { REFLECTION_BACKEND_ID, reflectionChildJournalPath } from "./reflection-child"
import { readPrelaunch, reflectionStore, writeRunTerminal, type ReflectionStoreSeams } from "./reflection-run-store"
import { REFLECTION_TOOL_NAMES } from "./reflection-tools"

interface ReflectionRecoveryDeps extends ReflectionStoreSeams {
  readonly host: { readonly app?: Context["app"]; readonly session: object }
  readonly warn: (message: string, details?: Record<string, unknown>) => void
  /** Liveness, host, clock and file probes (memory-core `StaleLockProbe`); production reads the OS. */
  readonly probe?: StaleLockProbe
  readonly probeOwner?: typeof probeJournalOwner
  /** Runs a reservation the release promoted to active; this process is its launcher now. */
  readonly runPromoted?: (bound: BoundMemorySession, run: ReservedRun) => Promise<unknown>
}

type ReflectionLockRecovery = "none" | "live" | "released" | "reported"

type Settled =
  | { readonly kind: "none" }
  | { readonly kind: "released"; readonly launch?: ReservedRun }
  | { readonly kind: "kept"; readonly runId: string; readonly reason: string }

const V2_SETTLES: ReadonlySet<StaleLockReapAction> = new Set([
  "launch-interrupted",
  "release-settled",
  "terminal-recorded",
])

function isBackendSession(session: object): session is SessionBackendApi {
  return hasJoinedSessionCancellation(session)
}

function keptReason(decision: Exclude<StaleLockDecision, { kind: "none" }>): string {
  if (decision.kind === "stuck") return decision.reason
  if (decision.kind === "finalize") return "it recorded a Senpi outcome that Senpi's reconciliation finalizes"
  return `${decision.reason}; its Senpi run is reconciled by Senpi`
}

export function createReflectionRecovery(deps: ReflectionRecoveryDeps) {
  const now = deps.now
  const probe: StaleLockProbe = {
    ...(now === undefined ? {} : { now: () => now().getTime() }),
    ...deps.probe,
  }
  const reported = new Set<string>()
  const attempted = new Set<string>()

  async function reclaimChildren(bound: BoundMemorySession): Promise<void> {
    const app = deps.host.app
    const session = deps.host.session
    if (app === undefined || !isBackendSession(session)) return
    await reclaimStrandedMemoryChildren(
      {
        host: { app, session },
        journalPath: reflectionChildJournalPath(bound),
        warn: deps.warn,
        ...(deps.probeOwner === undefined ? {} : { probeOwner: deps.probeOwner }),
      },
      { backendID: REFLECTION_BACKEND_ID, toolNames: REFLECTION_TOOL_NAMES, label: "reflection" },
    )
  }

  async function underFinalizeLock(
    bound: BoundMemorySession,
    runId: string,
    task: () => Promise<Settled>,
  ): Promise<Settled> {
    try {
      return await withLock(
        runFinalizationLockPath(bound.paths.locks, runId),
        await createLockRecord("reflection-finalize", { runId }),
        task,
        { waitTimeoutMs: 0 },
      )
    } catch (error) {
      if (error instanceof LockContentionError)
        return { kind: "kept", runId, reason: "another session is finalizing it" }
      throw error
    }
  }

  async function settle(bound: BoundMemorySession): Promise<Settled> {
    const { decision } = await decideStaleReflectionLock(bound.paths.reflection, probe)
    if (decision.kind === "none") return { kind: "none" }
    if (decision.kind !== "reap" || !V2_SETTLES.has(decision.action))
      return { kind: "kept", runId: decision.runId, reason: keptReason(decision) }
    const { runId, action } = decision
    const settled = await underFinalizeLock(bound, runId, async () => {
      const again = (await decideStaleReflectionLock(bound.paths.reflection, probe)).decision
      if (again.kind !== "reap" || again.action !== action || again.runId !== runId)
        return { kind: "kept", runId, reason: "its state changed while it was being settled" }
      const store = reflectionStore(bound, deps)
      const active = (await store.readState()).active
      if (active?.runId !== runId) return { kind: "kept", runId, reason: "the reservation changed" }
      if (action === "launch-interrupted") {
        const prelaunch = await readPrelaunch(bound, runId)
        if (prelaunch !== undefined) {
          const repo = new GitMemoryRepo({ dir: bound.paths.repo, agentId: bound.identity })
          const cleanup = await discardReflectionWorktree(repo, prelaunch.worktreeDir, prelaunch.worktreeBranch)
          if (!cleanup.worktreeRemoved || !cleanup.branchRemoved) {
            deps.warn("stale reflection run kept: its worktree could not be removed", { runId, ...cleanup })
            return { kind: "kept", runId, reason: "its worktree could not be removed" }
          }
        }
        await writeRunTerminal(bound, active, {
          kind: "abandoned",
          reason: "launch_interrupted",
          at: (deps.now?.() ?? new Date()).toISOString(),
        })
      }
      const completion = await store.complete(runId, "failed")
      return { kind: "released", ...(completion.launch === undefined ? {} : { launch: completion.launch }) }
    })
    if (settled.kind === "released" && settled.launch !== undefined && deps.runPromoted !== undefined) {
      void deps.runPromoted(bound, settled.launch).catch((error: unknown) => {
        deps.warn("promoted reflection run failed", { error: describeError(error) })
      })
    }
    return settled
  }

  function report(bound: BoundMemorySession, runId: string, reason: string): "reported" {
    const key = `${bound.sessionID}:${runId}`
    if (reported.has(key)) return "reported"
    reported.add(key)
    deps.warn(
      `memory reflection is held by run ${runId} and ${reason}; new reflection requests only queue. Run /doctor; if no reflection run is active, run \`omo doctor --fix\` or move ${join(bound.paths.reflection, "active.lock")} aside.`,
      { runId },
    )
    return "reported"
  }

  async function recoverLock(bound: BoundMemorySession, turn: boolean): Promise<ReflectionLockRecovery> {
    let settled: Settled | undefined
    const result = await runStaleLockReaper({
      runtimeDir: bound.paths.runtime,
      probe,
      settle: async () => {
        settled = await settle(bound)
      },
      ...(turn
        ? {
            shouldSettle: (runId: string) => {
              const key = `${bound.sessionID}:${runId}`
              if (attempted.has(key)) return false
              attempted.add(key)
              return true
            },
          }
        : { settleAlways: true }),
    })
    const { decision, after } = result
    if (result.action === "reaped" || settled?.kind === "released") return "released"
    if (settled?.kind === "kept") return report(bound, settled.runId, settled.reason)
    if (decision.kind === "none" || settled?.kind === "none") return after.state === "live" ? "live" : "none"
    if (result.action === "settle-declined")
      return report(bound, decision.runId, "recovering it this session did not release the lock")
    return report(
      bound,
      decision.runId,
      decision.kind === "reap" ? "the torn lock could not be moved aside" : keptReason(decision),
    )
  }

  async function recover(
    bound: BoundMemorySession,
    turn: boolean,
  ): Promise<{ readonly lock: ReflectionLockRecovery | "error" }> {
    try {
      return { lock: await recoverLock(bound, turn) }
    } catch (error) {
      deps.warn(`stale reflection lock recovery failed; it is retried at the next ${turn ? "settled turn" : "bind"}`, {
        error: describeError(error),
      })
      return { lock: "error" }
    }
  }

  return {
    /** Reclaims stranded children, then reconciles the reflection lock through the reaper; never throws. */
    async onBound(bound: BoundMemorySession): Promise<{ readonly lock: ReflectionLockRecovery | "error" }> {
      await reclaimChildren(bound).catch((error: unknown) => {
        deps.warn("stranded reflection children were not reclaimed", { error: describeError(error) })
      })
      return recover(bound, false)
    },
    /** Re-checks the reflection lock after a settled turn; a holder gone since bind is settled once; never throws. */
    onTurnSettled(bound: BoundMemorySession): Promise<{ readonly lock: ReflectionLockRecovery | "error" }> {
      return recover(bound, true)
    },
  }
}
