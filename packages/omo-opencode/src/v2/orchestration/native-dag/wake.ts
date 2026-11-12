import { createHash } from "node:crypto"
import { DagManagerError, type DagRunId, type DagRunRecordV1 } from "@oh-my-opencode/senpi-task/dag"
import { openDagDeliveryJournal, type DagDeliveryJournal } from "../../host/dag-delivery-journal"
import type { TeamDeliverySession } from "../native-team/lead-delivery"
import type { NativeDagRuntime } from "./runtime"
import { dagWakeInputId, projectDagWake, type DagWakeChild } from "./wake-projection"

export interface DagWakeOptions {
  /** The joined `session.get` and gated `session.synthetic` route; never a raw prompt. */
  readonly session: TeamDeliverySession
  readonly directory: string
  /** Throws once the component generation is retired. */
  readonly assertGeneration: () => void
  /** Trusted private journal path in the root's own Native state directory. */
  readonly journalPathFor: (rootSessionID: string) => string
  /** The root's existing DAG runtime, never a new one. */
  readonly runtimeFor: (rootSessionID: string) => Pick<NativeDagRuntime, "manager" | "isDriving"> | undefined
  /** The persisted status and run epoch of one of the root's child tasks, read without any call authority. */
  readonly childState: (rootSessionID: string, taskId: string) => DagWakeChild | undefined
  /** Background tick period; 0 disables the timer (wakes then run only on `refresh`). */
  readonly pollIntervalMs?: number
  readonly onError?: (error: unknown) => void
}
export interface DagWakeOwner {
  /** A call stopped driving `runId` of `rootSessionID`: watch it until it is terminal or gone. */
  arm(rootSessionID: string, runId: string): void
  /** Runs one serialized wake pass over every armed run now, then retires journal rows of gone runs. */
  refresh(): Promise<void>
  close(): Promise<void>
}

const TERMINAL_RUN: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])

/** Component-owned run wake of detached `workflow` runs (Native `dag-wake`, OpenCode 2 edition).
 * AUTHORITY: a wake is a NOTIFICATION, never an admission. It starts no node and stores no call: it
 * tells the root session that a node it admitted settled, with `resume: true`, so the model's next
 * `workflow` call admits the next wave under that call's own authority.
 * ONE WAKE PER TRANSITION: nodes run attached (`notify_on_terminal` off), so no per-node notice
 * exists. The journal holds one row per (run, checkpoint seq): settles that land before the model
 * acts share the checkpoint and coalesce into its one wake; a call that folds them advances the
 * checkpoint, and only then can a later settle wake again. The wake's host id is derived from its
 * CONTENT (the settles it reports, or the terminal generation), and content already journaled for
 * the run at an earlier checkpoint keeps that row: a checkpoint that advanced without a fold (a
 * steer) never re-announces an ACKed settle (D-3), while new content gets a new id.
 * Before EVERY delivery the owner re-checks: the component generation is current; no call drives the
 * run; the run still exists, is owned by this root and is not terminal; its checkpoint is unchanged;
 * the wake is not ACKed; `session.get(root)` succeeds in this directory. A failed check posts nothing. */
