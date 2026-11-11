import { Database, constants } from "../../shared/bun-sqlite-shim"
import { randomUUID } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, parse, resolve } from "node:path"
import { z } from "zod"
import { getPidLiveness, getProcessStartIdentity, startIdentitiesConflict } from "@oh-my-opencode/memory-core/process-identity"
import { SessionBackendError, type ChildJournal, type ChildRecord } from "./session-backend"
import { PARKING_MARKER_KEY } from "./child-parking"

const applicationID = 0x4f4d4f32
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const text = z.string().min(1).max(4096)
const recordSchema = z.object({
  key: z.string().min(1).max(512), owner: text, revision: integer,
  locator: z.object({ format: z.literal(1), backendID: text, location: text, hostVersion: text, parentID: text, sessionID: text, generation: integer }).strict(),
  phase: z.enum(["creating", "staged", "admitting", "accepted", "uncertain", "closing", "closed"]),
  admission: z.enum(["none", "pending", "accepted", "uncertain"]), inboxID: text.optional(),
  receipts: z.record(text, z.enum(["pending", "accepted", "uncertain"])).refine(value => Object.keys(value).length <= 4096),
  turn: z.object({ nativeEpoch: integer, observationKey: z.string().min(1).max(512), firstInputID: text.optional() }).strict().optional(),
  // Parking is NOT closing: phase stays truthful; conflict/intent never become a receipt.
  parking: z.object({
    format: z.literal(1), state: z.enum(["intent", "parked", "conflict", "restoring", "restored"]), id: text, owner: text,
    original: z.object({ present: z.boolean(), rules: z.array(z.object({ action: z.string().max(4096), resource: z.string().max(4096), effect: z.enum(["allow", "deny", "ask"]) }).strict()).max(4096) }).strict(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/), marker: z.literal(PARKING_MARKER_KEY), agent: text.optional(), nativeEpoch: integer.optional(), intentRevision: integer,
    readback: z.literal("verified").optional(), conflict: z.string().min(1).max(1024).optional(),
  }).strict().refine(value => (value.state === "parked" || value.state === "restored") === (value.readback === "verified") && (value.state === "conflict") === (value.conflict !== undefined)).optional(),
}).strict()
const ownerSchema = z.object({ token: text, pid: integer.refine(pid => pid > 0), start: text.nullable(), released: z.union([z.literal(0), z.literal(1)]) }).strict()
type Owner = z.infer<typeof ownerSchema>
interface Row { body: string }

/** Reuse the neutral OS reader. Missing/incomparable identity never proves death. */
export async function probeJournalOwner(owner: Readonly<Pick<Owner, "pid" | "start">>): Promise<"alive" | "dead" | "unknown"> {
  const live = getPidLiveness(owner.pid)
  if (live !== "alive") return live
  if (!owner.start) return "unknown"
  const actual = await getProcessStartIdentity(owner.pid)
  if (!actual) return "unknown"
  return startIdentitiesConflict(owner.start, actual) ? "dead" : actual === owner.start ? "alive" : "unknown"
}

function fail(message: string): never { throw new SessionBackendError("conflict", message) }
function validate(record: ChildRecord): ChildRecord {
  if (JSON.stringify(record).length > 2_097_152) fail("Child journal record too large")
  if (record.receipts && Object.keys(record.receipts).some(key => ["__proto__", "prototype", "constructor"].includes(key))) fail("Unsafe child journal receipt key")
  const parsed = recordSchema.safeParse(record)
  if (!parsed.success) fail("Invalid child journal record")
  return parsed.data as ChildRecord
}
function advance(revision: number): number {
  if (revision >= Number.MAX_SAFE_INTEGER) fail("Child journal revision exhausted")
  return revision + 1
}
/** The deepest directory that already exists is taken at its physical location, so links the OS
 * owns above the application's state (macOS `/var` -> `/private/var`) are accepted. Everything the
 * application creates below it, and the database file itself, must not be a link. */
