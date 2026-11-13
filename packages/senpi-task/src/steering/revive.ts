import { log } from "@oh-my-opencode/utils"

import type { ManagedChildHandle, PreparedFollowUp } from "../manager/child-handle"
import { getLifecycleDetachedRevival } from "../lifecycle/port"
import type { TaskRecord } from "../state"
import { nextRunEpoch } from "../state"
import {
  buildRevived,
  deliveryUncertain,
  evictionRefusal,
  lazyRevivalFailure,
  messageSha256,
  uncertainDeliveryDenial,
} from "./engine-policy"
import { bestEffortRollback } from "./revival-rollback"
import { reviveRunningOnSend } from "./revive-running"
import type { ReviveReservation, SendOutcome, SteeringPort } from "./types"
import { InputUncertainError, InputConflictError } from "../runners/input-effects"

export async function reviveTerminal(
  port: SteeringPort,
  record: TaskRecord,
  handle: ManagedChildHandle,
  message: string,
  nowIso: () => string,
  beginSend: (taskId: string) => boolean,
  endSend: (taskId: string) => void,
  granted?: ReviveReservation,
): Promise<SendOutcome> {
  if (!beginSend(record.task_id)) return evictionRefusal(record.task_id)
  try {
    return await deliverRevivedTerminal(
      port,
      record,
      handle,
      message,
      nowIso,
      granted ?? port.reserveForRevive(record.task_id),
      false,
    )
  } finally {
    endSend(record.task_id)
  }
}

export async function reviveDetachedTerminalOnSend(
  port: SteeringPort,
  record: TaskRecord,
  message: string,
  nowIso: () => string,
  beginSend: (taskId: string) => boolean,
  endSend: (taskId: string) => void,
  granted?: ReviveReservation,
): Promise<SendOutcome> {
  if (record.status === "running" && granted === undefined) {
    return reviveRunningOnSend(port, record, message, beginSend, endSend)
  }
  if (!beginSend(record.task_id)) return evictionRefusal(record.task_id)
  try {
    const reservation = granted ?? port.reserveForDetachedRevive?.(record) ?? port.reserveForRevive(record.task_id)
    if (!reservation.ok) {
      return { kind: "admission_refused", task_id: record.task_id, reason: "lane_capacity" }
    }
    const reviveDetached = port.reviveDetached ?? getLifecycleDetachedRevival(port.store)
    if (reviveDetached === undefined) {
      reservation.release()
      return lazyRevivalFailure(record, "revival is unavailable")
    }
    let revived: Awaited<ReturnType<typeof reviveDetached>>
    try {
      revived = await reviveDetached(record.task_id, reservation)
    } catch (error) {
      await bestEffortRollback(port, record)
      reservation.release()
      return lazyRevivalFailure(record, error instanceof Error ? error.message : String(error))
    }
    if (!revived.ok) {
      reservation.release()
      return revived.code === undefined
        ? lazyRevivalFailure(record, revived.reason)
        : { kind: revived.code, task_id: record.task_id, reason: revived.reason }
    }
    const fresh = port.store.load(record.task_id)
    const handle = port.liveHandle(record.task_id)
    if (fresh === null || handle === undefined) {
      await bestEffortRollback(port, record)
      reservation.release()
      return lazyRevivalFailure(record, "child handle is unavailable")
    }
    return deliverRevivedTerminal(port, fresh, handle, message, nowIso, reservation, true, record)
  } finally {
    endSend(record.task_id)
  }
}

