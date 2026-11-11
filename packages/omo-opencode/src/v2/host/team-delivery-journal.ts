import { Database, constants } from "../../shared/bun-sqlite-shim"
import { z } from "zod"
import { resolveTrustedChildStatePath } from "./child-journal"

const applicationID = 0x4f4d4f54
const text = z.string().min(1).max(4096)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const keySchema = z.object({ teamRunId: text, recipient: text, messageId: text }).strict()
const ackSchema = z.object({ id: text, sessionID: text }).strict()
const recordSchema = keySchema.extend({
  receiverSessionID: text,
  /** The deterministic host message id every attempt of this delivery posts with. */
  inputID: text.refine(value => value.startsWith("msg_"), "Team delivery input id must be a host message id"),
  revision: integer,
  /** Earlier receivers of this un-ACKed intent; the host may already hold the id in one of them. */
  previousReceivers: z.array(text).max(64).optional(),
  phase: z.enum(["intent", "acked"]),
  ack: ackSchema.optional(),
}).strict()
type ReadonlyData<T> = T extends object ? { readonly [K in keyof T]: ReadonlyData<T[K]> } : T
export type TeamDeliveryKey = ReadonlyData<z.infer<typeof keySchema>>
export type TeamDeliveryRecord = ReadonlyData<z.infer<typeof recordSchema>>
export type TeamDeliveryAck = ReadonlyData<z.infer<typeof ackSchema>>

export interface TeamDeliveryJournalOptions {
  /** Private application state, never a model-supplied database path. */
  readonly path: string
  /** Fixed trusted project and lead namespace. */
  readonly namespace: string
}
export interface TeamDeliveryJournal {
  /** Durable intent BEFORE transport. An existing row is returned unchanged, so a retry after a crash
   * reuses the SAME input id; a row for another input id is refused, never rewritten. The intent
   * belongs to (run, recipient, message), not to a session: an un-ACKed intent whose recipient is now
   * bound to another session (a restored or respawned member) moves to that receiver with the SAME
   * input id, remembering the earlier receiver; an ACKed row never moves. */
  recordIntent(key: TeamDeliveryKey, receiverSessionID: string, inputID: string): TeamDeliveryRecord
  /** Records the genuine synthetic ACK of an intent. Compare-and-set on the exact intent row. */
  markAcked(intent: TeamDeliveryRecord, ack: TeamDeliveryAck): TeamDeliveryRecord
  read(key: TeamDeliveryKey): TeamDeliveryRecord | undefined
  isAcked(key: TeamDeliveryKey): boolean
  /** Every row of one team run. */
  listTeam(teamRunId: string): TeamDeliveryRecord[]
  /** Every un-ACKed intent, for reload reconciliation. */
  listIntents(): TeamDeliveryRecord[]
  /** Forgets one un-ACKed intent whose recipient is gone; an ACKed row is kept. */
  dropIntent(key: TeamDeliveryKey): void
  /** Forgets a deleted team run. */
  dropTeam(teamRunId: string): void
  close(): void
}
class TeamDeliveryJournalError extends Error { override readonly name = "TeamDeliveryJournalError" }
function fail(message: string): never { throw new TeamDeliveryJournalError(message) }

/** The receivers that may hold this delivery's input id: the current one and any earlier one. */
export function teamDeliveryReceivers(value: Pick<TeamDeliveryRecord, "receiverSessionID" | "previousReceivers">): readonly string[] {
  return [value.receiverSessionID, ...value.previousReceivers ?? []]
}
const receivers = teamDeliveryReceivers

function validate(input: unknown): TeamDeliveryRecord {
  const parsed = recordSchema.safeParse(input)
  if (!parsed.success) fail("Invalid team delivery record")
  const value = parsed.data
  if ((value.phase === "acked") !== (value.ack !== undefined)) fail("Invalid team delivery acceptance state")
  if (value.ack && (value.ack.id !== value.inputID || !receivers(value).includes(value.ack.sessionID))) fail("Team delivery ACK differs from its intent")
  return Object.freeze({ ...value, ...(value.previousReceivers && { previousReceivers: Object.freeze([...value.previousReceivers]) }), ...(value.ack && { ack: Object.freeze({ ...value.ack }) }) })
}

/** Inert durable state only: neither an intent nor an ACK row is authority. Exclusive custody of one
 * recipient's deliveries comes from the team-core inbox consumer lease held by that recipient's
 * poller, so this journal needs no owner claims of its own. No transport is performed here. */
