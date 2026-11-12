import { Database, constants } from "../../shared/bun-sqlite-shim"
import { z } from "zod"
import { resolveTrustedChildStatePath } from "./child-journal"

const applicationID = 0x4f4d4f44
const text = z.string().min(1).max(4096)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const keySchema = z.object({ runId: text, seq: integer }).strict()
const ackSchema = z.object({ id: text, sessionID: text }).strict()
const recordSchema = keySchema.extend({
  kind: z.enum(["frontier", "finished"]),
  receiverSessionID: text,
  /** The deterministic host message id every attempt of this wake posts with. */
  inputID: text.refine(value => value.startsWith("msg_omo_dag_"), "DAG wake input id must be a DAG host message id"),
  /** The exact wake text; a redelivery re-posts it unchanged so the host's dedup answer matches. */
  text: z.string().min(1).max(16384),
  revision: integer,
  phase: z.enum(["intent", "acked"]),
  ack: ackSchema.optional(),
}).strict()
type ReadonlyData<T> = T extends object ? { readonly [K in keyof T]: ReadonlyData<T[K]> } : T
export type DagDeliveryKey = ReadonlyData<z.infer<typeof keySchema>>
export type DagDeliveryRecord = ReadonlyData<z.infer<typeof recordSchema>>
export type DagDeliveryIntent = Pick<DagDeliveryRecord, "kind" | "receiverSessionID" | "inputID" | "text">

export interface DagDeliveryJournalOptions {
  /** Private application state, never a model-supplied database path. */
  readonly path: string
  /** Fixed trusted project and root namespace. */
  readonly namespace: string
}
export interface DagDeliveryJournal {
  /** Durable intent BEFORE transport. One row per (run, checkpoint seq): an existing row is returned
   * unchanged, so a retry reuses the SAME input id and text, and settles that arrive before the model
   * acts never add a second wake for the same checkpoint. */
  recordIntent(key: DagDeliveryKey, intent: DagDeliveryIntent): DagDeliveryRecord
  /** Records the genuine synthetic ACK of an intent. Compare-and-set on the exact intent row. */
  markAcked(intent: DagDeliveryRecord, ack: { readonly id: string; readonly sessionID: string }): DagDeliveryRecord
  read(key: DagDeliveryKey): DagDeliveryRecord | undefined
  /** The run's row (any checkpoint) that carries `inputID`, so one wake's content keeps ONE delivery
   * across checkpoints; an acked row wins over an intent. */
  findInput(runId: string, inputID: string): DagDeliveryRecord | undefined
  /** Every run with a row, for retirement once the run is gone. */
  listRuns(): string[]
  /** Forgets a run that no longer exists. */
  dropRun(runId: string): void
  close(): void
}
class DagDeliveryJournalError extends Error { override readonly name = "DagDeliveryJournalError" }
function fail(message: string): never { throw new DagDeliveryJournalError(message) }

function validate(input: unknown): DagDeliveryRecord {
  const parsed = recordSchema.safeParse(input)
  if (!parsed.success) fail("Invalid DAG delivery record")
  const value = parsed.data
  if ((value.phase === "acked") !== (value.ack !== undefined)) fail("Invalid DAG delivery acceptance state")
  if (value.ack && (value.ack.id !== value.inputID || value.ack.sessionID !== value.receiverSessionID)) fail("DAG delivery ACK differs from its intent")
  return Object.freeze({ ...value, ...(value.ack && { ack: Object.freeze({ ...value.ack }) }) })
}

/** Inert durable state only: neither an intent nor an ACK row is authority. Exclusive custody of a
 * root's wakes comes from the one component-owned wake owner of this plugin generation, which
 * serializes its passes. No transport is performed here. */
