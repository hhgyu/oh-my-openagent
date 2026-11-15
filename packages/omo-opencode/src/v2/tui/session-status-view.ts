import type { z } from "zod"

/**
 * A session-scoped RPC snapshot held for one TUI slot: `select` loads the session's snapshot, an
 * `updated` event for the selected session replaces it, and a late load never overwrites a newer event.
 */
export function createSessionStatusView<Snapshot extends { readonly sessionID: string }>(deps: {
  readonly schema: z.ZodType<Snapshot>
  readonly name: string
  readonly load: (sessionID: string, signal: AbortSignal) => Promise<unknown>
  readonly subscribe: (handler: (data: unknown) => void) => () => void
  readonly changed: () => void
}) {
  let current: Snapshot | undefined
  let sessionID: string | undefined
  let revision = 0
  let closed = false
  let request: AbortController | undefined
  const accept = (data: unknown): boolean => {
    const result = deps.schema.safeParse(data)
    if (closed || !result.success || result.data.sessionID !== sessionID) return false
    current = result.data
    deps.changed()
    return true
  }
  const unsubscribe = deps.subscribe((data) => {
    if (accept(data)) {
      revision++
      request?.abort()
    }
  })
  return {
    select(id: string): void {
      if (closed || sessionID === id) return
      request?.abort()
      sessionID = id
      current = undefined
      deps.changed()
      const token = ++revision
      const controller = new AbortController()
      request = controller
      void deps
        .load(id, controller.signal)
        .then((data) => {
          if (revision === token) accept(data)
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted && !closed)
            console.warn(`[oh-my-openagent/v2] ${deps.name} status unavailable`, String(error))
        })
    },
    snapshot: () => current,
    close(): void {
      closed = true
      revision++
      request?.abort()
      unsubscribe()
    },
  }
}
