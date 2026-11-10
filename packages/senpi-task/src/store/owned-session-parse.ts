import { z } from "zod"
import { isAbsolute } from "node:path"
import type { OwnedSessionIdentity } from "../state/types"

const text = z.string().min(1).max(4096).refine(value => !value.includes("\0"))
const ordinal = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const identity = z.object({ format: z.literal(1), backendID: text, location: text.refine(isAbsolute), hostVersion: text,
  parentID: text, sessionID: text, generation: ordinal, journalKey: text, journalOwner: text,
  journalRevision: ordinal, runEpoch: ordinal, residencyClaim: text }).strict()
const uncertainty = z.object({ reason: z.string().min(1).max(128), startEventID: text.optional() }).strict()

export function parseOwnedSession(value: unknown): OwnedSessionIdentity | undefined {
  if (value === undefined) return undefined
  const parsed = identity.safeParse(value)
  if (!parsed.success) throw new Error("Invalid owned session identity")
  return parsed.data
}

export function parseObservationUncertainty(value: unknown) {
  if (value === undefined) return undefined
  const parsed = uncertainty.safeParse(value)
  if (!parsed.success) throw new Error("Invalid observation uncertainty")
  return parsed.data
}
