import { Database, constants } from "../../shared/bun-sqlite-shim"
import { randomUUID } from "node:crypto"
import { getProcessStartIdentity } from "@oh-my-opencode/memory-core/process-identity"
import { z } from "zod"
import { probeJournalOwner, resolveTrustedChildStatePath } from "./child-journal"

const applicationID = 0x4f4d4f43
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const text = z.string().min(1).max(4096)
const id = z.string().min(1).max(512)
export type CompletionJson =
  null | boolean | number | string | readonly CompletionJson[] | { readonly [key: string]: CompletionJson }
const maximumJSONBytes = 2_097_152
// Budget encoded bytes BEFORE schema copying or JSON.stringify, including keys and escaping.
// This measures inert JSON only; it neither formats nor changes the canonical message.
function quotedBytes(value: string, remaining: number): number {
  let bytes = 2
  for (let index = 0; index < value.length && bytes <= remaining; index++) {
    const code = value.charCodeAt(index)
    if (code === 34 || code === 92) bytes += 2
    else if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index++
      } else bytes += 6
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6
    else bytes += code < 128 ? 1 : code < 2048 ? 2 : 3
  }
  return bytes
}
function jsonValue(
  value: unknown,
  ancestors = new Set<object>(),
  depth = 0,
  budget = { nodes: 0, bytes: 0 },
): value is CompletionJson {
  if (++budget.nodes > 50_000 || depth > 32) return false
  const spend = (bytes: number): boolean => (budget.bytes += bytes) <= maximumJSONBytes
  if (typeof value === "string") return spend(quotedBytes(value, maximumJSONBytes - budget.bytes))
  if (value === null || typeof value === "boolean") return spend(value === false ? 5 : 4)
  if (typeof value === "number") return Number.isFinite(value) && spend(String(value).length)
  if (typeof value !== "object" || ancestors.has(value)) return false
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false
  if (Array.isArray(value) && (value.length > 50_000 || Object.getPrototypeOf(value) !== Array.prototype)) return false
  if (!spend(2)) return false
  ancestors.add(value)
  const keys = Reflect.ownKeys(value)
  let first = true
  const valid =
    keys.every((key) => {
      if (Array.isArray(value) && key === "length") return true
      if (typeof key !== "string" || key.length > 4096 || ["__proto__", "prototype", "constructor"].includes(key))
        return false
      if (Array.isArray(value) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor) throw new Error("Completion intent property vanished during validation")
      if (!first && !spend(1)) return false
      first = false
      if (!Array.isArray(value) && !spend(quotedBytes(key, maximumJSONBytes - budget.bytes) + 1)) return false
      return (
        descriptor.enumerable === true &&
        "value" in descriptor &&
        jsonValue(descriptor.value, ancestors, depth + 1, budget)
      )
    }) &&
    (!Array.isArray(value) || keys.length === value.length + 1)
  ancestors.delete(value)
  return valid
}
const json = z.custom<CompletionJson>((value) => jsonValue(value))
const sourceSchema = z
  .object({
    taskId: id,
    nativeEpoch: integer,
    parentSessionId: text,
    rootSessionId: text,
    createdAt: text,
    provenance: json,
  })
  .strict()
const receiverSchema = z
  .object({
    backendID: text,
    directory: text,
    hostVersion: text,
    sessionID: text,
    rootSessionID: text,
    leaseGeneration: integer,
    registryGeneration: integer,
  })
  .strict()
const envelopeSchema = z
  .object({ intentID: id, receiver: receiverSchema, sources: z.array(sourceSchema).min(1).max(256), message: json })
  .strict()
const recordSchema = envelopeSchema
  .extend({
    owner: text,
    revision: integer,
    phase: z.enum(["queued_durable", "dispatching", "accepted", "uncertain", "definitively_failed"]),
    bookkeeping: z.enum(["pending", "complete"]),
    acceptance: z
      .object({ kind: z.enum(["prompt", "synthetic"]), id: text, sessionID: text })
      .strict()
      .optional(),
    reason: text.optional(),
  })
  .strict()
const ownerSchema = z
  .object({
    token: text,
    pid: integer.refine((value) => value > 0),
    start: text.nullable(),
    released: z.union([z.literal(0), z.literal(1)]),
  })
  .strict()
type ReadonlyData<T> = T extends readonly (infer V)[]
  ? readonly ReadonlyData<V>[]
  : T extends object
    ? { readonly [K in keyof T]: ReadonlyData<T[K]> }
    : T
export type CompletionIntentEnvelope = ReadonlyData<z.infer<typeof envelopeSchema>>
export type CompletionIntent = ReadonlyData<z.infer<typeof recordSchema>>
export type CompletionLogicalSource = Pick<
  z.infer<typeof sourceSchema>,
  "taskId" | "nativeEpoch" | "parentSessionId" | "rootSessionId" | "createdAt"
