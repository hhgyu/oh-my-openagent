// Composition provenance only, never a permission or a host-outcome assertion.
// An opaque registered token survives trusted object-spread telemetry wrappers.
const marker = Symbol("joined-session-cancellation")
const tokens = new WeakSet<object>()
export function withJoinedSessionCancellation<T extends object>(
  api: T,
  provenance: "effect-runtime" | "controlled-test",
) {
  if (provenance !== "effect-runtime" && provenance !== "controlled-test")
    throw new Error("Invalid session cancellation provenance")
  const token = Object.freeze({ provenance })
  tokens.add(token)
  return Object.assign(api, { [marker]: token })
}
export function hasJoinedSessionCancellation(api: object): boolean {
  const token = (api as { [marker]?: unknown })[marker]
  return !!token && typeof token === "object" && tokens.has(token)
}
