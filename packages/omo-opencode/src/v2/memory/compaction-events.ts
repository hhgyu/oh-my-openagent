import type { Context } from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import { describeError } from "./binding"
import type { MemoryLogger } from "./config"

/** OpenCode 2 persists `ended` only after accepting the summary; `failed` is a separate event. */
export function observeAcceptedCompactions(
  events: Context["event"],
  accept: (sessionID: string) => Promise<void>,
  logger: MemoryLogger,
): Registration {
  const stop = new AbortController()
  const work = (async () => {
    try {
      for await (const event of events.subscribe({ types: ["session.compaction.ended"], signal: stop.signal })) {
        if (stop.signal.aborted) break
        if (event.type !== "session.compaction.ended") continue
        try { await accept(event.data.sessionID) } catch (error) {
          logger.warn("memory accepted-compaction handling failed", { sessionID: event.data.sessionID, error: describeError(error) })
        }
      }
    } catch (error) {
      if (!stop.signal.aborted) logger.warn("memory compaction event stream failed", { error: describeError(error) })
    }
  })()
  return { async dispose() { stop.abort(); await work } }
}