>
export interface CompletionIntentJournalOptions {
  readonly path: string
  /** Fixed trusted project namespace, not a model-supplied receiving location. */
  readonly namespace: string
  readonly probeOwner?: typeof probeJournalOwner
  /** Trusted deterministic unit port; production omits it and uses real SELF identity. */
  readonly ownerIdentity?: { readonly pid: number; readonly start: string | null }
}
export interface CompletionIntentJournal {
  readonly owner: string
  insertQueued(envelope: CompletionIntentEnvelope): CompletionIntent
  read(intentID: string): CompletionIntent | undefined
  findBySource(source: CompletionLogicalSource): CompletionIntent | undefined
  assertCurrent(expected: CompletionIntent): undefined
  writeSync(previous: CompletionIntent, next: CompletionIntent): undefined
  claim(intentID: string): Promise<CompletionIntent>
  /** Stops new work; joins actual pending probes/claims before releasing owner and DB. */
  close(): Promise<void>
}
export class CompletionIntentJournalError extends Error {
  override readonly name = "CompletionIntentJournalError"
}
function fail(message: string): never {
  throw new CompletionIntentJournalError(message)
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function validate(input: unknown): CompletionIntent {
  if (!jsonValue(input)) fail("Invalid completion JSON data")
  const parsed = recordSchema.safeParse(input)
  if (!parsed.success) fail("Invalid completion intent record")
  const value = parsed.data
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximumJSONBytes) fail("Completion intent record too large")
  if (
    value.sources.some(
      (source) =>
        source.parentSessionId !== value.receiver.sessionID || source.rootSessionId !== value.receiver.rootSessionID,
    )
  )
    fail("Completion source receiver differs")
  const keys = value.sources.map(logicalKey)
  if (new Set(keys).size !== keys.length) fail("Duplicate completion logical source")
  if (
    value.phase === "accepted"
      ? !value.acceptance || value.acceptance.sessionID !== value.receiver.sessionID || value.reason !== undefined
      : value.acceptance !== undefined
  )
    fail("Invalid completion acceptance state")
  if ((value.phase === "uncertain" || value.phase === "definitively_failed") !== (value.reason !== undefined))
    fail("Invalid completion failure state")
  if (value.bookkeeping === "complete" && value.phase !== "accepted" && value.phase !== "definitively_failed")
    fail("Unsettled completion bookkeeping")
  // No mutable aliases from input/SQLite snapshots survive into an issued CAS fence.
  return freeze(JSON.parse(JSON.stringify(value)) as CompletionIntent)
}
function logicalKey(source: CompletionLogicalSource): string {
  return JSON.stringify([
    source.taskId,
    source.nativeEpoch,
    source.parentSessionId,
    source.rootSessionId,
    source.createdAt,
  ])
}
function advance(revision: number): number {
  if (revision >= Number.MAX_SAFE_INTEGER) fail("Completion revision exhausted")
  return revision + 1
}
function envelope(record: CompletionIntent): string {
  return JSON.stringify({
    intentID: record.intentID,
    receiver: record.receiver,
    sources: record.sources,
    message: record.message,
  })
}
const transitions: Record<CompletionIntent["phase"], readonly CompletionIntent["phase"][]> = {
  queued_durable: ["dispatching", "definitively_failed"],
  dispatching: ["accepted", "uncertain", "definitively_failed"],
  uncertain: ["uncertain", "accepted"],
  accepted: ["accepted"],
  definitively_failed: ["definitively_failed"],
}
function reserved(record: CompletionIntent): boolean {
  return record.phase !== "definitively_failed" || record.bookkeeping !== "complete"
}

/** Inert durable state/CAS only. Neither a row, owner claim nor ACK-shaped value is authority,
 * authentic SDK evidence or model consumption. No transport is performed by this module. */
