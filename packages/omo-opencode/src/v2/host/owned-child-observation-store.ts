import { Database, constants } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { isAbsolute } from "node:path"
import { z } from "zod"
import { resolveTrustedChildStatePath } from "./child-journal"
import { observationRecordSchema, type ObservationBinding, type ObservationRecord, type ObservationSnapshot, type OwnedChildObservationStore } from "./owned-child-observation-types"

const applicationID = 0x4f4d4f33
const text = z.string().min(1).max(4096).refine(value => !value.includes("\0"))
const keySchema = z.string().min(1).max(512)
const reasonSchema = z.string().min(1).max(128)
const locatorSchema = z.object({ format: z.literal(1), backendID: text, location: text.refine(isAbsolute), hostVersion: text,
  parentID: text, sessionID: text, generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()
const reasonsSchema = z.array(reasonSchema).max(128).refine(values => new Set(values).size === values.length)
const bindingsSQL = "CREATE TABLE observation_bindings (key TEXT PRIMARY KEY, token TEXT NOT NULL, locator TEXT NOT NULL, uncertainty TEXT NOT NULL)"
const recordsSQL = "CREATE TABLE observation_records (key TEXT NOT NULL, id TEXT NOT NULL, ordinal INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(key,id), UNIQUE(key,ordinal))"
interface BindingRow { key: string; token: string; locator: string; uncertainty: string }
interface RecordRow { id: string; ordinal: number; body: string }
function fail(message: string): never { throw new Error(message) }
function parsed<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  try { const result = schema.safeParse(value); if (result.success) return result.data } catch { /* Reject without secret-bearing validator diagnostics. */ }
  return fail(message)
}
function json(value: string): unknown { try { return JSON.parse(value) } catch { return fail("Corrupt observation JSON") } }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value) }
  return value
}
function assertGuard(guard: () => void) {
  const result: unknown = guard()
  if (result && (typeof result === "object" || typeof result === "function") && "then" in result) {
    void Promise.resolve(result).catch(() => {})
    fail("Synchronous observation guard required")
  }
}

export interface OwnedChildObservationStoreOptions { readonly path: string; readonly maxEntries?: number; readonly maxBytes?: number }

