import type { TaskRecord } from "@oh-my-opencode/senpi-task/manager-kernel"
import type { SessionLease } from "../../host/session-state"

/** Inert record relationships are evidence to verify, never a live session capability. */
export function ownedAncestorPath(rootID: string, records: readonly TaskRecord[], sessionID: string, allowStopped = false): readonly TaskRecord[] {
  const path: TaskRecord[] = [], visited = new Set<string>()
  let current = sessionID
  while (current !== rootID) {
    if (visited.has(current)) throw Error("Owned ancestry cycle")
    visited.add(current)
    const matches = records.filter(record => record.child_session_id === current)
    if (matches.length !== 1) throw Error("Owned ancestry missing or ambiguous")
    const record = matches[0], ref = record.owned_session
    if (!ref || record.root_session_id !== rootID || ref.sessionID !== current || ref.parentID !== record.parent_session_id
      || ref.runEpoch !== record.notification.run_epoch || ref.residencyClaim !== record.residency_claim
      || !allowStopped && (record.killed || record.status === "cancelled" || record.status === "lost") || !Number.isSafeInteger(record.depth) || record.depth < 1) throw Error("Owned ancestry record identity differs")
    path.push(record); current = record.parent_session_id
    // Each hop consumes a distinct actual record, so an allowed deep Native agent has no new fixed depth cap.
    if (path.length > records.length) throw Error("Owned ancestry exceeds its record index")
  }
  for (let i = 0; i < path.length; i++) if (path[i].depth !== (path[i + 1]?.depth ?? 0) + 1) throw Error("Owned ancestry depth differs")
  return path
}

export interface OwnedAncestry {
  path(sessionID: string): readonly TaskRecord[]
  verify(sessionID: string, signal?: AbortSignal): Promise<{ readonly rootSessionId: string; readonly depth: number; readonly rows: readonly TaskRecord[]; assertCurrent(): void }>
}

export function createOwnedAncestry(options: {
  root: SessionLease; directory: string; hostVersion: string; records(): readonly TaskRecord[];
  get(sessionID: string, signal?: AbortSignal): Promise<{ readonly id: string; readonly parentID?: string | null; readonly location: { readonly directory: string } }>;
  assertControl(record: TaskRecord): void; assertRoot(): void;
}): OwnedAncestry {
  function path(sessionID: string) { options.assertRoot(); return ownedAncestorPath(options.root.sessionID, options.records(), sessionID) }
  // Only relationships and admission eligibility are fenced. Progress, display and
  // model/stat updates do not invalidate otherwise identical owned ancestry.
  function admissionFence(row: TaskRecord): string {
    const ownedIdentity = row.owned_session && { ...row.owned_session, journalRevision: undefined }
    return JSON.stringify([row.task_id, row.root_session_id, row.parent_session_id, row.child_session_id,
      row.depth, row.status === "cancelled" || row.status === "lost", row.killed === true, row.residency_state, row.host_pid, row.runner_kind,
      row.execution_mode, row.notification.run_epoch, row.residency_claim, ownedIdentity, row.cancel_requested])
  }
  function assertPath(sessionID: string, captured: readonly { readonly identity: string; minimumRevision: number }[]) {
    options.assertRoot()
    let rows: readonly TaskRecord[]
    try { rows = ownedAncestorPath(options.root.sessionID, options.records(), sessionID) }
    catch { throw Error("Owned ancestry changed during verification") }
    if (rows.length !== captured.length) throw Error("Owned ancestry changed during verification")
    for (const [index, row] of rows.entries()) {
      if (row.owned_session?.format !== 1 || row.owned_session.backendID !== "omo-native-task-opencode" || row.owned_session.location !== options.directory || row.owned_session.hostVersion !== options.hostVersion) throw Error("Owned ancestry host binding differs")
      const revision = row.owned_session.journalRevision
      if (admissionFence(row) !== captured[index].identity || !Number.isSafeInteger(revision)
        || revision < captured[index].minimumRevision) throw Error("Owned ancestry changed during verification")
      // The actual current private control/backend must corroborate this reference,
      // including its revision. A raw file-only increment is not progress evidence.
      options.assertControl(row)
    }
    for (const [index, row] of rows.entries()) captured[index].minimumRevision = row.owned_session!.journalRevision
  }
  return {
    path,
    async verify(sessionID: string, signal?: AbortSignal) {
      signal?.throwIfAborted()
      // Copy the relationship-bearing values before the first await. A records port
      // may return mutable cached objects, so retaining their identity is not a fence.
      const rows = path(sessionID).map(row => Object.freeze({ ...row,
        notification: Object.freeze({ ...row.notification }),
        owned_session: row.owned_session && Object.freeze({ ...row.owned_session }),
      }))
      const captured = rows.map(row => ({ identity: admissionFence(row), minimumRevision: row.owned_session!.journalRevision }))
      const assertCurrent = () => assertPath(sessionID, captured)
      assertCurrent()
      for (const [index, id] of [...rows.map(row => row.child_session_id!), options.root.sessionID].entries()) {
        const actual = await options.get(id, signal)
        signal?.throwIfAborted(); assertCurrent()
        const expectedParent = rows[index]?.parent_session_id
        if (actual.id !== id || actual.location.directory !== options.directory || (expectedParent ? actual.parentID !== expectedParent : !!actual.parentID)) throw Error("Actual host ancestry differs from owned tree")
      }
      return { rootSessionId: options.root.sessionID, depth: rows[0]?.depth ?? 0, rows, assertCurrent }
    },
  }
}