function physicalPrefix(absolute: string): string {
  const created = [basename(absolute)]
  let existing = dirname(absolute)
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    created.unshift(basename(existing))
    existing = parent
  }
  return resolve(realpathSync(existing), ...created)
}
export function resolveTrustedChildStatePath(path: string) {
  if (!isAbsolute(path)) fail("Child journal requires an absolute trusted state path")
  const absolute = physicalPrefix(resolve(path))
  let current = parse(absolute).root
  for (const part of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = resolve(current, part)
    try { if (lstatSync(current).isSymbolicLink()) fail("Child journal path traverses a link") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 })
  const physical = realpathSync(dirname(absolute)), parent = dirname(absolute)
  if (process.platform === "win32" ? physical.toLowerCase() !== parent.toLowerCase() : physical !== parent) fail("Child journal state directory differs from its physical path")
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { if (!lstatSync(absolute + suffix).isFile()) fail("Child journal database or sidecar is not a regular file") }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  return absolute
}

/** The highest locator generation stored in a child journal, or 0 when there is none yet. A session
 * scope opened after a reload restarts its lease generations from 1, while a journal never lets a
 * locator's generation go down; the caller raises its scope above this floor before the first lease.
 * Read-only: no owner row is registered and nothing is created. */
export function readStoredLocatorGenerationFloor(path: string): number {
  if (!isAbsolute(path)) fail("Child journal requires an absolute trusted state path")
  if (!existsSync(path)) return 0
  const absolute = resolveTrustedChildStatePath(path)
  if (typeof constants.SQLITE_OPEN_NOFOLLOW !== "number") fail("SQLite no-follow open support is unavailable")
  const db = new Database(absolute, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW)
  try {
    db.exec("PRAGMA busy_timeout=2000")
    const app = (db.query("PRAGMA application_id").get() as { application_id: number }).application_id
    if (app !== applicationID) fail("Foreign child journal database")
    let floor = 0
    for (const row of db.query<Row, []>("SELECT body FROM children").all()) {
      // A corrupt row stays for inspection; it cannot lower the floor of the readable ones.
      let body: unknown
      try { body = JSON.parse(row.body) } catch { continue }
      const parsed = recordSchema.safeParse(body)
      if (parsed.success && parsed.data.locator.generation > floor) floor = parsed.data.locator.generation
    }
    return floor
  } finally { db.close() }
}

export interface DurableChildJournal extends ChildJournal {
  readonly owner: string
  assertCurrent(expected: ChildRecord): undefined
  writeSync(previous: ChildRecord, next: ChildRecord): undefined
  /** Every readable custody row, for an owner that must find stranded children it holds no key for. */
  list(): Promise<ChildRecord[]>
  /** Release custody only after all backend work has joined. Future calls fail. */
  close(): void
}
export interface ChildJournalOptions {
  /** Private application state, never a task/model-supplied database path. */
  readonly path: string
  /** Trusted OS-probe port; production uses the neutral process-identity reader. */
  readonly probeOwner?: typeof probeJournalOwner
}

