import { randomUUID } from "node:crypto"
import {
  InputUncertainError,
  type OwnedSessionIdentity,
  type PreparedFollowUp,
  type TaskRecord,
} from "@oh-my-opencode/senpi-task/manager-kernel"
import type { ChildHandle, ChildRecord, OwnedTurnDescriptor, createSessionBackend } from "../../host/session-backend"
import type { OwnedChildObserver } from "../../host/owned-child-observer"
import { ownedInputID } from "./managed-input"

type Backend = ReturnType<typeof createSessionBackend>

/** One prepared Native run, not an alternative manager or a host execution identity. */
export function createOwnedTurnTicket(options: {
  prior: TaskRecord
  nextEpoch: number
  child: ChildHandle
  backend: Backend
  observer: OwnedChildObserver
  observationKey: string
  priorDescriptor: OwnedTurnDescriptor | undefined
  signal: AbortSignal
  assertOwned(): void
  identify(id: string): void
  publish(row: ChildRecord, next: TaskRecord, admission: Promise<void>): OwnedSessionIdentity
  restoreReference(row: ChildRecord, prior: TaskRecord): OwnedSessionIdentity
  synchronize(): Promise<void>
  accepted(): Promise<void>
  failure(reason: string): void
  release(): Promise<void>
  track(work: Promise<unknown>): void
  serialize<T>(operation: () => Promise<T>): Promise<T>
}): PreparedFollowUp {
  const nativeID = `owned-turn:${options.prior.task_id}:${options.nextEpoch}:${randomUUID()}`
  const hostID = ownedInputID(options.child.locator, nativeID)
  const descriptor = Object.freeze({
    nativeEpoch: options.nextEpoch,
    observationKey: options.observationKey,
    firstInputID: hostID,
  })
  const admission = Promise.withResolvers<void>()
  void admission.promise.catch(() => {})
  let attempt: ReturnType<Backend["preparePromptContinuation"]> | undefined
  let stamped = false,
    dispatched = false,
    kept = false
  options.observer.expectInput(hostID)
  return {
    stamp(next) {
      if (stamped || next.notification.run_epoch !== options.nextEpoch)
        throw new Error("Prepared owned turn already published or wrong epoch")
      options.signal.throwIfAborted()
      options.assertOwned()
      const row = options.backend.checkpointTurn(options.child, descriptor)
      const reference = options.publish(row, next, admission.promise)
      stamped = true
      return { ...next, owned_session: reference }
    },
    async dispatch(text) {
      if (!stamped || dispatched) throw new Error("Prepared owned turn is not dispatchable")
      dispatched = true
      const work = options.serialize(async () => {
        try {
          options.signal.throwIfAborted()
          options.assertOwned()
          options.identify(nativeID)
          attempt = options.backend.preparePromptContinuation(
            options.child,
            { id: hostID, text, delivery: "queue", resume: true },
            { signal: options.signal },
          )
          await attempt.send()
          await options.synchronize()
          await options.accepted()
          kept = true
          admission.resolve()
          return { kind: "accepted" as const }
        } catch (cause) {
          if (!attempt?.invoked())
            return {
              kind: "not-dispatched" as const,
              reason: `Owned prompt was not invoked: ${cause instanceof Error ? cause.message : String(cause)}`,
            }
          // A real call began: ACK absence/checkpoint failure can never authorize rollback.
          kept = true
          try {
            await options.synchronize()
          } catch {
            /* Custody refusal stays local; no foreign write. */
          }
          options.failure("owned-turn-admission-uncertain")
          admission.resolve()
          const error = new InputUncertainError(nativeID, cause instanceof Error ? cause : new Error(String(cause)))
          error.message =
            "Owned follow-up was invoked; admission/checkpoint is unconfirmed and this input is not replayed."
          throw error
        }
      })
      options.track(work)
      return work
    },
    restoreOwnedReference(prior) {
      if (attempt?.invoked()) throw new Error("Invoked owned turn cannot be restored")
      const row = attempt
        ? attempt.restoreTurn(options.priorDescriptor)
        : options.backend.checkpointTurn(options.child, options.priorDescriptor)
      return options.restoreReference(row, prior)
    },
    retainFailure(reason) {
      kept = true
      options.failure(reason)
      admission.resolve()
    },
    async release() {
      if (kept) return
      admission.reject(new Error("Unpublished owned turn released"))
      await options.release()
    },
  }
}
