import type { CompletionOutcome } from "@oh-my-opencode/thread-core/gateway/bindings"
import {
  createRunContext,
  noteAssistantMessage,
  noteRunInput,
  noteRunSettled,
  type RunContext,
  type RunInput,
} from "@oh-my-opencode/thread-core/run-context"
import { executionEpoch, isExecuting, type ThreadV2Host, type V2SessionSnapshot } from "./host"
import { THREAD_DELIVERY_METADATA_KEY, deliveryRunInput } from "./delivery-metadata"

export type SessionStateListener = {
  readonly onSettled?: (sessionID: string, outcome: CompletionOutcome) => void
  readonly onReleased?: (sessionID: string) => void
  readonly onStarted?: (sessionID: string) => void
}

export type SessionStateTracker = {
  readonly snapshot: (sessionID: string) => Promise<V2SessionSnapshot>
  readonly run: (sessionID: string) => RunContext
  readonly start: (listener: SessionStateListener) => void
  readonly close: () => Promise<void>
}

const TRACKED_EVENTS = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.ended",
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.compaction.started",
  "session.compaction.ended",
  "session.compaction.failed",
  "permission.replied",
  "session.deleted",
] as const

/** A person's prompt, one of our deliveries (named by its metadata), or any other host message such as team mail. */
function inboxRunInput(item: unknown): RunInput | undefined {
  const { type, payload } = (item ?? {}) as {
    readonly type?: unknown
    readonly payload?: { readonly metadata?: unknown }
  }
  if (type === "user") return { kind: "user" }
  if (type !== "synthetic") return undefined
  const metadata = payload?.metadata as Record<string, unknown> | undefined
  return deliveryRunInput(metadata?.[THREAD_DELIVERY_METADATA_KEY]) ?? { kind: "engine" }
}

type TrackedEvent = { readonly type: string; readonly data: Record<string, unknown> & { readonly sessionID: string } }

/**
 * The receiver-side facts the gateway reads about OpenCode sessions: the phase a delivery is decided against
 * (approval and compaction from the host's own state, execution from `time.busy`/`time.idle`), and the run
 * context of each session (which deliveries its current answer is for, who may be answered without a prompt).
 */
export function createSessionStateTracker(host: Pick<ThreadV2Host, "session" | "permission" | "event">) {
  const runs = new Map<string, RunContext>()
  const compacting = new Set<string>()
  const inputs = new Map<string, RunInput>()
  const stop = new AbortController()
  let pump: Promise<void> | undefined

  function run(sessionID: string): RunContext {
    let current = runs.get(sessionID)
    if (current === undefined) {
      current = createRunContext()
      runs.set(sessionID, current)
    }
    return current
  }

  async function snapshot(sessionID: string): Promise<V2SessionSnapshot> {
    const [info, pending] = await Promise.all([
      host.session.get({ sessionID }),
      host.permission.list({ sessionID }).catch(() => []),
    ])
    const epoch = executionEpoch(info)
    if (compacting.has(sessionID)) return { phase: "compacting", epoch }
    if (pending.length > 0) return { phase: "waiting_question", epoch }
    return { phase: isExecuting(info) ? "mid_turn" : "idle", epoch }
  }

  function note(sessionID: string, input: RunInput): void {
    noteRunInput(run(sessionID), input)
  }

  function handle(event: TrackedEvent, listener: SessionStateListener): void {
    const sessionID = event.data.sessionID
    switch (event.type) {
      case "session.execution.started":
        run(sessionID).turn++
        listener.onStarted?.(sessionID)
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        noteRunSettled(run(sessionID))
        const outcome: CompletionOutcome =
          event.type === "session.execution.succeeded"
            ? "completed"
            : event.type === "session.execution.failed"
              ? "failed"
              : "cancelled"
        listener.onSettled?.(sessionID, outcome)
        return
      }
      case "session.step.ended":
        noteAssistantMessage(run(sessionID), event.data["finish"] === "tool-calls")
        return
      case "session.inbox.enqueued": {
        const input = inboxRunInput(event.data["item"])
        if (input !== undefined) inputs.set(String(event.data["inboxID"]), input)
        return
      }
      case "session.inbox.delivered": {
        const inboxID = String(event.data["inboxID"])
        const input = inputs.get(inboxID)
        inputs.delete(inboxID)
        if (input !== undefined) note(sessionID, input)
        return
      }
      case "session.compaction.started":
        compacting.add(sessionID)
        return
      case "session.compaction.ended":
      case "session.compaction.failed":
        compacting.delete(sessionID)
        listener.onReleased?.(sessionID)
        return
      case "permission.replied":
        listener.onReleased?.(sessionID)
        return
      case "session.deleted":
        runs.delete(sessionID)
        compacting.delete(sessionID)
        return
    }
  }

  return {
    snapshot,
    run,
    start(listener: SessionStateListener) {
      if (pump) return
      pump = (async () => {
        try {
          for await (const event of host.event.subscribe({ types: [...TRACKED_EVENTS], signal: stop.signal }))
            handle(event as unknown as TrackedEvent, listener)
        } catch (error) {
          if (!stop.signal.aborted) console.warn("[oh-my-openagent/v2] thread session event stream failed", error)
        }
      })()
    },
    async close() {
      stop.abort(Error("thread session tracker closed"))
      if (pump) await pump
      runs.clear()
      compacting.clear()
      inputs.clear()
    },
  } satisfies SessionStateTracker
}