export function openTeamDeliveryJournal(options: TeamDeliveryJournalOptions): TeamDeliveryJournal {
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
    if (!fresh && (app !== applicationID || version !== 1)) fail("Foreign or unsupported team delivery journal database")
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL")
    db.transaction(() => {
      db.exec(`PRAGMA application_id=${applicationID}; PRAGMA user_version=1`)
      db.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS deliveries (team_run_id TEXT NOT NULL, recipient TEXT NOT NULL, message_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (team_run_id, recipient, message_id))")
      if (fresh) db.query("INSERT INTO metadata VALUES ('namespace',?)").run(namespace)
      if ((db.query<{ value: string }, []>("SELECT value FROM metadata WHERE key='namespace'").get())?.value !== namespace) fail("Foreign team delivery journal namespace")
    }).immediate()
  } catch (error) { db.close(); throw error }

  function active(): void { if (closed) fail("Team delivery journal is closed") }
  function readChecked(key: TeamDeliveryKey): TeamDeliveryRecord | undefined {
    const row = db.query<{ body: string }, [string, string, string]>("SELECT body FROM deliveries WHERE team_run_id=? AND recipient=? AND message_id=?")
      .get(key.teamRunId, key.recipient, key.messageId)
    if (!row) return undefined
    let value: TeamDeliveryRecord
    try { value = validate(JSON.parse(row.body)) } catch { return fail("Corrupt team delivery record") }
    if (value.teamRunId !== key.teamRunId || value.recipient !== key.recipient || value.messageId !== key.messageId) fail("Team delivery key mismatch")
    return value
  }
  function parseKey(key: TeamDeliveryKey): TeamDeliveryKey {
    const parsed = keySchema.safeParse({ teamRunId: key.teamRunId, recipient: key.recipient, messageId: key.messageId })
    if (!parsed.success) fail("Invalid team delivery key")
    return parsed.data
  }
  return {
    recordIntent(input, receiverSessionID, inputID) {
      active()
      const key = parseKey(input)
      const value = validate({ ...key, receiverSessionID, inputID, revision: 0, phase: "intent" })
      return db.transaction(() => {
        const existing = readChecked(key)
        if (existing) {
          if (existing.inputID !== value.inputID) fail("Team delivery intent is held by another input id")
          if (existing.receiverSessionID === value.receiverSessionID) return existing
          if (existing.phase === "acked") fail("Team delivery was already ACKed by another receiver")
          const moved = validate({ ...existing, receiverSessionID: value.receiverSessionID, revision: existing.revision + 1,
            previousReceivers: [...new Set([...receivers(existing)])].filter(receiver => receiver !== value.receiverSessionID) })
          db.query("UPDATE deliveries SET body=? WHERE team_run_id=? AND recipient=? AND message_id=?").run(JSON.stringify(moved), key.teamRunId, key.recipient, key.messageId)
          return moved
        }
        db.query("INSERT INTO deliveries VALUES (?,?,?,?)").run(key.teamRunId, key.recipient, key.messageId, JSON.stringify(value))
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
        if (JSON.stringify(current) !== JSON.stringify(before)) fail("Stale team delivery journal CAS")
        db.query("UPDATE deliveries SET body=? WHERE team_run_id=? AND recipient=? AND message_id=?").run(JSON.stringify(next), before.teamRunId, before.recipient, before.messageId)
        return next
      }).immediate()
    },
    read(key) { active(); return db.transaction(() => readChecked(parseKey(key))).immediate() },
    isAcked(key) { active(); return db.transaction(() => readChecked(parseKey(key))?.phase === "acked").immediate() },
    listTeam(teamRunId) {
      active()
      return db.transaction(() => db.query<{ message_id: string; recipient: string }, [string]>("SELECT recipient, message_id FROM deliveries WHERE team_run_id=? ORDER BY recipient, message_id")
        .all(text.parse(teamRunId)).flatMap(row => readChecked({ teamRunId, recipient: row.recipient, messageId: row.message_id }) ?? [])).immediate()
    },
    listIntents() {
      active()
      return db.transaction(() => db.query<{ team_run_id: string; recipient: string; message_id: string }, []>("SELECT team_run_id, recipient, message_id FROM deliveries ORDER BY team_run_id, recipient, message_id")
        .all().flatMap(row => readChecked({ teamRunId: row.team_run_id, recipient: row.recipient, messageId: row.message_id }) ?? []).filter(row => row.phase === "intent")).immediate()
    },
    dropIntent(input) {
      active()
      const key = parseKey(input)
      db.transaction(() => {
        if (readChecked(key)?.phase === "intent") db.query("DELETE FROM deliveries WHERE team_run_id=? AND recipient=? AND message_id=?").run(key.teamRunId, key.recipient, key.messageId)
      }).immediate()
    },
    dropTeam(teamRunId) {
      active()
      db.transaction(() => { db.query("DELETE FROM deliveries WHERE team_run_id=?").run(text.parse(teamRunId)) }).immediate()
    },
    close() {
      if (closed) return
      closed = true
      db.close()
    },
  }
}
