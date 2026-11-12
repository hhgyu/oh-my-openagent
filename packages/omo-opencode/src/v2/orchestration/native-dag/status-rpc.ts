import type { Registration } from "@opencode/plugin/promise/registration"
import type { RpcHandlers, RpcRegistration } from "@opencode/plugin/promise/rpc"
import type { DagRunSnapshot } from "@oh-my-opencode/senpi-task/dag"
import { dagStatusRpc, dagStatusSnapshot } from "../../rpc/dag"

export interface DagStatusRpcPort {
  register(definition: typeof dagStatusRpc, handlers: RpcHandlers<typeof dagStatusRpc>): Promise<RpcRegistration<typeof dagStatusRpc>>
}

export function createDagStatusRpc(deps: { readonly snapshots: (sessionID: string) => readonly DagRunSnapshot[] }) {
  const published = new Map<string, string>()
  const chains = new Map<string, Promise<void>>()
  let events: RpcRegistration<typeof dagStatusRpc>["events"] | undefined
  let closed = false
  const snapshot = (sessionID: string) => dagStatusSnapshot(sessionID, deps.snapshots(sessionID))
  return {
    async register(rpc: DagStatusRpcPort): Promise<Registration> {
      const registration = await rpc.register(dagStatusRpc, {
        status: async ({ sessionID }) => {
          if (closed) throw Error("DAG status component is closed")
          return snapshot(sessionID)
        },
      })
      events = registration.events
      return registration
    },
    refreshSession(sessionID: string): void {
      if (closed || events === undefined) return
      const emitter = events
      const next = (chains.get(sessionID) ?? Promise.resolve()).then(async () => {
        if (closed) return
        const current = snapshot(sessionID)
        const fingerprint = JSON.stringify(current)
        if (published.get(sessionID) === fingerprint) return
        await emitter.emit("updated", current)
        published.set(sessionID, fingerprint)
      }).catch((error: unknown) => {
        console.warn("[oh-my-openagent/v2] DAG status update skipped", sessionID, error instanceof Error ? error.message : String(error))
      })
      chains.set(sessionID, next)
      void next.finally(() => { if (chains.get(sessionID) === next) chains.delete(sessionID) })
    },
    async settled(): Promise<void> { await Promise.allSettled([...chains.values()]) },
    close(): void { closed = true; events = undefined; published.clear() },
  }
}
