import {
  buildRespawnManagedSpec,
  type ManagedStartSpec,
  type TaskRecord,
  type TaskRecoveryRuntime,
} from "@oh-my-opencode/senpi-task/manager-kernel"
import type { createOwnedManagedRunner } from "./owned-runner"

/** Reacquires an existing host session. It NEVER relaunches the persisted prompt. */
/** verifyRecord receives the EXACT spec rebuilt once here, before beforeLaunch and the runner
 * claim, so a fresh recovery approval can bind to that object rather than to persisted names. */
export function createOwnedTaskRecovery(
  runner: Pick<ReturnType<typeof createOwnedManagedRunner>, "recover">,
  stateDir: string,
  options?: { verifyRecord(record: TaskRecord, spec: ManagedStartSpec): Promise<void> },
): TaskRecoveryRuntime {
  const inFlight = new Set<Promise<Awaited<ReturnType<TaskRecoveryRuntime["respawn"]>>>>()
  return {
    respawn(request) {
      const work = (async (): ReturnType<TaskRecoveryRuntime["respawn"]> => {
        if (request.paused)
          return {
            ok: false,
            disposition: "retryable",
            code: "run_paused",
            reason: "Host run hold/cutoff capability is unavailable",
          }
        const reference = request.record.owned_session
        if (!reference)
          return {
            ok: false,
            disposition: "unrecoverable",
            code: "session_unavailable",
            reason: "Record has no owned-session reference",
          }
        const rebuilt = buildRespawnManagedSpec(request.record, stateDir)
        if (!rebuilt.ok) return { disposition: "unrecoverable", ...rebuilt }
        await options?.verifyRecord(request.record, rebuilt.spec)
        request.beforeLaunch()
        const control = await runner.recover(rebuilt.spec, reference.journalKey)
        return { ok: true, handle: control.handle }
      })()
      inFlight.add(work)
      void work.finally(() => inFlight.delete(work)).catch(() => {})
      return work
    },
    async settleTeardowns() {
      // Stage failures already await their real cleanup before rejecting. Joining those
      // operations must not dispose healthy controls before Native resident suspension.
      await Promise.allSettled([...inFlight])
    },
  }
}
export function assertRecoverableOwnedRecord(record: TaskRecord, parentID: string) {
  if (
    !record.owned_session ||
    record.parent_session_id !== parentID ||
    record.killed ||
    record.status === "cancelled" ||
    record.status === "lost"
  )
    throw new Error("Task is not recoverable by this parent")
}

export function assertOwnedTreeRecord(record: TaskRecord, rootID: string) {
  const ref = record.owned_session
  if (
    !ref ||
    record.root_session_id !== rootID ||
    ref.parentID !== record.parent_session_id ||
    ref.sessionID !== record.child_session_id ||
    ref.runEpoch !== record.notification.run_epoch ||
    ref.residencyClaim !== record.residency_claim ||
    !Number.isSafeInteger(record.depth) ||
    record.depth < 1
  )
    throw Error("Recovery record differs from owned root tree")
}