export function openDagDeliveryJournal(options: DagDeliveryJournalOptions): DagDeliveryJournal {
  const namespace = text.parse(options.namespace)
  const path = resolveTrustedChildStatePath(options.path)
  if (typeof constants.SQLITE_OPEN_NOFOLLOW !== "number") fail("SQLite no-follow open support is unavailable")
  const db = new Database(path, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_NOFOLLOW)
  let closed = false
  try {
    db.exec("PRAGMA busy_timeout=2000")
    const app = (db.query("PRAGMA application_id").get() as { application_id: number }).application_id
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
    const fresh = app === 0 && version === 0 && db.query("SELECT name FROM sqlite_master").all().length === 0
    if (!fresh && (app !== applicationID || version !== 1)) fail("Foreign or unsupported DAG delivery journal database")
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL")
    db.transaction(() => {
      db.exec(`PRAGMA application_id=${applicationID}; PRAGMA user_version=1`)
      db.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS wakes (run_id TEXT NOT NULL, seq INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (run_id, seq))")
      if (fresh) db.query("INSERT INTO metadata VALUES ('namespace',?)").run(namespace)
      if ((db.query<{ value: string }, []>("SELECT value FROM metadata WHERE key='namespace'").get())?.value !== namespace) fail("Foreign DAG delivery journal namespace")
    }).immediate()
  } catch (error) { db.close(); throw error }

  function active(): void { if (closed) fail("DAG delivery journal is closed") }
  function parseKey(key: DagDeliveryKey): DagDeliveryKey {
    const parsed = keySchema.safeParse({ runId: key.runId, seq: key.seq })
    if (!parsed.success) fail("Invalid DAG delivery key")
    return parsed.data
  }
  function readChecked(key: DagDeliveryKey): DagDeliveryRecord | undefined {
    const row = db.query<{ body: string }, [string, number]>("SELECT body FROM wakes WHERE run_id=? AND seq=?").get(key.runId, key.seq)
    if (!row) return undefined
    let value: DagDeliveryRecord
    try { value = validate(JSON.parse(row.body)) } catch { return fail("Corrupt DAG delivery record") }
    if (value.runId !== key.runId || value.seq !== key.seq) fail("DAG delivery key mismatch")
    return value
  }
  return {
    recordIntent(input, intent) {
      active()
      const key = parseKey(input)
      const value = validate({ ...key, kind: intent.kind, receiverSessionID: intent.receiverSessionID, inputID: intent.inputID, text: intent.text, revision: 0, phase: "intent" })
      return db.transaction(() => {
        const existing = readChecked(key)
        if (existing) {
          if (existing.receiverSessionID !== value.receiverSessionID) fail("DAG delivery intent belongs to another root")
          return existing
        }
        db.query("INSERT INTO wakes VALUES (?,?,?)").run(key.runId, key.seq, JSON.stringify(value))
        return value
      }).immediate()
    },
    markAcked(intent, ack) {
      active()
      const before = validate(intent)
      const next = validate({ ...before, revision: before.revision + 1, phase: "acked", ack: { id: ack.id, sessionID: ack.sessionID } })
      return db.transaction(() => {
        const current = readChecked(before)
        if (current?.phase === "acked" && current.ack?.id === next.ack?.id && current.ack?.sessionID === next.ack?.sessionID) return current
        if (JSON.stringify(current) !== JSON.stringify(before)) fail("Stale DAG delivery journal CAS")
        db.query("UPDATE wakes SET body=? WHERE run_id=? AND seq=?").run(JSON.stringify(next), before.runId, before.seq)
        return next
      }).immediate()
    },
    read(key) { active(); return db.transaction(() => readChecked(parseKey(key))).immediate() },
    findInput(runId, inputID) {
      active()
      const run = text.parse(runId)
      return db.transaction(() => {
        const rows = db.query<{ seq: number }, [string]>("SELECT seq FROM wakes WHERE run_id=? ORDER BY seq").all(run)
        const matches = rows.flatMap(row => readChecked({ runId: run, seq: row.seq }) ?? []).filter(value => value.inputID === inputID)
        return matches.find(value => value.phase === "acked") ?? matches[0]
      }).immediate()
    },
    listRuns() {
      active()
      return db.query<{ run_id: string }, []>("SELECT DISTINCT run_id FROM wakes ORDER BY run_id").all().map(row => row.run_id)
    },
    dropRun(runId) {
      active()
      db.transaction(() => { db.query("DELETE FROM wakes WHERE run_id=?").run(text.parse(runId)) }).immediate()
    },
    close() {
      if (closed) return
      closed = true
      db.close()
    },
  }
}
