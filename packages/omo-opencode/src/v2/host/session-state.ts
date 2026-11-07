import type { ToolContext } from "@opencode/plugin/promise/tool"

export interface ToolAccess {
  readonly requested: string
  readonly routed: string
  readonly input: unknown
}

export interface SessionToolPolicy {
  readonly tools: readonly string[]
  /** A schema is exposure, not authority. Every session must supply a handler guard. */
  readonly authorize: (call: ToolAccess) => void | Promise<void>
}

export interface SessionLease {
  readonly sessionID: ToolContext["sessionID"]
  readonly generation: number
  readonly signal: AbortSignal
}

export function createSessionScopes() {
  const current = new Map<string, { lease: SessionLease; controller: AbortController; policy: SessionToolPolicy }>()
  const owned = new WeakSet<SessionLease>()
  let generation = 0
  function assert(lease: SessionLease, sessionID = lease.sessionID) {
    if (!owned.has(lease) || lease.sessionID !== sessionID || current.get(sessionID)?.lease !== lease || lease.signal.aborted) {
      throw new Error("Unknown, foreign or retired session scope")
    }
    return current.get(sessionID)!
  }
  return {
    open(sessionID: SessionLease["sessionID"], policy: SessionToolPolicy): SessionLease {
      current.get(sessionID)?.controller.abort(new Error("Session scope replaced"))
      const controller = new AbortController()
      const lease = Object.freeze({ sessionID, generation: ++generation, signal: controller.signal })
      owned.add(lease)
      current.set(sessionID, { lease, controller, policy: Object.freeze({ tools: Object.freeze([...policy.tools]), authorize: policy.authorize }) })
      return lease
    },
    assert,
    async authorize(lease: SessionLease, call: ToolAccess) {
      const { policy } = assert(lease)
      if (!policy.tools.includes(call.requested) || !policy.tools.includes(call.routed)) throw new Error("Tool outside session scope")
      await policy.authorize(call)
      assert(lease)
    },
    retire(lease: SessionLease) {
      const entry = assert(lease)
      current.delete(lease.sessionID)
      entry.controller.abort(new Error("Session scope retired"))
    },
    dispose() {
      for (const entry of current.values()) entry.controller.abort(new Error("Session scopes disposed"))
      current.clear()
    },
  }
}

export type SessionScopes = ReturnType<typeof createSessionScopes>
