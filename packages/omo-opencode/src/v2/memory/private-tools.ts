// One place decides which memory-child tools a model request may see. Every child hosting registers
// its tools once through `tool.transform`, so the host offers them on every request; this narrows a
// request of the owning child to that child's tools and removes them from every other session's
// request. The `context` and `compaction` hooks both run it (a compaction request carries `tools`).

import type { SessionContext } from "@opencode/plugin/promise/session"

export type PrivateToolRequest = Pick<SessionContext, "sessionID" | "tools">

/** A hosting that owns child-only tools; returns true when the request belongs to one of its children. */
export type PrivateToolOwner = (value: PrivateToolRequest) => boolean

/**
 * Applies every owner in order and stops at the first one that owns the session (its narrowing
 * already removed every other tool). Returns true when the request belongs to an owned child.
 */
export function narrowPrivateTools(value: PrivateToolRequest, owners: readonly (PrivateToolOwner | undefined)[]): boolean {
  for (const owner of owners) if (owner?.(value) === true) return true
  return false
}