export async function openCompletionIntentJournal(
  options: CompletionIntentJournalOptions,
): Promise<CompletionIntentJournal> {
  const namespace = text.parse(options.namespace)
  const path = resolveTrustedChildStatePath(options.path)
  const identity = z
    .object({ pid: integer.refine((value) => value > 0), start: text.nullable() })
    .strict()
    .parse(options.ownerIdentity ?? { pid: process.pid, start: await getProcessStartIdentity(process.pid) })
  const owner = ownerSchema.parse({ token: randomUUID(), ...identity, released: 0 })
  if (typeof constants.SQLITE_OPEN_NOFOLLOW !== "number") fail("SQLite no-follow open support is unavailable")
  const db = new Database(
    path,
    constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_NOFOLLOW,
  )
  let closing = false,
    closed = false,
    released = false,
    closeAttempt: Promise<void> | undefined
  const pending = new Set<Promise<unknown>>()
  try {
    db.exec("PRAGMA busy_timeout=2000")
    const app = (db.query("PRAGMA application_id").get() as { application_id: number }).application_id
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
    const fresh = app === 0 && version === 0 && db.query("SELECT name FROM sqlite_master").all().length === 0
    if (!fresh && (app !== applicationID || version !== 1)) fail("Foreign or unsupported completion journal database")
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL")
    db.transaction(() => {
      db.exec(`PRAGMA application_id=${applicationID}; PRAGMA user_version=1`)
      db.exec(
        "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS owners (token TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sources (logical_key TEXT PRIMARY KEY, intent_id TEXT NOT NULL)",
      )
      db.exec("CREATE INDEX IF NOT EXISTS completion_sources_by_intent ON sources(intent_id)")
      if (fresh) db.query("INSERT INTO metadata VALUES ('namespace',?)").run(namespace)
      if (
        db.query<{ value: string }, []>("SELECT value FROM metadata WHERE key='namespace'").get()?.value !== namespace
      )
        fail("Foreign completion journal namespace")
      db.query("INSERT INTO owners VALUES (?,?)").run(owner.token, JSON.stringify(owner))
    }).immediate()
    function active(): void {
      if (closing || closed) fail("Completion journal is closing or closed")
    }
    function readOwner(token: string) {
      const row = db
        .query<{ body: string | null }, [string]>(
          `SELECT CASE WHEN length(CAST(body AS BLOB))<=${maximumJSONBytes} THEN body ELSE NULL END AS body FROM owners WHERE token=?`,
        )
        .get(token)
      try {
        const result = ownerSchema.parse(JSON.parse(row?.body ?? "null"))
        if (result.token !== token) fail("Owner key mismatch")
        return freeze(result)
      } catch {
        return fail("Corrupt completion journal owner")
      }
    }
    function readChecked(intentID: string): CompletionIntent | undefined {
      const row = db
        .query<{ body: string | null }, [string]>(
          `SELECT CASE WHEN length(CAST(body AS BLOB))<=${maximumJSONBytes} THEN body ELSE NULL END AS body FROM intents WHERE id=?`,
        )
        .get(intentID)
      if (!row) return undefined
      let result: CompletionIntent
      try {
        if (row.body === null) fail("Oversized completion intent")
        result = validate(JSON.parse(row.body))
        if (result.intentID !== intentID) fail("Intent key mismatch")
      } catch {
        return fail("Corrupt completion intent")
      }
      readOwner(result.owner)
      const index = db
        .query<{ logical_key: string }, [string]>(
          "SELECT logical_key FROM sources WHERE intent_id=? ORDER BY logical_key",
        )
        .all(intentID)
        .map((item) => item.logical_key)
      const expected = reserved(result) ? result.sources.map(logicalKey).sort() : []
      if (JSON.stringify(index) !== JSON.stringify(expected)) fail("Corrupt completion source index")
      return result
    }
    function assertIndexIntegrity(): void {
      if (
        db
          .query(
            "SELECT logical_key FROM sources LEFT JOIN intents ON intents.id=sources.intent_id WHERE intents.id IS NULL LIMIT 1",
          )
          .get()
      )
        fail("Corrupt orphan completion source index")
      // Absence in a derived index is not evidence of absence in durable intent history.
      // Stream this private journal's bounded individual rows; do not accumulate payloads.
      for (const row of db.query<{ id: string }, []>("SELECT id FROM intents").iterate()) readChecked(row.id)
    }
    function read(intentID: string) {
      active()
      id.parse(intentID)
      return db.transaction(() => readChecked(intentID)).immediate()
    }
    function store(record: CompletionIntent): void {
      db.query("UPDATE intents SET body=? WHERE id=?").run(JSON.stringify(record), record.intentID)
    }
    function writeSync(previous: CompletionIntent, next: CompletionIntent): undefined {
      active()
      const before = validate(previous),
        value = validate(next)
      if (before.owner !== owner.token || value.owner !== owner.token || value.revision !== advance(before.revision))
        fail("Invalid completion owner/revision fence")
      if (envelope(before) !== envelope(value)) fail("Completion envelope is immutable")
      if (!transitions[before.phase].includes(value.phase)) fail("Invalid completion phase transition")
      if (before.bookkeeping === "complete" && value.bookkeeping !== "complete")
        fail("Completion bookkeeping cannot reopen")
      if (before.acceptance && JSON.stringify(before.acceptance) !== JSON.stringify(value.acceptance))
        fail("Completion acceptance identity is immutable")
      db.transaction(() => {
        active()
        if (JSON.stringify(readChecked(before.intentID)) !== JSON.stringify(before))
          fail("Stale completion journal CAS")
        store(value)
        if (reserved(before) && !reserved(value)) db.query("DELETE FROM sources WHERE intent_id=?").run(value.intentID)
      }).immediate()
      return undefined
    }
    return {
      owner: owner.token,
      insertQueued(input) {
        active()
        if (!jsonValue(input)) fail("Invalid completion JSON data")
        const parsed = envelopeSchema.safeParse(input)
        if (!parsed.success) fail("Invalid completion envelope")
        const value = validate({
          ...parsed.data,
          owner: owner.token,
          revision: 0,
          phase: "queued_durable",
          bookkeeping: "pending",
        })
        return db
          .transaction(() => {
            active()
            assertIndexIntegrity()
            if (readChecked(value.intentID)) fail("Completion intent already exists")
            if (db.query("SELECT logical_key FROM sources WHERE intent_id=?").get(value.intentID))
              fail("Corrupt orphan completion source index")
            for (const source of value.sources)
              if (db.query("SELECT intent_id FROM sources WHERE logical_key=?").get(logicalKey(source)))
                fail("Completion logical source already reserved")
            db.query("INSERT INTO intents VALUES (?,?)").run(value.intentID, JSON.stringify(value))
            for (const source of value.sources)
              db.query("INSERT INTO sources VALUES (?,?)").run(logicalKey(source), value.intentID)
            return value
          })
          .immediate()
      },
      read,
      findBySource(source) {
        active()
        if (!jsonValue(source)) fail("Invalid completion logical source")
        // Lookup accepts a full typed source too; ONLY logical fields participate. Persistence
        // still uses the strict complete source schema and never strips its provenance.
        const parsed = sourceSchema.omit({ provenance: true }).strip().safeParse(source)
        if (!parsed.success) fail("Invalid completion logical source")
        return db
          .transaction(() => {
            const row = db
              .query<{ intent_id: string }, [string]>("SELECT intent_id FROM sources WHERE logical_key=?")
              .get(logicalKey(parsed.data))
            if (!row) {
              assertIndexIntegrity()
              return undefined
            }
            const value = readChecked(row.intent_id)
            if (!value || !value.sources.some((item) => logicalKey(item) === logicalKey(parsed.data)))
              fail("Corrupt completion source reference")
            return value
          })
          .immediate()
      },
      assertCurrent(expected) {
        active()
        const value = validate(expected)
        if (value.owner !== owner.token) fail("Foreign completion observer")
        if (JSON.stringify(read(value.intentID)) !== JSON.stringify(value)) fail("Stale completion journal fence")
        return undefined
      },
      writeSync,
      claim(intentID) {
        active()
        id.parse(intentID)
        const work = Promise.resolve().then(async () => {
          active()
          const snapshot = db
            .transaction(() => {
              const record = readChecked(intentID)
              if (!record) fail("Completion intent missing")
              return { record, owner: readOwner(record.owner) }
            })
            .immediate()
          const canClaim =
            snapshot.owner.token === owner.token ||
            snapshot.owner.released === 1 ||
            (await (options.probeOwner ?? probeJournalOwner)(snapshot.owner)) === "dead"
          active()
          if (!canClaim) fail("Completion owner is live or unverified")
          return db
            .transaction(() => {
              active()
              if (
                JSON.stringify(readChecked(intentID)) !== JSON.stringify(snapshot.record) ||
                JSON.stringify(readOwner(snapshot.owner.token)) !== JSON.stringify(snapshot.owner)
              )
                fail("Completion custody changed during owner probe")
              const next = validate({
                ...snapshot.record,
                owner: owner.token,
                revision: advance(snapshot.record.revision),
              })
              store(next)
              return next
            })
            .immediate()
        })
        pending.add(work)
        void work.finally(() => pending.delete(work)).catch(() => {})
        return work
      },
      close() {
        if (closed) return Promise.resolve()
        if (closeAttempt) return closeAttempt
        closing = true
        const work = (async () => {
          while (pending.size) await Promise.allSettled([...pending])
          if (!released) {
            db.transaction(() => {
              db.query("UPDATE owners SET body=? WHERE token=?").run(
                JSON.stringify({ ...owner, released: 1 }),
                owner.token,
              )
            }).immediate()
            released = true
          }
          db.close()
          closed = true
        })()
        closeAttempt = work
        void work.catch(() => {
          if (closeAttempt === work) closeAttempt = undefined
        })
        return work
      },
    }
  } catch (error) {
    db.close()
    throw error
  }
}
