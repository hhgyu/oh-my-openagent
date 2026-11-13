import { createHash, randomUUID } from "node:crypto"
import type { Context } from "@opencode/plugin/promise/plugin"
import { SessionBackendError, type ChildLocator, type ChildRecord } from "./session-backend"

type UpdateInput = NonNullable<Parameters<Context["session"]["update"]>[0]>
export type SessionRule = NonNullable<UpdateInput["permissions"]>[number]
export type SessionMetadata = NonNullable<UpdateInput["metadata"]>
/** Own namespaced host metadata key. Unrelated keys are preserved as actually read. */
export const PARKING_MARKER_KEY = "omo.native-task.parking"
/** Host rule evaluation is last-match-wins, so an appended wildcard deny denies every action. */
export const PARKED_DENY_RULE: SessionRule = Object.freeze({ action: "*", resource: "*", effect: "deny" })

/**
 * Durable parking descriptor. PARKED IS NOT CLOSED: the record phase stays truthful and a
 * parked/conflict descriptor never grants execution or substitutes for a closed receipt.
 * Only a genuine fresh action may restore it (restoring -> restored, see child-parking-restore).
 */
export interface ParkingDescriptor {
  readonly format: 1
  readonly state: "intent" | "parked" | "conflict" | "restoring" | "restored"
  readonly id: string
  readonly owner: string
  readonly original: { readonly present: boolean; readonly rules: readonly SessionRule[] }
  readonly fingerprint: string
  readonly marker: typeof PARKING_MARKER_KEY
  readonly agent?: string
  readonly nativeEpoch?: number
  readonly intentRevision: number
  readonly readback?: "verified"
  readonly conflict?: string
}
/** The host fields parking observes. Optional so narrower identity-only views still type-check. */
export interface ParkingObservedInfo {
  readonly agent?: string
  readonly permissions?: readonly SessionRule[]
  readonly metadata?: SessionMetadata
}
export interface Observed {
  readonly agent?: string
  readonly present: boolean
  readonly rules: string
  readonly marker?: string
  readonly foreign: string
}
export interface ParkingPort {
  readonly locator: ChildLocator
  record(): ChildRecord
  /** Same fenced checkpoint as every other custody transition. */
  checkpoint(parking: ParkingDescriptor): Promise<void>
  /** Journal owner/revision fence plus live control custody. */
  fence(): Promise<void>
  read(): Promise<ParkingObservedInfo>
  update(input: { permissions: readonly SessionRule[]; metadata: SessionMetadata }): Promise<void>
  interrupt(): Promise<void>
  wait(): Promise<void>
  /** Revoke and JOIN original guard admissions/effects and live producers. */
  join(): Promise<void>
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`)
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}
export function rules(value: readonly SessionRule[]): SessionRule[] {
  return value.map((rule) => ({ action: rule.action, resource: rule.resource, effect: rule.effect }))
}
function parkedRules(parking: Pick<ParkingDescriptor, "original">): SessionRule[] {
  return [...rules(parking.original.rules), { ...PARKED_DENY_RULE }]
}
export function parkingMarker(
  record: Pick<ChildRecord, "key">,
  parking: Pick<ParkingDescriptor, "id" | "owner" | "fingerprint">,
): SessionMetadata {
  return { format: 1, parking: parking.id, key: record.key, owner: parking.owner, fingerprint: parking.fingerprint }
}
export function observe(info: ParkingObservedInfo): Observed {
  const metadata = { ...info.metadata }
  // A null own key is a removed marker under merge-patch metadata semantics.
  const own =
    Object.hasOwn(metadata, PARKING_MARKER_KEY) && metadata[PARKING_MARKER_KEY] !== null
      ? canonical(metadata[PARKING_MARKER_KEY])
      : undefined
  Reflect.deleteProperty(metadata, PARKING_MARKER_KEY)
  return {
    ...(info.agent === undefined ? {} : { agent: info.agent }),
    present: info.permissions !== undefined,
    rules: canonical(rules(info.permissions ?? [])),
    ...(own === undefined ? {} : { marker: own }),
    foreign: canonical(metadata),
  }
}
const same = (left: Observed, right: Observed) => canonical(left) === canonical(right)
/** "original": the recorded rules without our marker (absent and [] are equivalent in host
 * merge semantics; update cannot unset). "parked": exactly our deny-last rules plus OUR marker. */
export function classifyParking(
  seen: Observed,
  parking: ParkingDescriptor,
  record: Pick<ChildRecord, "key">,
): "original" | "parked" | "diverged" {
  if (seen.agent !== parking.agent) return "diverged"
  if (
    (seen.present || !parking.original.present) &&
    seen.rules === canonical(rules(parking.original.rules)) &&
    seen.marker === undefined
  )
    return "original"
  if (
    seen.present &&
    seen.rules === canonical(parkedRules(parking)) &&
    seen.marker === canonical(parkingMarker(record, parking))
  )
    return "parked"
  return "diverged"
}
export function parkingConflict(port: Pick<ParkingPort, "checkpoint" | "locator">) {
  return async (base: ParkingDescriptor, reason: string): Promise<never> => {
    const { readback: _verified, ...unverified } = base
    await port.checkpoint({ ...unverified, state: "conflict", conflict: reason })
    throw new SessionBackendError(
      "conflict",
      `Child parking conflict: ${reason}; custody retained for explicit reconcile`,
      port.locator,
    )
  }
}

/** Serialized under the backend's exclusive entry custody. The public SDK update has no
 * expected revision: this is optimistic OBSERVED-conflict detection, not compare-and-set. An
 * external last writer between our final read and update remains possible and is not certified. */
export async function parkChild(port: ParkingPort): Promise<ParkingDescriptor> {
  const conflict = parkingConflict(port),
    classify = classifyParking
  let existing = port.record().parking
  if (existing?.state === "restoring") {
    // A failed restore re-parks: unwritten restore returns to parked; a written one parks anew.
    await port.join()
    await port.fence()
    const state = classify(observe(await port.read()), existing, port.record())
    if (state === "diverged") return conflict(existing, "host rules diverged during restore")
    if (state === "parked") {
      const parked: ParkingDescriptor = { ...existing, state: "parked", readback: "verified" }
      await port.checkpoint(parked)
      return parked
    }
    existing = undefined
  }
  if (existing?.state === "restored") existing = undefined
  if (existing?.state === "conflict")
    throw new SessionBackendError("conflict", "Child parking is in conflict; explicit reconcile required", port.locator)
  if (existing?.state === "parked") {
    // Idempotent retry: re-verify the host still enforces OUR deny before a receipt.
    await port.join()
    await port.fence()
    if (classify(observe(await port.read()), existing, port.record()) !== "parked")
      return conflict(existing, "parked host rules or marker changed")
    return existing
  }
  const before = existing ? undefined : observe(await port.read())
  await port.join()
  await port.fence()
  await port.interrupt()
  await port.fence()
  await port.wait()
  await port.fence()
  const info = await port.read(),
    quiet = observe(info)
  let parking = existing
  if (!parking) {
    const record = port.record()
    const original = { present: info.permissions !== undefined, rules: rules(info.permissions ?? []) }
    const id = randomUUID(),
      fingerprint = createHash("sha256")
        .update(canonical(parkedRules({ original })))
        .digest("hex")
    parking = {
      format: 1,
      state: "intent",
      id,
      owner: record.owner,
      original,
      fingerprint,
      marker: PARKING_MARKER_KEY,
      ...(quiet.agent === undefined ? {} : { agent: quiet.agent }),
      ...(record.turn ? { nativeEpoch: record.turn.nativeEpoch } : {}),
      intentRevision: record.revision + 1,
    }
    if (!before || !same(before, quiet))
      return conflict(parking, "session rules, agent or metadata changed during quiescence")
    if (quiet.marker !== undefined) return conflict(parking, "foreign parking marker present")
    await port.checkpoint(parking)
  }
  // Recheck journal and the actual child immediately before the original write.
  await port.fence()
  const record = port.record(),
    current = await port.read(),
    seen = observe(current)
  const state = classify(seen, parking, record)
  if (state === "diverged") return conflict(parking, "session rules, agent or marker diverged before write")
  if (state === "original") {
    const metadata: Record<string, SessionMetadata[string]> = {
      ...current.metadata,
      [PARKING_MARKER_KEY]: parkingMarker(record, parking),
    }
    await port.update({ permissions: parkedRules(parking), metadata })
  }
  const after = observe(await port.read())
  if (classify(after, parking, record) !== "parked" || after.foreign !== seen.foreign)
    return conflict(parking, "permission write readback differs")
  const parked: ParkingDescriptor = { ...parking, state: "parked", readback: "verified" }
  await port.checkpoint(parked)
  return parked
}
