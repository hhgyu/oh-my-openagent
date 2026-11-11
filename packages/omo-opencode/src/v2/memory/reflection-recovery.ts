// Reflection crash recovery at bind (plan S7f, correction 4). OpenCode 2 has no `session_shutdown`, and
// the reflection child is an in-process session that dies with its host, so a host killed mid-run leaves:
// - an open custody row under `REFLECTION_BACKEND_ID` in `reflectionChildJournalPath(bound)` and the hidden
//   child session in the host's table: reclaimed by the shared memory child reclaim, exactly as facts
//   children are (dead-owner takeover, generation raised to the stored floor, bounded retry memo);
// - a held `active.lock`: classified fail-closed with memory-core `classifyReflectionLockHolder`. A live
//   holder is never touched. A non-live holder is released only when the run is one a dead in-process
//   launcher owned: no Senpi `ledger.json` (Senpi's detached supervisor owns those and reconciles them
//   itself), the launcher recorded on THIS host, and its pid provably gone (or reused, by start
//   identity). That release is Senpi's pre-ledger reconcile (`run-reconciliation-prelaunch.ts`): discard
//   the `prelaunch.json` worktree (stop if it cannot be removed), write `abandoned.json`, then
//   `store.complete(runId, "failed")` with no failure signal. Anything else is reported, not reclaimed.
// Senpi's 60 s launch window is not applied: a dead in-process launcher cannot still be preparing.

import {
  classifyReflectionLockHolder, discardReflectionWorktree, getPidLiveness, getProcessStartIdentity, GitMemoryRepo, startIdentitiesComparable,
  type ReflectionLockProbe, type ReservedRun,
} from "@oh-my-opencode/memory-core"
import { existsSync } from "@oh-my-opencode/memory-core/fs"
import type { Context } from "@opencode/plugin/promise/plugin"
import { hostname as readHostname } from "node:os"
import { join } from "node:path"
import type { probeJournalOwner } from "../host/child-journal"
import type { SessionBackendApi } from "../host/session-backend"
import { hasJoinedSessionCancellation } from "../host/session-cancellation"
import { describeError, type BoundMemorySession } from "./binding"
import { reclaimStrandedMemoryChildren } from "./memory-child-reclaim"
import { REFLECTION_BACKEND_ID, reflectionChildJournalPath } from "./reflection-child"
import { readPrelaunch, reflectionRunDir, reflectionStore, writeRunTerminal, type ReflectionStoreSeams } from "./reflection-run-store"
import { REFLECTION_TOOL_NAMES } from "./reflection-tools"

interface ReflectionRecoveryDeps extends ReflectionStoreSeams {
  readonly host: { readonly app?: Context["app"]; readonly session: object }
  readonly warn: (message: string, details?: Record<string, unknown>) => void
  /** Liveness / host probes (memory-core `ReflectionLockProbe`); production reads the OS. */
  readonly probe?: ReflectionLockProbe
  readonly probeOwner?: typeof probeJournalOwner
  /** Runs a reservation the release promoted to active; this process is its launcher now. */
  readonly runPromoted?: (bound: BoundMemorySession, run: ReservedRun) => Promise<unknown>
}

type ReflectionLockRecovery = "none" | "live" | "released" | "reported"

function isBackendSession(session: object): session is SessionBackendApi {
  return hasJoinedSessionCancellation(session)
}

async function launcherDead(run: ReservedRun, probe: ReflectionLockProbe): Promise<boolean> {
  if (run.launcherPid === undefined || run.launcherHostname !== (probe.hostname ?? readHostname)()) return false
  const liveness = (probe.getPidLiveness ?? getPidLiveness)(run.launcherPid)
  if (liveness === "dead") return true
  if (liveness !== "alive" || typeof run.launcherProcessStart !== "string") return false
  const actual = await (probe.getProcessStartIdentity ?? getProcessStartIdentity)(run.launcherPid).catch(() => null)
  return actual !== null && startIdentitiesComparable(run.launcherProcessStart, actual) && actual !== run.launcherProcessStart
}

export function createReflectionRecovery(deps: ReflectionRecoveryDeps) {
  const probe = deps.probe ?? {}

  async function reclaimChildren(bound: BoundMemorySession): Promise<void> {
    const app = deps.host.app
    const session = deps.host.session
    if (app === undefined || !isBackendSession(session)) return
    await reclaimStrandedMemoryChildren({
      host: { app, session }, journalPath: reflectionChildJournalPath(bound), warn: deps.warn,
      ...(deps.probeOwner === undefined ? {} : { probeOwner: deps.probeOwner }),
    }, { backendID: REFLECTION_BACKEND_ID, toolNames: REFLECTION_TOOL_NAMES, label: "reflection" })
  }

  async function recoverLock(bound: BoundMemorySession): Promise<ReflectionLockRecovery> {
    const verdict = await classifyReflectionLockHolder(bound.paths.reflection, probe)
    if (verdict.state === "none" || verdict.state === "live") return verdict.state
    const store = reflectionStore(bound, deps)
    const active = (await store.readState()).active
    const ownedInProcess = active !== undefined && active.runId === verdict.runId
      && !existsSync(join(reflectionRunDir(bound, active.runId), "ledger.json")) && await launcherDead(active, probe)
    if (!ownedInProcess) {
      const reason = verdict.state === "stuck" ? verdict.reason : "its Senpi run is reconciled by Senpi"
      deps.warn(`memory reflection is held by run ${verdict.runId} and ${reason}; new reflection requests only queue. Run /doctor; if no reflection run is active, move ${join(bound.paths.reflection, "active.lock")} aside.`, { runId: verdict.runId })
      return "reported"
    }
    const prelaunch = await readPrelaunch(bound, active.runId)
    if (prelaunch !== undefined) {
      const repo = new GitMemoryRepo({ dir: bound.paths.repo, agentId: bound.identity })
      const cleanup = await discardReflectionWorktree(repo, prelaunch.worktreeDir, prelaunch.worktreeBranch)
      if (!cleanup.worktreeRemoved || !cleanup.branchRemoved) {
        deps.warn("stale reflection run kept: its worktree could not be removed", { runId: active.runId, ...cleanup })
        return "reported"
      }
    }
    await writeRunTerminal(bound, active, { kind: "abandoned", reason: "launch_interrupted", at: (deps.now?.() ?? new Date()).toISOString() })
    const completion = await store.complete(active.runId, "failed")
    if (completion.launch !== undefined && deps.runPromoted !== undefined) {
      void deps.runPromoted(bound, completion.launch).catch((error: unknown) => { deps.warn("promoted reflection run failed", { error: describeError(error) }) })
    }
    return "released"
  }

  return {
    /** Reclaims stranded children, then recovers a stale reflection lock; never throws. */
    async onBound(bound: BoundMemorySession): Promise<{ readonly lock: ReflectionLockRecovery | "error" }> {
      await reclaimChildren(bound).catch((error: unknown) => { deps.warn("stranded reflection children were not reclaimed", { error: describeError(error) }) })
      try {
        return { lock: await recoverLock(bound) }
      } catch (error) {
        deps.warn("stale reflection lock recovery failed; it is retried at the next bind", { error: describeError(error) })
        return { lock: "error" }
      }
    },
  }
}
