import { AsyncLocalStorage } from "node:async_hooks"
import { createHash, randomUUID } from "node:crypto"
import { InputUncertainError } from "@oh-my-opencode/senpi-task/manager-kernel"
import { SessionBackendError, type ChildHandle, type createSessionBackend } from "../../host/session-backend"

type Backend = Pick<ReturnType<typeof createSessionBackend>, "promptContinuation">
type Identity = { readonly clientMessageId: string }

/** A client-supplied SDK inbox ID, not a host execution identifier. Owner/generation are
 * deliberately excluded: recovery must never mint a replacement for the same semantic input. */
export function ownedInputID(child: ChildHandle["locator"], nativeID: string): string {
  if (!nativeID || typeof nativeID !== "string") throw new Error("Input identity must be nonempty")
  return `msg_omo_${createHash("sha256").update(JSON.stringify([child.backendID, child.location, child.parentID, child.sessionID, nativeID])).digest("hex")}`
}

export function createOwnedManagedInput(options: {
  backend: Backend; child: ChildHandle;
  assertOwned(): void;
  expectInput(id: string): void;
  identify(nativeID: string): void;
  synchronize(): Promise<void>;
  onUncertain(error: InputUncertainError): void;
}) {
  const invocation = new AsyncLocalStorage<AbortSignal | undefined>()
  const pending = new Map<Promise<void>, AbortController>()
  let failure: InputUncertainError | undefined, closed = false
  let last: { nativeID: string; hostID: string; disposition: "pending" | "accepted" | "uncertain" } | undefined
  const uncertain = (nativeID: string, cause: unknown, reason: string) => {
    const error = new InputUncertainError(nativeID, cause instanceof Error ? cause : new Error(String(cause)))
    // Preserve the canonical constructor while stating actual owned-host facts, not an RPC deadline.
    error.message = `${reason}; delivery/argument equivalence is unconfirmed. This input is not resent.`
    failure ??= error
    options.onUncertain(error)
    return error
  }
  return {
    withSignal<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> { return invocation.run(signal, operation) },
    send(text: string, delivery: "steer" | "queue", identity?: Identity): Promise<void> {
      if (closed) return Promise.reject(new Error("Owned input port retired"))
      if (failure) return Promise.reject(failure)
      const nativeID = identity?.clientMessageId ?? `owned-input:${randomUUID()}`
      const hostID = ownedInputID(options.child.locator, nativeID)
      // Queued Native entries are already durably accepted. They must not inherit an unrelated
      // later caller's signal while the manager drains them in another operation's async context.
      const signal = identity === undefined ? invocation.getStore() : undefined
      signal?.throwIfAborted()
      options.assertOwned()
      options.identify(nativeID)
      options.expectInput(hostID)
      const controller = new AbortController()
      last = { nativeID, hostID, disposition: "pending" }
      const work = (async () => {
        let answered = false
        try {
          await options.backend.promptContinuation(options.child, { id: hostID, text, delivery, resume: true },
            { signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]) })
          answered = true
          await options.synchronize()
          options.assertOwned()
          last = { nativeID, hostID, disposition: "accepted" }
        } catch (cause) {
          // Refresh only through the actual owner fence; losing it never authorizes a foreign write.
          try { await options.synchronize() } catch { /* Existing outcome custody checks preserve local refusal. */ }
          last = { nativeID, hostID, disposition: "uncertain" }
          if (answered || cause instanceof SessionBackendError && (cause.code === "uncertain" || cause.code === "state")) {
            throw uncertain(nativeID, cause, answered ? "Admission ACK was observed but its local checkpoint could not be confirmed" : "Owned input admission or reserved identity could not be safely confirmed")
          }
          throw uncertain(nativeID, cause, "Owned input dispatch did not finish under its verified custody")
        }
      })()
      pending.set(work, controller)
      void work.finally(() => pending.delete(work)).catch(() => {})
      return work
    },
    hasPending() { return pending.size > 0 },
    settled(): Promise<void> { return Promise.allSettled([...pending.keys()]).then(() => {}) },
    abortPending(): Promise<void> {
      for (const controller of pending.values()) controller.abort(new Error("Owned input request stopped by its control owner"))
      return Promise.allSettled([...pending.keys()]).then(() => {})
    },
    async close() { closed = true; for (const controller of pending.values()) controller.abort(new Error("Owned input port closed")); await Promise.allSettled([...pending.keys()]) },
    diagnostics() { return { pending: pending.size, closed, ...(last ? { last: { ...last } } : {}), ...(failure ? { uncertainEffectID: failure.effectId } : {}) } },
  }
}
