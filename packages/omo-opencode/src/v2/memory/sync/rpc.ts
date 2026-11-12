// The `omo.memory.sync` RPC on OpenCode 2: Senpi's five methods (`omo.memory.sync.{enable,pending,
// approve,status,devices}`) as one definition whose id is the Senpi method prefix, so a client calls
// `rpc.call({ rpcID: "omo.memory.sync", method: "enable" })`. OpenCode 2.2.6 keys its RPC registry by
// the raw id with no validation and routes calls through `/api/rpc/:rpcID/:method`, so the dotted id
// is accepted as-is. Inputs are taken as any JSON object and validated by memory-core's coordinator, so
// a bad request gets Senpi's `{ kind: "refused" }` answer instead of an `rpc.invalid_input` error.

import type { Rpc } from "@opencode/plugin"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import { z } from "zod"
import type { MemoryHost } from "../index"
import type { MemorySyncRuntime } from "./runtime"
import type { SyncRpcVerb } from "./ports"

export const MEMORY_SYNC_RPC_ID = "omo.memory.sync"

const request = z.record(z.string(), z.unknown())
const response = z.record(z.string(), z.unknown())
const method = { input: request, output: response }

export const memorySyncRpc = {
  id: MEMORY_SYNC_RPC_ID,
  methods: { enable: method, pending: method, approve: method, status: method, devices: method },
  events: {},
} satisfies Rpc.PortableDefinition

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

type MemoryRpcDomain = NonNullable<MemoryHost["rpc"]>

/**
 * Registers the definition; every handler forwards to the component's sync runtime, which answers for
 * the component's single RPC owner. The per-call signal is not the ceremony's: a pairing outlives the
 * call that started it and ends with the component.
 */
export function registerMemorySyncRpc(
  rpc: MemoryRpcDomain,
  runtime: Pick<MemorySyncRuntime, "call">,
): Promise<RpcRegistration<typeof memorySyncRpc>> {
  const forward =
    (verb: SyncRpcVerb) =>
    async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const answer = await runtime.call(verb, input)
      return isRecord(answer) ? answer : { kind: "unavailable", reason: "The sync operation could not complete." }
    }
  return rpc.register(memorySyncRpc, {
    enable: forward("enable"),
    pending: forward("pending"),
    approve: forward("approve"),
    status: forward("status"),
    devices: forward("devices"),
  })
}
