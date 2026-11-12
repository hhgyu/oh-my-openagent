// Kernel-tools capability across the worker boundary (the S9d surface).
//
// The JS kernel publishes a live capability on codemode's own senpi `kernelToolsStorage` while a cell
// runs. That object lives in the codemode worker and cannot be cloned, so the worker keeps it in a table
// and hands the main thread only an id. The main thread gets a proxy with the capability's own shape
// (`capabilities`, `describe`, `invoke` with scope, signal and invoker); each call is a message back to the
// worker, which calls the real capability. Staleness stays codemode's: after a kernel reset the real
// `invoke` refuses with `kernel_tool_stale`, and that code reaches the caller unchanged.

import { CODEMODE_RPC, type CapabilityRef, type KernelToolInvokeRequest, type KernelToolScope } from "./codemode-worker-protocol"
import type { RpcPeer } from "./codemode-rpc"

type LiveCapability = {
  readonly capabilities?: { readonly invokeScope?: unknown }
  describe(names: readonly string[]): Promise<unknown>
  invoke(request: KernelToolInvokeRequest, options?: Record<string, unknown>): Promise<unknown>
}

function isLiveCapability(value: unknown): value is LiveCapability {
  return typeof value === "object" && value !== null
    && typeof (value as { describe?: unknown }).describe === "function"
    && typeof (value as { invoke?: unknown }).invoke === "function"
}

/** Refusal for an id the worker no longer holds (session released, worker restarted). */
class KernelCapabilityReleasedError extends Error {
  override readonly name = "KernelCapabilityReleasedError"
  readonly code = "kernel_capability_released"
}

export interface KernelToolInvokeOptions {
  readonly signal?: AbortSignal
  readonly scope?: KernelToolScope
  readonly invoker?: { readonly sessionId: string }
}

/** Worker side: live capabilities by id, deduplicated per object, dropped with their session. */
export function createKernelCapabilityTable() {
  const byId = new Map<string, { readonly sessionID: string; readonly capability: LiveCapability }>()
  const ids = new WeakMap<object, string>()
  let next = 0
  const live = (id: string): LiveCapability => {
    const entry = byId.get(id)
    if (!entry) throw new KernelCapabilityReleasedError(`kernel tools capability ${id} is no longer held; its eval session was released`)
    return entry.capability
  }
  return {
    register(sessionID: string, value: unknown): CapabilityRef | undefined {
      if (!isLiveCapability(value)) return undefined
      let id = ids.get(value)
      if (!id || !byId.has(id)) {
        id = `cap_${++next}`
        ids.set(value, id)
        byId.set(id, { sessionID, capability: value })
      }
      return { id, invokeScope: value.capabilities?.invokeScope === true }
    },
    invoke(id: string, request: KernelToolInvokeRequest, options: KernelToolInvokeOptions): Promise<unknown> {
      return live(id).invoke(request, {
        ...(options.signal && { signal: options.signal }),
        ...(options.scope && { scope: options.scope }),
        ...(options.invoker && { invoker: options.invoker }),
      })
    },
    describe(id: string, names: readonly string[]): Promise<unknown> {
      return live(id).describe(names)
    },
    releaseSession(sessionID: string): void {
      for (const [id, entry] of byId) if (entry.sessionID === sessionID) byId.delete(id)
    },
    clear(): void { byId.clear() },
    size: () => byId.size,
  }
}

/** Main side: what an owned host tool receives as `kernelTools`. */
export interface KernelToolsCapabilityProxy {
  readonly capabilityId: string
  /** The session whose cell captured the capability. */
  readonly ownerSessionID: string
  readonly capabilities: { readonly invokeScope: boolean }
  describe(names: readonly string[], options?: { readonly signal?: AbortSignal }): Promise<unknown>
  invoke(request: KernelToolInvokeRequest, options?: KernelToolInvokeOptions): Promise<unknown>
}

export function createKernelToolsCapabilityProxy(peer: RpcPeer, ref: CapabilityRef, ownerSessionID: string): KernelToolsCapabilityProxy {
  return Object.freeze({
    capabilityId: ref.id,
    ownerSessionID,
    capabilities: Object.freeze({ invokeScope: ref.invokeScope }),
    describe(names: readonly string[], options: { readonly signal?: AbortSignal } = {}) {
      return peer.call(CODEMODE_RPC.capabilityDescribe, { capabilityId: ref.id, names: [...names] }, options.signal ? { signal: options.signal } : {})
    },
    invoke(request: KernelToolInvokeRequest, options: KernelToolInvokeOptions = {}) {
      const params = { capabilityId: ref.id, request, ...(options.scope && { scope: options.scope }), ...(options.invoker && { invoker: options.invoker }) }
      return peer.call(CODEMODE_RPC.capabilityInvoke, params, options.signal ? { signal: options.signal } : {})
    },
  })
}
