import type * as Plugin from "@opencode/plugin/promise/plugin"

export type MemorySessionPort = Pick<Plugin.Context["session"], "get" | "update">
export type MemorySessionInfo = Awaited<ReturnType<MemorySessionPort["get"]>>
export type SessionMetadata = NonNullable<MemorySessionInfo["metadata"]>
export type JsonValue = SessionMetadata[string]

export interface SessionMetadataStore {
  /**
   * Sets one namespaced key. The host's `session.update` replaces `metadata` as sent, so every write
   * re-reads the session and resends all other keys unchanged; writes for one session are serialized
   * in this process. There is no compare-and-set: a writer in another process between the read and
   * the update can still lose its key.
   */
  write(sessionID: string, key: string, value: JsonValue): Promise<void>
  settled(): Promise<void>
}

export function createSessionMetadataStore(session: MemorySessionPort): SessionMetadataStore {
  const chains = new Map<string, Promise<void>>()
  return {
    write(sessionID, key, value) {
      const previous = chains.get(sessionID) ?? Promise.resolve()
      const next = previous.catch(() => undefined).then(async () => {
        const info = await session.get({ sessionID })
        const current: SessionMetadata = info.metadata ?? {}
        if (jsonEqual(current[key], value)) return
        await session.update({ sessionID, metadata: { ...current, [key]: value } })
      })
      chains.set(sessionID, next)
      void next.finally(() => { if (chains.get(sessionID) === next) chains.delete(sessionID) }).catch(() => undefined)
      return next
    },
    async settled() {
      await Promise.allSettled([...chains.values()])
    },
  }
}

function jsonEqual(left: JsonValue | undefined, right: JsonValue): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
