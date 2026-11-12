// `omo.memory.status` and `omo.memory.updated` on OpenCode 2 (Senpi `memory-rpc-bridge.ts`). Senpi binds
// its bridge to the one session of its process; a V2 host serves many sessions, so the status method
// takes a `sessionID` and answers for that bound session, and every `updated` event carries the session
// it describes. The definition id is the Senpi prefix: `rpc.call({ rpcID: "omo.memory", method: "status" })`
// and the event type `rpc.omo.memory.updated`. An event is published after a repo change (a HEAD move,
// which a sync converge also makes, or a change of the shown sync failure) and after a journal settle,
// deduplicated per session by content.

import type { Rpc } from "@opencode/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { RpcHandlers, RpcRegistration } from "@opencode/plugin/promise/rpc"
import { z } from "zod"
import { describeError, type BoundMemorySession } from "./binding"
import type { MemoryLogger } from "./config"
import { buildMemoryStatusSnapshot, type MemoryStatusSnapshot } from "./status-snapshot"
import type { MemoryRpcSync } from "./sync/ports"

export const MEMORY_STATUS_RPC_ID = "omo.memory"
export const MEMORY_UPDATED_EVENT = "updated"
const REPO_DEBOUNCE_MS = 250

const memoryStatusRpc = {
  id: MEMORY_STATUS_RPC_ID,
  methods: {
    status: { input: z.object({ sessionID: z.string().min(1) }), output: z.record(z.string(), z.unknown()) },
  },
  events: { [MEMORY_UPDATED_EVENT]: { schema: z.record(z.string(), z.unknown()) } },
} satisfies Rpc.PortableDefinition

/** The slice of the host RPC domain this definition needs (the generic `register` satisfies it). */
export interface MemoryStatusRpcPort {
  register(definition: typeof memoryStatusRpc, handlers: RpcHandlers<typeof memoryStatusRpc>): Promise<RpcRegistration<typeof memoryStatusRpc>>
}

export interface MemoryStatusRpc {
  onBound(bound: BoundMemorySession): void
  /** The session's journal settled: its journal and reflection fields may have moved. */
  refreshSession(sessionID: string): void
  /** The repo changed: every session bound to it is refreshed once the burst settles. */
  refreshRepo(repo: string): void
  register(rpc: MemoryStatusRpcPort): Promise<Registration>
  /** Resolves once every publication started so far has finished. */
  settled(): Promise<void>
  close(): void
}

export function createMemoryStatusRpc(deps: {
  readonly syncStatus: (repo: string) => Promise<MemoryRpcSync | undefined>
  readonly logger: MemoryLogger
  readonly debounceMs?: number
}): MemoryStatusRpc {
  const sessions = new Map<string, BoundMemorySession>()
  const published = new Map<string, string>()
  const chains = new Map<string, Promise<void>>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let events: RpcRegistration<typeof memoryStatusRpc>["events"] | undefined
  let closed = false

  const snapshot = async (bound: BoundMemorySession): Promise<MemoryStatusSnapshot> =>
    buildMemoryStatusSnapshot(bound, await deps.syncStatus(bound.paths.repo))

  const publish = (sessionID: string): void => {
    const bound = sessions.get(sessionID)
    if (closed || events === undefined || bound === undefined) return
    const emitter = events
    const previous = chains.get(sessionID) ?? Promise.resolve()
    const next = previous.then(async () => {
      if (closed) return
      const current = await snapshot(bound)
      const fingerprint = JSON.stringify(current)
      if (closed || published.get(sessionID) === fingerprint) return
      published.set(sessionID, fingerprint)
      await emitter.emit(MEMORY_UPDATED_EVENT, { ...current })
    }).catch((error: unknown) => {
      deps.logger.warn("memory status update skipped", { sessionID, error: describeError(error) })
    })
    chains.set(sessionID, next)
    void next.finally(() => { if (chains.get(sessionID) === next) chains.delete(sessionID) })
  }

  return {
    onBound(bound) {
      if (closed) return
      sessions.set(bound.sessionID, bound)
    },
    refreshSession: publish,
    refreshRepo(repo) {
      if (closed || timers.has(repo)) return
      const timer = setTimeout(() => {
        timers.delete(repo)
        for (const bound of sessions.values()) if (bound.paths.repo === repo) publish(bound.sessionID)
      }, deps.debounceMs ?? REPO_DEBOUNCE_MS)
      timer.unref?.()
      timers.set(repo, timer)
    },
    async register(rpc) {
      const registration = await rpc.register(memoryStatusRpc, {
        status: async ({ sessionID }) => {
          const bound = sessions.get(sessionID)
          if (closed || bound === undefined) return { kind: "unavailable", reason: "No bound memory session." }
          return { ...await snapshot(bound) }
        },
      })
      events = registration.events
      return registration
    },
    async settled() {
      await Promise.allSettled([...chains.values()])
    },
    close() {
      closed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      sessions.clear()
      published.clear()
    },
  }
}
