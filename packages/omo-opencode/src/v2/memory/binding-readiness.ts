import { describeError, type BoundMemorySession } from "./binding"
import type { MemoryLogger } from "./config"

/** A session's first settle must not overtake its journal and facts catch-up. */
export function createMemoryBindingReadiness(logger: MemoryLogger) {
  const bindings = new Map<
    string,
    { bound: BoundMemorySession; controller: AbortController; ready: Promise<boolean>; cancel: () => void }
  >()

  function forget(sessionID: string): void {
    const entry = bindings.get(sessionID)
    bindings.delete(sessionID)
    entry?.cancel()
  }

  function current(bound: BoundMemorySession): boolean {
    const entry = bindings.get(bound.sessionID)
    return entry?.bound === bound && !entry.controller.signal.aborted
  }

  return {
    current,
    forget,
    start(bound: BoundMemorySession, initialize: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
      forget(bound.sessionID)
      const controller = new AbortController()
      const cancelled = Promise.withResolvers<boolean>()
      const work = Promise.resolve()
        .then(() => {
          if (!controller.signal.aborted) return initialize(controller.signal)
        })
        .then(
          () => current(bound),
          (error: unknown) => {
            if (!controller.signal.aborted)
              logger.warn("memory binding recovery skipped", {
                sessionID: bound.sessionID,
                error: describeError(error),
              })
            return false
          },
        )
      const ready = Promise.race([work, cancelled.promise])
      bindings.set(bound.sessionID, {
        bound,
        controller,
        ready,
        cancel: () => {
          controller.abort()
          cancelled.resolve(false)
        },
      })
      return ready
    },
    wait(sessionID: string): Promise<boolean> {
      return bindings.get(sessionID)?.ready ?? Promise.resolve(false)
    },
    close(): void {
      for (const sessionID of bindings.keys()) forget(sessionID)
    },
  }
}
