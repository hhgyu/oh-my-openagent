import {
  createDagRecovery,
  type DagFileStore,
  type DagLeasePort,
  type DagRunId,
  type DagRunRecordV1,
  type InstalledDagRun,
} from "@oh-my-opencode/senpi-task/dag"
import type { NativeDagEntered, NativeDagSchedulerOptions } from "./drive"
import { NativeDagRefusal } from "./refusals"
import { createHeldDagTaskPort, type NativeDagCallPort } from "./task-port"
import { TERMINAL_TASK_STATUSES } from "./wake-projection"

/** The DAG store as Native recovery sees it for ONE run: every other run's checkpoint reads as
 * absent, so `installPausedRuns` / `pauseRunsForShutdown` (which visit a whole session) act on the
 * run THIS call names and nothing else. Writes, locks and events are the real store's. */
function runScopedStore(store: DagFileStore, runId: DagRunId): DagFileStore {
  return {
    ...store,
    readCheckpoint: <T extends object>(id: DagRunId): T | null => (id === runId ? store.readCheckpoint<T>(id) : null),
  }
}

/** Native shutdown pause (`recovery.ts` `pauseRunsForShutdown`) of every live run of `parent`:
 * `dag.run.paused` (`session_shutdown`) journaled, the lease moved to `previousLeaseHolderPid`, no
 * child cancelled. Needs no task authority, so the recovery's port is an unbound held port. */
export function pauseRunsForShutdown(store: DagFileStore, parent: string, lease: DagLeasePort): readonly DagRunId[] {
  return createDagRecovery({
    store,
    lease,
    taskManager: createHeldDagTaskPort(`shutdown:${parent}` as DagRunId).port,
  }).pauseRunsForShutdown(parent)
}

/** Whether THIS host backs a node's child, decided WITHOUT capturing it (D-1): a child its previous
 * runtime parked, or a dead host stranded, is a stored row this runtime does not own, and the call's
 * `get` refuses such a row by design. The row is read through the owned lookup instead (the newest
 * owner of the node is authoritative, like Native reconcile), and a live child with no resident
 * handle is first restored through Native task's restore path under the call's own fresh approval.
 * A settled child counts as backed only when this runtime owns it (its settle is then folded by
 * the call's scheduler); a settled child this runtime does not own (a hard kill stranded it) is
 * never restored and is left to Native recovery, which folds it from the owned lookup. */
async function hostsChild(
  call: NativeDagCallPort,
  runId: DagRunId,
  node: DagRunRecordV1["nodes"][number],
): Promise<boolean> {
  const child = call.findOwnedTask({ kind: "dag", runId, nodeId: node.id })
  if (child === undefined) return false
  if (TERMINAL_TASK_STATUSES.has(child.status)) return call.isOwned(child.task_id)
  if (call.getResidentHandle(child.task_id) !== undefined) return true
  await call.restoreAfterReload(child.task_id)
  return call.getResidentHandle(child.task_id) !== undefined
}

/** Restores, inside the call, every admitted node child a reload parked (or a dead host stranded),
 * and reports whether every admitted node still has a child THIS host backs. Runs before anything
 * reads or attaches a child through the call's capturing port. */
export async function restoreRunChildren(record: DagRunRecordV1, call: NativeDagCallPort): Promise<boolean> {
  let backed = true
  for (const node of record.nodes) {
    if (node.state !== "scheduled" && node.state !== "running") continue
    if (!(await hostsChild(call, record.runId, node))) backed = false
  }
  return backed
}

/** Restores, inside the call, every admitted node child a reload parked, and reports whether the run
 * needs Native recovery before a scheduler can drive it: it is paused (a reload paused it), or a node
 * has no task to attach (its admission was cut off, P-27) or a child no host backs. */
export async function prepareRunRecovery(record: DagRunRecordV1, call: NativeDagCallPort): Promise<boolean> {
  const backed = await restoreRunChildren(record, call)
  return record.status === "paused" || !backed
}

/** Native recovery of ONE run inside the call that names it (lazy resume): a run still running
 * is first paused like a shutdown, then Native `installPausedRuns` claims it under this generation's
 * lease, reconciles every node (reuses results, re-admits a scheduled node that never started, fails
 * a node whose task is gone or no host backs, attaches children that survived), journals
 * `dag.run.resumed` and installs a scheduler whose every node start goes through THIS call's held
 * port. The call drives that scheduler; when the call ends it is retired like any other drive. */
export async function recoverDagRun(input: {
  readonly store: DagFileStore
  readonly record: DagRunRecordV1
  readonly lease: DagLeasePort
  readonly options: NativeDagSchedulerOptions
}): Promise<NativeDagEntered> {
  const { record, lease, options } = input
  if (record.pause?.reason === "user_stop")
    throw new NativeDagRefusal(
      "run_paused_by_user",
      `Dag run ${record.runId} was stopped by the user; only the user's Resume restarts it.`,
    )
  const store = runScopedStore(input.store, record.runId)
  const recovery = createDagRecovery({
    store,
    lease,
    taskManager: options.taskManager,
    ancestry: { depth: 0 },
    ...(options.nodeSpawnPolicy && { nodeSpawnPolicy: options.nodeSpawnPolicy }),
  })
  if (record.status !== "paused") recovery.pauseRunsForShutdown(record.parentSessionId)
  const adopted: InstalledDagRun[] = []
  const outcomes = await recovery.installPausedRuns(record.parentSessionId, (run) => {
    adopted.push(run)
  })
  const installed = adopted[0]
  if (installed === undefined) {
    const held = outcomes.find((outcome) => outcome.reason === "live_lease")
    throw new NativeDagRefusal(
      "run_still_active",
      held
        ? `Dag run ${record.runId} is held by another live OpenCode 2 plugin generation (lease ${held.holderPid ?? "unknown"}); call workflow again once it has shut down.`
        : `Dag run ${record.runId} could not be recovered: it is no longer paused by a reload.`,
    )
  }
  const { scheduler, settled } = installed
  return { scheduler, run: settled.then((outcome) => outcome.record ?? scheduler.snapshot()) }
}
