const branded = new WeakSet<object>()

/** Observation failure is neither a model failure nor evidence that the host stopped. */
export class ChildObservationUncertain extends Error {
  readonly code = "child_observation_uncertain"
  constructor(readonly reason: string, readonly startEventID?: string) {
    super(`Child observation uncertain: ${reason}`)
    if (!/^[a-z0-9-]{1,128}$/.test(reason)) throw new Error("Invalid observation reason")
    branded.add(this)
  }
  static is(value: unknown): value is ChildObservationUncertain {
    return typeof value === "object" && value !== null && branded.has(value)
  }
}
