/** Tags OpenCode 2.2.6 fails a call with when the named session does not exist: the host's own
 * `Session.NotFoundError` and the public protocol's `SessionNotFoundError`. */
const SESSION_NOT_FOUND_TAGS: ReadonlySet<string> = new Set(["Session.NotFoundError", "SessionNotFoundError"])

/** True only when the host itself answered that THIS exact session does not exist. Every other
 * failure (transport, location, codec, a different session) leaves the session's presence unknown. */
export function isHostSessionAbsent(error: unknown, sessionID: string): boolean {
  if (typeof error !== "object" || error === null) return false
  const tag: unknown = Reflect.get(error, "_tag"), named: unknown = Reflect.get(error, "sessionID")
  return typeof tag === "string" && SESSION_NOT_FOUND_TAGS.has(tag) && named === sessionID
}
