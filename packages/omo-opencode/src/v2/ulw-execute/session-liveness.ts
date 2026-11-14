// Native repairs boulder works abandoned by dead sessions (#8413) with Senpi transcripts as the liveness proof.
// OpenCode 2 has none, so its sessions API proves an `opencode:` session alive instead: executing now
// (`time.busy` after `time.idle`), or the newest of `time.updated` / `time.idle`. Only the host's own "no such session"
// is proof of death; any other failure leaves the work alone. Ids of other hosts keep their recorded activity only,
// as Native treats `opencode:` ids.
import { sessionsAwaitingLivenessProof, type ReconcileStaleWorksOptions } from "@oh-my-opencode/boulder-state"
import type * as Plugin from "@opencode/plugin/promise/plugin"
import { isHostSessionAbsent } from "../host/session-absence"

const OPENCODE_PREFIX = "opencode:"

export type SessionReader = Pick<Plugin.Context["session"], "get">

export async function proveSessionLiveness(
  session: SessionReader,
  directory: string,
  isLive: (sessionID: string) => boolean,
  now: number = Date.now(),
): Promise<ReconcileStaleWorksOptions> {
  const activity = new Map<string, number>()
  for (const id of sessionsAwaitingLivenessProof(directory, { now })) {
    if (!id.startsWith(OPENCODE_PREFIX)) continue
    const sessionID = id.slice(OPENCODE_PREFIX.length)
    const proven = isLive(sessionID) ? now : await sessionActivityMs(session, sessionID, now)
    if (proven !== null) activity.set(id, proven)
  }
  return {
    now,
    sessionActivityMs: (sessionIds) => {
      const proofs = sessionIds.flatMap((id) => activity.get(id) ?? [])
      return proofs.length === 0 ? null : Math.max(...proofs)
    },
  }
}

async function sessionActivityMs(session: SessionReader, sessionID: string, now: number): Promise<number | null> {
  try {
    const { time } = await session.get({ sessionID })
    if (time.busy !== undefined && (time.idle === undefined || time.busy > time.idle)) return now
    return Math.max(time.updated, time.idle ?? 0)
  } catch (error) {
    return isHostSessionAbsent(error, sessionID) ? null : now
  }
}
