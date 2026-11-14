import type * as Plugin from "@opencode/plugin/promise/plugin"

export type ThreadV2Host = Pick<Plugin.Context, "session" | "permission" | "event" | "model" | "provider" | "location">

export type V2SessionInfo = Awaited<ReturnType<ThreadV2Host["session"]["get"]>>

type Session = ThreadV2Host["session"]

/** The session and catalog calls a thread's control makes, on this server or through a peer server. */
export type ControlHost = {
  readonly session: {
    readonly get: (input: { sessionID: string }) => Promise<V2SessionInfo>
    readonly interrupt: (input: { sessionID: string; resume?: boolean }) => Promise<{ readonly interrupted: boolean }>
    readonly update: (input: Parameters<Session["update"]>[0]) => Promise<void>
    readonly switchModel: (input: Parameters<Session["switchModel"]>[0]) => Promise<void>
    readonly context: (input: { sessionID: string }) => Promise<Awaited<ReturnType<Session["context"]>>>
  }
  readonly model: { readonly list: () => ReturnType<ThreadV2Host["model"]["list"]> }
  readonly provider: { readonly list: () => ReturnType<ThreadV2Host["provider"]["list"]> }
}

export type V2SessionPhase = "idle" | "mid_turn" | "waiting_question" | "compacting"

export type V2SessionSnapshot = {
  readonly phase: V2SessionPhase
  readonly epoch: number
}

/** `time.busy` marks the start of the most recent execution; while it runs `time.idle` still holds the previous end. */
export function executionEpoch(info: V2SessionInfo): number {
  const busy = info.time.busy
  return busy === undefined ? 0 : Number(busy)
}

export function isExecuting(info: V2SessionInfo): boolean {
  const busy = info.time.busy
  if (busy === undefined) return false
  const idle = info.time.idle
  return idle === undefined || Number(busy) > Number(idle)
}

/** Metadata key of a thread closed through `thread_close`; the host keeps the session, so the thread stays resumable. */
export const THREAD_CLOSED_METADATA_KEY = "omoThreadClosed"

/** Closed: archived by a person, or closed by a thread tool and not run since. Either way it is not live. */
export function isClosed(info: V2SessionInfo): boolean {
  return info.time.archived !== undefined || info.metadata?.[THREAD_CLOSED_METADATA_KEY] !== undefined
}

/** Writes one metadata key (null removes it); the host replaces `metadata` as sent, so the other keys are resent. */
export async function writeSessionMetadata(
  session: Pick<ControlHost["session"], "get" | "update">,
  sessionID: string,
  key: string,
  value: string | null,
): Promise<void> {
  const current = { ...((await session.get({ sessionID })).metadata ?? {}) }
  if (value === null) {
    if (!(key in current)) return
    delete current[key]
  } else current[key] = value
  await session.update({ sessionID, metadata: current })
}
