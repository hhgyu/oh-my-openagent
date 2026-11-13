import {
  PARKING_MARKER_KEY,
  canonical,
  classifyParking,
  parkingMarker,
  observe,
  parkingConflict,
  rules,
  type ParkingDescriptor,
  type ParkingPort,
  type SessionMetadata,
} from "./child-parking"
import { SessionBackendError } from "./session-backend"

export type RestorePort = Pick<ParkingPort, "locator" | "record" | "checkpoint" | "fence" | "read" | "update">

function withoutMarker(metadata: SessionMetadata | undefined, tombstone: boolean): SessionMetadata {
  const value: Record<string, SessionMetadata[string]> = { ...metadata }
  Reflect.deleteProperty(value, PARKING_MARKER_KEY)
  if (tombstone) value[PARKING_MARKER_KEY] = null
  return value
}

/** Fresh-action restore of a parked child's OWN session. Callers must already hold the new guard
 * generation, producer bindings and context policy. Only our deny rule and marker are removed;
 * unrelated metadata keys are preserved as actually read. Observed divergence is a conflict:
 * current host rules are never overwritten. Like parking this is optimistic detection, not CAS. */
export async function restoreParkedChild(
  port: RestorePort,
  expectedAgent: string | undefined,
): Promise<ParkingDescriptor> {
  const conflict = parkingConflict(port)
  let parking = port.record().parking
  if (!parking || (parking.state !== "parked" && parking.state !== "restoring"))
    throw new SessionBackendError("state", "Child has no parked custody to restore", port.locator)
  if (expectedAgent !== undefined && parking.agent !== undefined && expectedAgent !== parking.agent)
    throw new SessionBackendError(
      "state",
      "Fresh approval agent differs from the parked child; restore refused",
      port.locator,
    )
  if (parking.state === "parked") {
    await port.fence()
    if (classifyParking(observe(await port.read()), parking, port.record()) !== "parked")
      return conflict(parking, "parked host rules or marker changed before restore")
    const { readback: _verified, ...intent } = parking
    parking = { ...intent, state: "restoring" }
    await port.checkpoint(parking)
  }
  await port.fence()
  const record = port.record(),
    current = await port.read(),
    seen = observe(current)
  const state = classifyParking(seen, parking, record)
  if (state === "diverged") return conflict(parking, "host rules or marker diverged before restore")
  // Original absent permissions restore as [] (identical in host merge; update cannot unset).
  if (state === "parked")
    await port.update({ permissions: rules(parking.original.rules), metadata: withoutMarker(current.metadata, false) })
  let after = await port.read()
  const partial = observe(after)
  if (
    partial.marker === canonical(parkingMarker(record, parking)) &&
    partial.rules === canonical(rules(parking.original.rules))
  ) {
    // Merge-patch metadata keeps an omitted key: remove our marker by nulling ONLY that key.
    await port.update({ permissions: rules(parking.original.rules), metadata: withoutMarker(after.metadata, true) })
    after = await port.read()
  }
  const final = observe(after)
  if (classifyParking(final, parking, record) !== "original" || final.foreign !== seen.foreign)
    return conflict(parking, "restore readback differs")
  const restored: ParkingDescriptor = { ...parking, state: "restored", readback: "verified" }
  await port.checkpoint(restored)
  return restored
}