export function createNativeDagWakeOwner(options: DagWakeOptions): DagWakeOwner {
  const armed = new Map<string, string>(),
    journals = new Map<string, DagDeliveryJournal>()
  const transportStop = new AbortController()
  const note = (error: unknown) => {
    options.onError?.(error)
  }
  let closed = false,
    chain: Promise<void> = Promise.resolve()
  function journalFor(root: string): DagDeliveryJournal {
    let journal = journals.get(root)
    if (!journal) {
      journal = openDagDeliveryJournal({
        path: options.journalPathFor(root),
        namespace:
          "opencode2-dag:" +
          createHash("sha256")
            .update(JSON.stringify([options.directory, root]))
            .digest("hex"),
      })
      journals.set(root, journal)
    }
    return journal
  }
  /** The run's record when it still exists and is owned by `root`; undefined when it is gone or foreign. */
  function ownedRecord(
    runtime: Pick<NativeDagRuntime, "manager">,
    root: string,
    runId: string,
  ): DagRunRecordV1 | undefined {
    try {
      const record = runtime.manager.record(runId as DagRunId, root)
      return record.rootSessionId === root ? record : undefined
    } catch (error) {
      if (error instanceof DagManagerError) return undefined
      throw error
    }
  }
  async function authorized(
    root: string,
    runtime: Pick<NativeDagRuntime, "manager" | "isDriving">,
    runId: string,
    seq: number,
  ): Promise<boolean> {
    try {
      options.assertGeneration()
      if (closed || runtime.isDriving(runId)) return false
      const actual = await options.session.get({ sessionID: root }, { signal: transportStop.signal })
      options.assertGeneration()
      if (closed || actual.id !== root || actual.location.directory !== options.directory || runtime.isDriving(runId))
        return false
      const again = ownedRecord(runtime, root, runId)
      return again !== undefined && again.checkpointSeq === seq && !TERMINAL_RUN.has(again.status)
    } catch (error) {
      note(error)
      return false
    }
  }
  async function check(runId: string, root: string): Promise<void> {
    const runtime = options.runtimeFor(root)
    if (!runtime) {
      armed.delete(runId)
      return
    }
    if (runtime.isDriving(runId)) return
    const record = ownedRecord(runtime, root, runId)
    if (!record || TERMINAL_RUN.has(record.status)) {
      armed.delete(runId)
      return
    }
    const decision = projectDagWake(record, (taskId) => options.childState(root, taskId))
    if (!decision) return
    const journal = journalFor(root),
      key = { runId, seq: record.checkpointSeq }
    const inputID = dagWakeInputId(
      runId,
      decision.kind === "finished" ? { terminalGeneration: record.generation } : { settled: decision.settled },
    )
    // This checkpoint's row coalesces later settles into its first wake; without one, the same
    // content journaled at an earlier checkpoint keeps its one delivery under its own id.
    const existing = journal.read(key) ?? journal.findInput(runId, inputID)
    if (existing?.phase === "acked" || !(await authorized(root, runtime, runId, key.seq))) return
    const intent =
      existing ??
      journal.recordIntent(key, { kind: decision.kind, receiverSessionID: root, text: decision.text, inputID })
    // Last same-stack fence before transport.
    options.assertGeneration()
    if (closed || runtime.isDriving(runId)) return
    const result = await options.session.synthetic(
      {
        sessionID: root,
        id: intent.inputID,
        text: intent.text,
        delivery: "steer",
        resume: true,
        metadata: { omoDagRunId: runId, omoDagSeq: String(intent.seq), omoDagWake: intent.kind },
      },
      { signal: transportStop.signal },
    )
    if (
      result.id !== intent.inputID ||
      result.sessionID !== root ||
      result.type !== "synthetic" ||
      result.payload.text !== intent.text
    )
      throw Error("Foreign DAG wake ACK")
    journal.markAcked(intent, { id: result.id, sessionID: result.sessionID })
  }
  /** Journal rows of a run that no longer exists (retention removed it) are retired. */
  function sweep(): void {
    for (const [root, journal] of journals) {
      const runtime = options.runtimeFor(root)
      if (!runtime) continue
      for (const runId of journal.listRuns()) {
        if (!armed.has(runId) && ownedRecord(runtime, root, runId) === undefined) journal.dropRun(runId)
      }
    }
  }
  async function pass(): Promise<void> {
    if (closed) return
    try {
      options.assertGeneration()
    } catch (error) {
      note(error)
      return
    }
    for (const [runId, root] of [...armed]) {
      if (closed) return
      await check(runId, root).catch(note)
    }
    try {
      sweep()
    } catch (error) {
      note(error)
    }
  }
  function refresh(): Promise<void> {
    if (closed) return Promise.resolve()
    chain = chain.then(pass).catch(note)
    return chain
  }
  const interval = options.pollIntervalMs ?? 1000
  const timer =
    interval > 0
      ? setInterval(() => {
          if (armed.size > 0) void refresh()
        }, interval)
      : undefined
  timer?.unref?.()
  return {
    arm(root, runId) {
      if (closed) return
      armed.set(runId, root)
      void refresh()
    },
    refresh,
    async close() {
      if (closed) return
      closed = true
      if (timer) clearInterval(timer)
      transportStop.abort(Error("DAG wake owner closed"))
      armed.clear()
      await chain.catch(note)
      for (const journal of journals.values()) journal.close()
      journals.clear()
    },
  }
}
