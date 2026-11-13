import { parkChild, type ParkingDescriptor, type ParkingPort } from "./child-parking"
import { restoreParkedChild } from "./child-parking-restore"
import {
  SessionBackendError,
  type ChildHandle,
  type ChildJournal,
  type ChildRecord,
  type SessionBackendApi,
  type SessionReference,
} from "./session-backend"

interface ParkingEntry {
  record: ChildRecord
  handle?: ChildHandle
  detached?: boolean
}
interface Issued<E> {
  readonly entry: E
  readonly child: ChildHandle
  readonly id: string
}

/** Backend-owned parking custody. Runs inside the backend's SAME exclusive entry custody; the
 * receipt is a private WeakMap capability closing over the issued child, entry and journal fence. */
export function createChildParking<E extends ParkingEntry>(deps: {
  readonly session: SessionBackendApi
  readonly journal: ChildJournal
  join(child: ChildHandle): Promise<void>
  signal(child: ChildHandle): AbortSignal
  live(child: ChildHandle, entry: E): Promise<void>
  identity(info: SessionReference, locator: ChildHandle["locator"]): void
  checkpoint(entry: E, parking: ParkingDescriptor): Promise<void>
  /** Aborted once OpenCode closes the plugin's location: a park's idle wait is then met (see
   * `SessionBackendOptions.locationReleased`). */
  readonly released?: AbortSignal
}) {
  const receipts = new WeakMap<object, Issued<E>>(),
    byChild = new WeakMap<ChildHandle, object>()
  function port(entry: E, child: ChildHandle): ParkingPort {
    const update = deps.session.update
    const { assertCurrent, writeSync } = deps.journal
    if (!update || !assertCurrent || !writeSync)
      throw new SessionBackendError(
        "unavailable",
        "Durable parking requires the joined session update and synchronous journal custody",
        child.locator,
      )
    const sessionID = child.locator.sessionID,
      signal = () => deps.signal(child)
    return {
      locator: child.locator,
      record: () => entry.record,
      fence: () => deps.live(child, entry),
      async checkpoint(parking) {
        await deps.live(child, entry)
        await deps.checkpoint(entry, parking)
      },
      async read() {
        const info = await deps.session.get({ sessionID }, { signal: signal() })
        deps.identity(info, child.locator)
        return info
      },
      async update(input) {
        await update({ sessionID, permissions: input.permissions, metadata: input.metadata }, { signal: signal() })
      },
      async interrupt() {
        const reply = await deps.session.interrupt({ sessionID, resume: false }, { signal: signal() })
        if (!reply || typeof reply.interrupted !== "boolean")
          throw new SessionBackendError("uncertain", "Parking interruption acknowledgement unknown", child.locator)
      },
      async wait() {
        const released = deps.released
        if (released?.aborted) return
        try {
          await deps.session.wait(
            { sessionID },
            { signal: released ? AbortSignal.any([signal(), released]) : signal() },
          )
        } catch (error) {
          if (!released?.aborted) throw error
        }
      },
      join: () => deps.join(child),
    }
  }
  return {
    /** Until a genuine fresh action restores it, a parked child admits no input and stays denied. */
    refuseInput(record: ChildRecord) {
      if (record.parking && record.parking.state !== "restored")
        throw new SessionBackendError(
          "state",
          `Child is ${record.parking.state === "conflict" ? "in parking conflict" : "parked"}; only a fresh authorized restore may admit input`,
          record.locator,
        )
    },
    async park(entry: E, child: ChildHandle): Promise<ParkingDescriptor> {
      return parkChild(port(entry, child))
    },
    async restore(entry: E, child: ChildHandle, expectedAgent: string | undefined): Promise<ParkingDescriptor> {
      return restoreParkedChild(port(entry, child), expectedAgent)
    },
    issue(entry: E, child: ChildHandle, parking: ParkingDescriptor) {
      const receipt = Object.freeze({})
      receipts.set(receipt, Object.freeze({ entry, child, id: parking.id }))
      byChild.set(child, receipt)
    },
    receipt(child: ChildHandle): object | undefined {
      return byChild.get(child)
    },
    assertParked(receipt: object, child: object) {
      const issued = receipts.get(receipt)
      if (!issued || issued.child !== child || issued.entry.handle !== child || !issued.entry.detached)
        throw new SessionBackendError("foreign", "Unissued or foreign child parking receipt")
      const parking = issued.entry.record.parking
      if (parking?.state !== "parked" || parking.readback !== "verified" || parking.id !== issued.id)
        throw new SessionBackendError(
          "conflict",
          "Child parking receipt no longer matches durable custody",
          issued.child.locator,
        )
      const assertCurrent = deps.journal.assertCurrent
      if (!assertCurrent || assertCurrent.call(deps.journal, issued.entry.record) !== undefined)
        throw new SessionBackendError(
          "unavailable",
          "Synchronous parking journal fence unavailable",
          issued.child.locator,
        )
    },
  }
}