async function deliverRevivedTerminal(
  port: SteeringPort,
  record: TaskRecord,
  handle: ManagedChildHandle,
  message: string,
  nowIso: () => string,
  reservation: ReviveReservation,
  rollbackOnFailure: boolean,
  priorRecord?: TaskRecord,
): Promise<SendOutcome> {
  if (!reservation.ok) {
    return { kind: "capacity_deferred", task_id: record.task_id, reason: "Task capacity is full; retry explicitly." }
  }
  const preparedReservation = reservation
  let revived: TaskRecord | undefined
  let deliveryAcknowledged = false
  let poolDeliveryStarted = false
  let ticket: PreparedFollowUp | undefined
  let prior: TaskRecord | undefined
  let stamped: TaskRecord | undefined
  let dispatchEntered = false
  let retained = false
  function requireTicket(): PreparedFollowUp {
    if (ticket === undefined) throw new Error("revival follow-up ticket was not prepared")
    return ticket
  }
  function retain(reason: string): SendOutcome {
    retained = true
    requireTicket().retainFailure(reason)
    preparedReservation.commit()
    return lazyRevivalFailure(record, reason)
  }
  function notDispatched(reason: string): SendOutcome {
    // The store can fail after its synchronous mutation callback; a returned candidate
    // is not proof of persistence. The restore helper re-reads and fences the actual record.
    revived ??= stamped
    if (!revived || !prior) {
      preparedReservation.release()
      return lazyRevivalFailure(record, reason)
    }
    try {
      const restored = restorePreparedRevival(port, prior, revived, handle, requireTicket(), nowIso)
      if (!restored) {
        preparedReservation.release()
        return lazyRevivalFailure(record, "ownership changed before proven unstarted delivery could be restored")
      }
      preparedReservation.release()
      return lazyRevivalFailure(record, reason)
    } catch (error) {
      return retain(
        `known unadmitted turn; rollback unconfirmed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  try {
    const fresh = port.store.load(record.task_id)
    if (
      fresh === null ||
      fresh.status !== record.status ||
      fresh.killed === true ||
      fresh.host_pid !== record.host_pid ||
      fresh.notification.run_epoch !== record.notification.run_epoch
    ) {
      reservation.release()
      return lazyRevivalFailure(record, "task ownership or status changed before delivery")
    }
    prior = fresh
    if (handle.prepareFollowUp) {
      try {
        ticket = await handle.prepareFollowUp(fresh, nextRunEpoch(fresh))
      } catch (error) {
        reservation.release()
        return lazyRevivalFailure(record, error instanceof Error ? error.message : String(error))
      }
    }
    // Both warm and cold continuation fence the same record. A newly observed uncertainty
    // marker wins before an epoch is admitted; continuation never uses spawn-time stamping.
    let applied = false
    let uncertain: SendOutcome | undefined
    const updated = port.store.mutate(record.task_id, (current) => {
      if (
        current.status !== fresh.status ||
        current.host_pid !== fresh.host_pid ||
        current.residency_state !== "resident" ||
        current.killed === true ||
        current.notification.run_epoch !== fresh.notification.run_epoch ||
        (ticket &&
          (port.liveHandle(record.task_id) !== handle ||
            current.parent_session_id !== fresh.parent_session_id ||
            current.residency_claim !== fresh.residency_claim ||
            current.cancel_requested !== undefined))
      )
        return current
      uncertain = uncertainDeliveryDenial(current, message)
      if (uncertain !== undefined) return current
      applied = true
      const next = buildDeliveryRecord(current, nowIso(), message)
      if (!ticket) return next
      stamped = ticket.stamp(next)
      return stamped
    })
    if (uncertain !== undefined || !applied || updated === null) {
      reservation.release()
      return uncertain ?? lazyRevivalFailure(record, "claim changed before delivery")
    }
    revived = updated
    port.store.appendEvent(record.task_id, { type: "revived", payload: { run_epoch: revived.notification.run_epoch } })
    const pending = revived.pending_steering ?? []
    poolDeliveryStarted = pending.some((entry) => entry.workpool !== undefined)
    const text = [...pending.map((entry) => entry.message), message].join("\n\n")
    if (ticket) {
      dispatchEntered = true
      const result = await ticket.dispatch(text)
      if (result.kind === "not-dispatched") return notDispatched(result.reason)
      if (result.kind !== "accepted") return retain("prepared dispatch returned an unprovable admission disposition")
    } else await handle.followUp(text)
    deliveryAcknowledged = true
    const acknowledged = port.store.load(record.task_id)
    if (
      acknowledged?.status !== "running" ||
      acknowledged.host_pid !== revived.host_pid ||
      acknowledged.notification.run_epoch !== revived.notification.run_epoch ||
      port.liveHandle(record.task_id) !== handle
    ) {
      reservation.release()
      return lazyRevivalFailure(record, "revived run ended or changed ownership before delivery acknowledged")
    }
    if (pending.length > 0) {
      const deliveredIds = new Set(pending.map((entry) => entry.id))
      port.store.mutate(record.task_id, (current) => {
        const { revive_delivery_uncertain: _uncertainty, ...rest } = current
        return {
          ...rest,
          pending_steering: (current.pending_steering ?? []).filter((entry) => !deliveredIds.has(entry.id)),
        }
      })
    }
    retained = ticket !== undefined
    reservation.commit()
    return { kind: "revived", task_id: record.task_id, run_epoch: revived.notification.run_epoch }
  } catch (error) {
    if (ticket && !dispatchEntered) return notDispatched(error instanceof Error ? error.message : String(error))
    if (error instanceof InputUncertainError) {
      retained = ticket !== undefined
      reservation.commit()
      return { kind: "uncertain", task_id: record.task_id, effect_id: error.effectId, reason: error.message }
    }
    if (ticket) {
      return retain(
        `prepared dispatch failed without a proven no-dispatch result: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (error instanceof InputConflictError) {
      reservation.release()
      return {
        kind: "failed",
        task_id: record.task_id,
        effect_id: error.effectId,
        reason: error.reason,
        detail: error.detail,
        action: error.action,
      }
    }
    if (poolDeliveryStarted && revived?.revive_delivery_uncertain !== undefined) {
      // A transport exception is not proof of rejection. Keep O9's pre-dispatch marker and
      // captured queue intact; pool recovery will never automatically replay this turn.
      log("senpi-task workpool delivery uncertain", {
        taskId: record.task_id,
        runEpoch: revived.notification.run_epoch,
        error: error instanceof Error ? error.message : String(error),
      })
      reservation.commit()
      return deliveryUncertain(record, revived.notification.run_epoch)
    }
    if (deliveryAcknowledged && revived?.revive_delivery_uncertain !== undefined) {
      // The batch was accepted. Its pre-dispatch marker survives failed ack bookkeeping, so
      // neither rollback nor a later send can replay the still-persisted queue.
      log("senpi-task pending delivery acknowledgment persistence failed", {
        taskId: record.task_id,
        error: error instanceof Error ? error.message : String(error),
      })
      reservation.commit()
      return deliveryUncertain(record, revived.notification.run_epoch)
    }
    // A live child rejected the RPC before consuming the prompt, so teardown + rollback makes an
    // explicit retry safe. An exited child may have accepted it before the response was lost; keep
    // the revived epoch intact and let outcome tracking terminalize it instead of sending twice.
    const revivedForUncertainty = revived
    if (
      rollbackOnFailure &&
      priorRecord !== undefined &&
      revivedForUncertainty !== undefined &&
      handle.hasExited?.() === true
    ) {
      const epoch = revivedForUncertainty.notification.run_epoch
      // Fence the marker on the exact generation this revival wrote. A concurrent cancel/interrupt
      // that already won the terminal transition on this epoch owns the record; leave it untouched.
      // The marker write must be exception-safe: the reservation is committed or released exactly
      // once on every path, including a record-lock failure inside the fenced mutate.
      let marked = false
      try {
        port.store.mutate(record.task_id, (fresh) => {
          if (
            fresh.status !== "running" ||
            fresh.residency_state !== "resident" ||
            fresh.host_pid !== revivedForUncertainty.host_pid ||
            fresh.notification.run_epoch !== epoch
          )
            return fresh
          marked = true
          return { ...fresh, revive_delivery_uncertain: { run_epoch: epoch, message_sha256: messageSha256(message) } }
        })
      } catch (markError) {
        reservation.release()
        return lazyRevivalFailure(
          record,
          `unacknowledged delivery could not be recorded: ${markError instanceof Error ? markError.message : String(markError)}`,
        )
      }
      if (marked) {
        reservation.commit()
        port.store.appendEvent(record.task_id, {
          type: "revive_delivery_uncertain",
          payload: { run_epoch: epoch, message_sha256: messageSha256(message) },
        })
        return deliveryUncertain(record, epoch)
      }
      reservation.release()
      return lazyRevivalFailure(record, "the revived run was terminalized before the message was acknowledged")
    }
    if (rollbackOnFailure && priorRecord !== undefined) await bestEffortRollback(port, priorRecord)
    reservation.release()
    return lazyRevivalFailure(record, error instanceof Error ? error.message : String(error))
  } finally {
    if (ticket && !retained) await ticket.release()
  }
}

/** Native owns this exact-epoch restore; an issued undone epoch is burnt in the SAME write. */
function restorePreparedRevival(
  port: SteeringPort,
  prior: TaskRecord,
  admitted: TaskRecord,
  handle: ManagedChildHandle,
  ticket: PreparedFollowUp,
  nowIso: () => string,
): boolean {
  let restored = false
  port.store.mutate(prior.task_id, (fresh) => {
    const epoch = admitted.notification.run_epoch
    if (
      fresh.status !== "running" ||
      fresh.residency_state !== "resident" ||
      fresh.killed === true ||
      fresh.cancel_requested !== undefined ||
      fresh.host_pid !== admitted.host_pid ||
      fresh.parent_session_id !== admitted.parent_session_id ||
      fresh.residency_claim !== admitted.residency_claim ||
      fresh.notification.run_epoch !== epoch ||
      fresh.run_start_epoch !== epoch ||
      port.liveHandle(prior.task_id) !== handle
    )
      return fresh
    const expected = admitted.owned_session,
      current = fresh.owned_session
    if (expected || current) {
      if (!expected || !current || current.journalRevision < expected.journalRevision) return fresh
      const identity = [
        "format",
        "backendID",
        "location",
        "hostVersion",
        "parentID",
        "sessionID",
        "generation",
        "journalKey",
        "journalOwner",
        "runEpoch",
        "residencyClaim",
      ] as const
      if (identity.some((key) => current[key] !== expected[key])) return fresh
    }
    handle.assertOwned?.()
    const owned = ticket.restoreOwnedReference(prior)
    const next = { ...fresh }
    const fields = [
      "final_response",
      "error_message",
      "failure_kind",
      "failure_reason",
      "interrupt_cause",
      "run_stats",
      "prior_runs_cost_usd",
      "terminal_at",
      "provisional_exit",
      "stop_reason",
      "deadline",
      "awaiting_input",
      "run_start_epoch",
      "revive_delivery_uncertain",
    ] as const
    for (const key of fields) {
      if (Object.hasOwn(prior, key)) Object.assign(next, { [key]: prior[key] })
      else Reflect.deleteProperty(next, key)
    }
    if (owned === undefined) Reflect.deleteProperty(next, "owned_session")
    else next.owned_session = owned
    restored = true
    return {
      ...next,
      status: prior.status,
      residency_state: prior.residency_state,
      notification: { ...fresh.notification, run_epoch: prior.notification.run_epoch },
      burnt_epoch: Math.max(fresh.burnt_epoch ?? 0, prior.burnt_epoch ?? 0, epoch),
      updated_at: nowIso(),
    }
  })
  return restored
}

function buildDeliveryRecord(record: TaskRecord, timestamp: string, message: string): TaskRecord {
  const revived = buildRevived(record, timestamp)
  return record.revive_delivery_uncertain !== undefined || (record.pending_steering?.length ?? 0) === 0
    ? revived
    : {
        ...revived,
        revive_delivery_uncertain: {
          run_epoch: revived.notification.run_epoch,
          message_sha256: messageSha256(message),
        },
      }
}
