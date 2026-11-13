import type { Registration } from "@opencode/plugin/promise/registration"
import type { RpcHandlers, RpcRegistration } from "@opencode/plugin/promise/rpc"
import { ulwLoopStatusRpc } from "../rpc/ulw-loop"

export interface UlwLoopStatusRpcPort {
  register(
    definition: typeof ulwLoopStatusRpc,
    handlers: RpcHandlers<typeof ulwLoopStatusRpc>,
  ): Promise<RpcRegistration<typeof ulwLoopStatusRpc>>
}

export function createUlwLoopStatusRpc() {
  const active = new Map<string, boolean>()
  let events: RpcRegistration<typeof ulwLoopStatusRpc>["events"] | undefined
  return {
    async register(rpc: UlwLoopStatusRpcPort): Promise<Registration> {
      const registration = await rpc.register(ulwLoopStatusRpc, {
        status: async ({ sessionID }) => ({ sessionID, active: active.get(sessionID) ?? false }),
      })
      events = registration.events
      return registration
    },
    publish(sessionID: string, isActive: boolean): void {
      if ((active.get(sessionID) ?? false) === isActive) return
      active.set(sessionID, isActive)
      void events?.emit("updated", { sessionID, active: isActive }).catch((error: unknown) => {
        console.warn("[oh-my-openagent/v2] ulw-loop status update skipped", sessionID, String(error))
      })
    },
    forget(sessionID: string): void {
      active.delete(sessionID)
    },
    close(): void {
      events = undefined
      active.clear()
    },
  }
}