/** SQLite is the durable CAS boundary. This is not an OS-user filesystem sandbox. */
export async function openChildJournal(options: ChildJournalOptions): Promise<DurableChildJournal> {
  const path = resolveTrustedChildStatePath(options.path)
  const start = await getProcessStartIdentity(process.pid)
  const owner: Owner = { token: randomUUID(), pid: process.pid, start, released: 0 }
  if (typeof constants.SQLITE_OPEN_NOFOLLOW !== "number") fail("SQLite no-follow open support is unavailable")
  const db = new Database(path, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_NOFOLLOW)
  let closed = false
  try {
    db.exec("PRAGMA busy_timeout=2000")
    const app = (db.query("PRAGMA application_id").get() as { application_id: number }).application_id
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
    const objects = db.query("SELECT name FROM sqlite_master").all()
    const fresh = app === 0 && version === 0 && objects.length === 0
    if (!fresh && (app !== applicationID || version !== 1)) fail("Foreign or unsupported child journal database")
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL")
    db.transaction(() => {
      db.exec(`PRAGMA application_id=${applicationID}; PRAGMA user_version=1`)
      db.exec("CREATE TABLE IF NOT EXISTS owners (token TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS children (key TEXT PRIMARY KEY, body TEXT NOT NULL)")
      db.query("INSERT INTO owners (token,body) VALUES (?,?)").run(owner.token, JSON.stringify(owner))
    }).immediate()
    function active() { if (closed) fail("Child journal is closed") }
    function read(key: string): ChildRecord | undefined {
      active()
      const row = db.query<Row, [string]>("SELECT body FROM children WHERE key=?").get(key)
      if (!row) return undefined
      try { const record = validate(JSON.parse(row.body)); if (record.key !== key) fail("Child journal key mismatch"); return record }
      catch { return fail("Corrupt child journal record") }
    }
    function readOwner(token: string): Owner {
      const row = db.query<Row, [string]>("SELECT body FROM owners WHERE token=?").get(token)
      try { const value = ownerSchema.parse(JSON.parse(row?.body ?? "null")); if (value.token !== token) fail("Child journal owner mismatch"); return value }
      catch { return fail("Corrupt or missing child journal owner") }
    }
    function store(record: ChildRecord) { db.query("INSERT INTO children (key,body) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body").run(record.key, JSON.stringify(record)) }
    function writeSync(previous: ChildRecord, next: ChildRecord): undefined {
      active()
      const before = validate(previous), value = validate(next)
      if (before.owner !== owner.token || value.owner !== owner.token || before.key !== value.key || value.revision !== advance(before.revision)) fail("Invalid child journal fence transition")
      const { generation: oldGeneration, ...oldLocator } = before.locator
      const { generation: newGeneration, ...newLocator } = value.locator
      if (JSON.stringify(oldLocator) !== JSON.stringify(newLocator) || newGeneration < oldGeneration) fail("Child locator identity cannot change")
      db.transaction(() => {
        active()
        const current = read(before.key)
        if (JSON.stringify(current) !== JSON.stringify(before)) fail("Stale child journal custody fence")
        store(value)
      }).immediate()
      return undefined
    }
    return {
      owner: owner.token,
      async read(key) { return read(key) },
      assertCurrent(expected) {
        active()
        const value = validate(expected)
        if (value.owner !== owner.token) fail("Foreign child journal observer")
        // Synchronous validation lets the observer fence its same-process append.
        // A separate observation database is not a transaction with this journal.
        if (JSON.stringify(read(value.key)) !== JSON.stringify(value)) fail("Stale child journal observation fence")
        return undefined
      },
      async claim(key, requestedOwner, initial) {
        active()
        if (requestedOwner !== owner.token) fail("Foreign child journal claimant")
        const observed = read(key)
        if (initial) {
          const value = validate(initial)
          if (value.key !== key || value.owner !== owner.token || value.revision !== 0) fail("Invalid initial child custody")
          return db.transaction(() => { active(); if (read(key)) fail("Child custody already exists"); store(value); return value }).immediate()
        }
        if (!observed) fail("Child custody does not exist")
        const observedOwner = readOwner(observed.owner)
        const dead = observed.owner === owner.token || observedOwner.released === 1 || await (options.probeOwner ?? probeJournalOwner)(observedOwner) === "dead"
        active()
        if (!dead) fail("Child custody owner is live or unverified")
        return db.transaction(() => {
          active()
          const current = read(key)
          // No asynchronous probe is inside the write lock. Recheck the exact snapshot.
          if (JSON.stringify(current) !== JSON.stringify(observed) || JSON.stringify(readOwner(observed.owner)) !== JSON.stringify(observedOwner)) fail("Child custody changed during owner probe")
          const next = validate({ ...observed, owner: owner.token, revision: advance(observed.revision) })
          store(next); return next
        }).immediate()
      },
      writeSync,
      async write(previous, next) { writeSync(previous, next) },
      async list() {
        active()
        const records: ChildRecord[] = []
        for (const row of db.query<Row & { key: string }, []>("SELECT key, body FROM children ORDER BY key").all()) {
          let record: ChildRecord | undefined
          // A corrupt row stays for inspection; it never blocks the readable ones.
          try { record = read(row.key) } catch { continue }
          if (record !== undefined) records.push(record)
        }
        return records
      },
      close() {
        if (closed) return
        db.transaction(() => { db.query("UPDATE owners SET body=? WHERE token=?").run(JSON.stringify({ ...owner, released: 1 }), owner.token) }).immediate()
        closed = true
        db.close()
      },
    }
  } catch (error) { db.close(); throw error }
}