/** Separate from custody SQLite: synchronous guard + local binding CAS is not a cross-DB transaction. */
export function openOwnedChildObservationStore(options: OwnedChildObservationStoreOptions): OwnedChildObservationStore {
  const maxEntries = options.maxEntries ?? 4096, maxBytes = options.maxBytes ?? 8_388_608
  if (![maxEntries, maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) fail("Invalid observation limits")
  const path = resolveTrustedChildStatePath(options.path)
  if (typeof constants.SQLITE_OPEN_NOFOLLOW !== "number") fail("SQLite no-follow support unavailable")
  const db = new Database(path, constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_NOFOLLOW)
  let closed = false
  function assertNoOrphans() {
    const orphan=db.query("SELECT observation_records.key FROM observation_records LEFT JOIN observation_bindings ON observation_bindings.key=observation_records.key WHERE observation_bindings.key IS NULL LIMIT 1").get()
    if(orphan)fail("Orphan observation records without binding")
  }
  try {
    db.exec("PRAGMA busy_timeout=2000")
    const app = (db.query("PRAGMA application_id").get() as { application_id: number }).application_id
    const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
    const objects = db.query("SELECT name,type,sql FROM sqlite_master").all() as { name: string; type: string; sql: string | null }[]
    const fresh = app === 0 && version === 0 && !objects.length
    if (!fresh) {
      if (app !== applicationID || version !== 1) fail("Foreign or unsupported observation database")
      const tables = objects.filter(object => object.type === "table")
      if (tables.length !== 2 || tables.find(object => object.name === "observation_bindings")?.sql !== bindingsSQL || tables.find(object => object.name === "observation_records")?.sql !== recordsSQL ||
        objects.some(object => object.type !== "table" && !(object.type === "index" && object.sql === null && object.name.startsWith("sqlite_autoindex_observation_")))) fail("Foreign or corrupt observation database schema")
    }
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL")
    if (fresh) db.transaction(() => { db.exec(`PRAGMA application_id=${applicationID}; PRAGMA user_version=1`); db.exec(bindingsSQL); db.exec(recordsSQL) }).immediate()
    assertNoOrphans()
    function active() { if (closed) fail("Observation store closed") }
    function row(key: string): BindingRow | undefined {
      active()
      return db.query<BindingRow, [string]>("SELECT key,token,locator,uncertainty FROM observation_bindings WHERE key=?").get(key) ?? undefined
    }
    function validateBinding(value: BindingRow, key: string): { locator: z.infer<typeof locatorSchema>; uncertainty: string[] } {
      if (value.key !== key || !text.safeParse(value.token).success) fail("Corrupt observation binding")
      return { locator: parsed(locatorSchema, json(value.locator), "Corrupt observation locator"), uncertainty: parsed(reasonsSchema, json(value.uncertainty), "Corrupt observation uncertainty") }
    }
    function current(binding: ObservationBinding) {
      const value = row(binding.key)
      if (!value || value.token !== binding.token) fail("Stale observation binding")
      const checked = validateBinding(value, binding.key)
      if (JSON.stringify(checked.locator) !== JSON.stringify(binding.locator)) fail("Corrupt observation binding locator")
      return checked
    }
    function downgrade(binding: ObservationBinding, reason: string) {
      active()
      const safeReason = parsed(reasonSchema, reason, "Invalid observation uncertainty reason")
      db.transaction(() => {
        const value = row(binding.key)
        // A lost holder may downgrade itself, never another owner's newer token.
        if (!value || value.token !== binding.token) return
        const reasons = parsed(reasonsSchema, json(value.uncertainty), "Corrupt observation uncertainty")
        if (!reasons.includes(safeReason) && reasons.length < 128) reasons.push(safeReason)
        db.query("UPDATE observation_bindings SET uncertainty=? WHERE key=? AND token=?").run(JSON.stringify(reasons), binding.key, binding.token)
      }).immediate()
    }
    function totals(key: string) {
      const value = db.query<{ count: number; bytes: number }, [string]>("SELECT count(*) AS count, coalesce(sum(length(cast(body as blob))),0) AS bytes FROM observation_records WHERE key=?").get(key)!
      if (!Number.isSafeInteger(value.count) || !Number.isSafeInteger(value.bytes) || value.count < 0 || value.bytes < 0) fail("Corrupt observation size")
      if (value.count > maxEntries || value.bytes > maxBytes) fail("Observation limit exceeded")
      return value
    }
    function validateRecord(raw: unknown, locator: ObservationBinding["locator"]): ObservationRecord {
      const record = parsed(observationRecordSchema, raw, "Invalid observation record")
      if (record.kind === "host" && (record.event.sessionID !== locator.sessionID || (record.event.durable && record.event.durable.aggregateID !== locator.sessionID))) fail("Foreign observation session or aggregate")
      return record
    }
    function readRecords(binding: ObservationBinding): ObservationRecord[] {
      totals(binding.key)
      const values = db.query<RecordRow, [string]>("SELECT id,ordinal,body FROM observation_records WHERE key=? ORDER BY ordinal").all(binding.key)
      return values.map((value, ordinal) => {
        if (value.ordinal !== ordinal || typeof value.body !== "string") fail("Corrupt observation ordinal")
        const record = validateRecord(json(value.body), binding.locator)
        if (value.id !== record.id || JSON.stringify(record) !== value.body) fail("Corrupt observation record identity or body")
        return record
      })
    }
    return {
      bind(input) {
        active()
        const key = parsed(keySchema, input.key, "Invalid observation key")
        const locator = parsed(locatorSchema, input.locator, "Invalid observation locator") as ObservationBinding["locator"]
        if (typeof input.guard !== "function") fail("Synchronous observation guard required")
        const guard = input.guard
        assertGuard(guard)
        const binding = freeze({ key, locator, token: randomUUID() })
        db.transaction(() => {
          active()
          // Never adopt retained history as a fresh binding, including unrelated corrupt keys.
          // Recheck under the same write transaction that installs the new token.
          assertNoOrphans()
          const old = row(key)
          let uncertainty: string[] = []
          if (old) {
            const previous = validateBinding(old, key)
            const { generation: oldGeneration, ...oldIdentity } = previous.locator
            const { generation, ...identity } = locator
            if (JSON.stringify(oldIdentity) !== JSON.stringify(identity) || generation < oldGeneration) fail("Foreign or retired observation locator")
            readRecords({ key, token: old.token, locator: previous.locator as ObservationBinding["locator"] })
            uncertainty = previous.uncertainty
            if (!uncertainty.includes("rebound")) { if(uncertainty.length>=128)fail("Observation uncertainty limit exceeded");uncertainty.push("rebound") }
          }
          db.query("INSERT INTO observation_bindings(key,token,locator,uncertainty) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET token=excluded.token,locator=excluded.locator,uncertainty=excluded.uncertainty").run(key,binding.token,JSON.stringify(locator),JSON.stringify(uncertainty))
        }).immediate()
        function guarded() {
          active()
          try { assertGuard(guard) } catch (error) { try { downgrade(binding,"custody-lost") } catch { /* Never replace the original custody refusal. */ } throw error }
          return current(binding)
        }
        return {
          binding,
          append(raw) {
            guarded()
            let record: ObservationRecord
            try { record=validateRecord(raw,binding.locator) } catch (error) { downgrade(binding,"invalid-record");throw error }
            const body=JSON.stringify(record), bytes=Buffer.byteLength(body)
            let refusal: string | undefined
            db.transaction(() => {
              const bindingState=current(binding)
              try { readRecords(binding) } catch { downgrade(binding,"corrupt-store");refusal="Corrupt observation records";return }
              const duplicate=db.query<{body:string},[string,string]>("SELECT body FROM observation_records WHERE key=? AND id=?").get(key,record.id)
              if (duplicate) { if (duplicate.body===body) return; downgrade(binding,"conflicting-record");refusal="Observation record conflict";return }
              const size=totals(key)
              if (bindingState.uncertainty.includes("overflow") || size.count>=maxEntries || bytes>maxBytes-size.bytes) { downgrade(binding,"overflow");refusal="Observation limit exceeded";return }
              db.query("INSERT INTO observation_records(key,id,ordinal,body) VALUES (?,?,?,?)").run(key,record.id,size.count,body)
            }).immediate()
            if(refusal)fail(refusal)
          },
          snapshot(): ObservationSnapshot {
            guarded()
            try { return db.transaction(() => { const value=current(binding);return {binding,records:readRecords(binding),uncertainty:value.uncertainty} }).immediate() }
            catch(error) {try{downgrade(binding,"corrupt-store")}catch{/* Preserve the read failure. */}throw error}
          },
          invalidate(reason) { downgrade(binding,reason) },
        }
      },
      close() { if(closed)return;closed=true;db.close() },
    }
  } catch(error) {closed=true;db.close();throw error}
}
