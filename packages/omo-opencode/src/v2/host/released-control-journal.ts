import { Database, constants } from "../../shared/bun-sqlite-shim"
import { z } from "zod"
import { resolveTrustedChildStatePath } from "./child-journal"

const applicationID = 0x4f4d4f52
const text = z.string().min(1).max(65_536)
const receiptSchema = z.object({
  taskID: z.string().min(1).max(512),
  /** The exact operation identity of the released row: tree, epoch, claim, child and owned reference. */
  identity: text,
  /** The owned reference's journal revision at release. */
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** `released`: the parent released it (cancel/detach/close). `suspended`: parked by its runtime's shutdown. */
  kind: z.enum(["released", "suspended"]),
}).strict()
export type ReleasedControlReceipt = Readonly<z.infer<typeof receiptSchema>>

export interface ReleasedControlJournalOptions {
  /** Private application state beside the child journal, never a model-supplied path. */
  readonly path: string
  /** Fixed trusted project and parent namespace. */
  readonly namespace: string
}
export interface ReleasedControlJournal {
  record(receipt: ReleasedControlReceipt): void
  read(taskID: string): ReleasedControlReceipt | undefined
  forget(taskID: string): void
  close(): void
}
class ReleasedControlJournalError extends Error { override readonly name = "ReleasedControlJournalError" }
function fail(message: string): never { throw new ReleasedControlJournalError(message) }

/** Durable custody receipts of children a runtime released itself. A receipt is inert DATA: it proves
 * custody only while the stored task row still has EXACTLY the recorded identity and journal revision,
 * so a changed or foreign row is refused exactly like the in-memory receipt refuses it. */
export function openReleasedControlJournal(options: ReleasedControlJournalOptions): ReleasedControlJournal {
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
    if (!fresh && (app !== applicationID || version !== 1)) fail("Foreign or unsupported released control journal database")
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL")
    db.transaction(() => {
      db.exec(`PRAGMA application_id=${applicationID}; PRAGMA user_version=1`)
      db.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts (task_id TEXT PRIMARY KEY, body TEXT NOT NULL)")
      if (fresh) db.query("INSERT INTO metadata VALUES ('namespace',?)").run(namespace)
      if ((db.query<{ value: string }, []>("SELECT value FROM metadata WHERE key='namespace'").get())?.value !== namespace) fail("Foreign released control journal namespace")
    }).immediate()
  } catch (error) { db.close(); throw error }
  function active(): void { if (closed) fail("Released control journal is closed") }
  return {
    record(receipt) {
      active()
      const value = receiptSchema.parse({ taskID: receipt.taskID, identity: receipt.identity, revision: receipt.revision, kind: receipt.kind })
      db.transaction(() => {
        db.query("INSERT INTO receipts (task_id, body) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET body=excluded.body").run(value.taskID, JSON.stringify(value))
      }).immediate()
    },
    read(taskID) {
      active()
      const row = db.query<{ body: string }, [string]>("SELECT body FROM receipts WHERE task_id=?").get(taskID)
      if (!row) return undefined
      // A corrupt receipt proves nothing; the read is then refused like a missing one.
      let body: unknown
      try { body = JSON.parse(row.body) } catch { return undefined }
      const parsed = receiptSchema.safeParse(body)
      if (!parsed.success || parsed.data.taskID !== taskID) return undefined
      return Object.freeze(parsed.data)
    },
    forget(taskID) {
      active()
      db.transaction(() => { db.query("DELETE FROM receipts WHERE task_id=?").run(taskID) }).immediate()
    },
    close() {
      if (closed) return
      closed = true
      db.close()
    },
  }
}
