import { describeError, type BoundMemorySession } from "./binding"
import type { MemoryLogger } from "./config"

const SHUTDOWN_DRAIN_BUDGET_MS = 1500

export async function drainFinalFacts(input: {
  readonly sessions: readonly BoundMemorySession[]
  readonly flush: (bound: BoundMemorySession, signal: AbortSignal) => Promise<unknown>
  readonly enqueue: (bound: BoundMemorySession, signal: AbortSignal) => Promise<void>
  readonly logger: MemoryLogger
}): Promise<void> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      input.logger.warn("facts shutdown drain hit its budget", { budgetMs: SHUTDOWN_DRAIN_BUDGET_MS })
      resolve()
    }, SHUTDOWN_DRAIN_BUDGET_MS)
  })
  const work = Promise.all(input.sessions.map(async bound => {
    try {
      await input.flush(bound, controller.signal)
      if (!controller.signal.aborted) await input.enqueue(bound, controller.signal)
    } catch (error) {
      input.logger.warn("facts shutdown final delta deferred to next bind", { sessionID: bound.sessionID, error: describeError(error) })
    }
  }))
  try {
    await Promise.race([work, expired])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
  }
}
