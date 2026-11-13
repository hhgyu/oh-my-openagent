import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openCompletionIntentJournal } from "./completion-intent-journal"

test("same logical source cannot submit again under a random new intent ID", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omo-completion-intent-"))
  const journal = await openCompletionIntentJournal({
    path: join(dir, "state.sqlite"),
    namespace: "/unit/project",
    ownerIdentity: { pid: 1, start: "controlled-unit-identity" },
  })
  try {
    const envelope = {
      intentID: "first",
      receiver: {
        backendID: "opencode",
        directory: "/unit/project",
        hostVersion: "2.2.6",
        sessionID: "parent",
        rootSessionID: "root",
        leaseGeneration: 1,
        registryGeneration: 1,
      },
      sources: [
        {
          taskId: "task",
          nativeEpoch: 0,
          parentSessionId: "parent",
          rootSessionId: "root",
          createdAt: "2026-11-09",
          provenance: { claim: "one" },
        },
      ],
      message: { content: "canonical unit completion" },
    }
    journal.insertQueued(envelope)
    expect(() => journal.insertQueued({ ...envelope, intentID: "random-new" })).toThrow("source")
  } finally {
    await journal.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

import { afterEach, spyOn } from "bun:test"
import { Database } from "bun:sqlite"
import {
  type CompletionIntent,
  type CompletionIntentEnvelope,
  type CompletionIntentJournal,
  type CompletionIntentJournalOptions,
} from "./completion-intent-journal"

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}
const dirs: string[] = [],
  journals: CompletionIntentJournal[] = []
afterEach(async () => {
  for (const journal of journals.splice(0)) await journal.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function file() {
  const dir = mkdtempSync(join(tmpdir(), "omo-completion-C1J-"))
  dirs.push(dir)
  return join(dir, "intent.sqlite")
}
async function open(path = file(), extra: Partial<CompletionIntentJournalOptions> = {}) {
  const journal = await openCompletionIntentJournal({
    path,
    namespace: "/unit/project",
    ownerIdentity: { pid: 333, start: "CONTROLLED-unit-owner" },
    ...extra,
  })
  journals.push(journal)
  return journal
}
function envelope(intentID = "one", taskId = "task"): CompletionIntentEnvelope {
  return {
    intentID,
    receiver: {
      backendID: "opencode",
      directory: "/unit/project",
      hostVersion: "2.2.6",
      sessionID: "parent",
      rootSessionID: "root",
      leaseGeneration: 1,
      registryGeneration: 2,
    },
    sources: [
      {
        taskId,
        nativeEpoch: 0,
        parentSessionId: "parent",
        rootSessionId: "root",
        createdAt: "2026-11-09T00:00:00Z",
        provenance: { claim: "controlled-unit-claim", journalRevision: 1 },
      },
    ],
    message: { content: "unit canonical payload", details: [taskId] },
  }
}
function update(
  journal: CompletionIntentJournal,
  previous: CompletionIntent,
  change: Partial<CompletionIntent>,
): CompletionIntent {
  const next = { ...previous, ...change, revision: previous.revision + 1 }
  journal.writeSync(previous, next)
  return defined(journal.read(next.intentID))
}
function accepted(journal: CompletionIntentJournal, previous: CompletionIntent): CompletionIntent {
  const { reason: _reason, ...base } = previous
  const next: CompletionIntent = {
    ...base,
    revision: previous.revision + 1,
    phase: "accepted",
    acceptance: { kind: "prompt", id: "CONTROLLED-unit-ACK", sessionID: "parent" },
  }
  journal.writeSync(previous, next)
  return defined(journal.read(next.intentID))
}
function raw(path: string, run: (db: Database) => void) {
  const db = new Database(path)
  try {
    run(db)
  } finally {
    db.close()
  }
}

test("strict SQLite rows survive reopen and snapshots have no mutable input aliases", async () => {
  const path = file(),
    a = await open(path),
    input = envelope(),
    row = a.insertQueued(input)
  expect(Object.isFrozen(row.sources[0])).toBe(true)
  expect(row).not.toBe(input)
  await a.close()
  const b = await open(path)
  expect(b.read(row.intentID)).toEqual(row)
  const claimed = await b.claim(row.intentID)
  expect(claimed.owner).toBe(b.owner)
  expect(claimed.revision).toBe(1)
  expect(b.findBySource(defined(row.sources[0]))).toEqual(claimed)
})
test("ephemeral custody, lease, registry, version and receiver changes cannot bypass logical uniqueness", async () => {
  const journal = await open(),
    input = envelope()
  journal.insertQueued(input)
  for (const receiver of [
    { ...input.receiver, leaseGeneration: 99, registryGeneration: 88, hostVersion: "future" },
    { ...input.receiver, directory: "/other", backendID: "other" },
  ]) {
    expect(() =>
      journal.insertQueued({
        ...input,
        intentID: crypto.randomUUID(),
        receiver,
        sources: input.sources.map((source) => ({
          ...source,
          provenance: { claim: "renewed", journalRevision: 100, owner: "new" },
        })),
      }),
    ).toThrow("source")
  }
})
test("different logical epochs can coexist but duplicate sources in one envelope are rejected", async () => {
  const journal = await open(),
    input = envelope()
  journal.insertQueued(input)
  const next = { ...input, intentID: "epoch1", sources: input.sources.map((source) => ({ ...source, nativeEpoch: 1 })) }
  expect(journal.insertQueued(next).intentID).toBe("epoch1")
  expect(() =>
    journal.insertQueued({ ...input, intentID: "dup", sources: [...input.sources, ...input.sources] }),
  ).toThrow("Duplicate")
})
test("multi-source conflict rolls back all row and index writes atomically", async () => {
  const journal = await open()
  journal.insertQueued(envelope("existing", "taken"))
  expect(() =>
    journal.insertQueued({
      ...envelope("batch", "free"),
      sources: [...envelope("x", "free").sources, ...envelope("y", "taken").sources],
    }),
  ).toThrow("source")
  expect(journal.read("batch")).toBeUndefined()
  expect(journal.findBySource(defined(envelope("x", "free").sources[0]))).toBeUndefined()
  expect(journal.insertQueued(envelope("free-only", "free")).intentID).toBe("free-only")
})
test("strict envelope rejects unsupported/noninert JSON before inserting", async () => {
  const journal = await open()
  let getterCalls = 0
  const getter = Object.defineProperty({}, "secret", {
    enumerable: true,
    get() {
      getterCalls++
      return "no"
    },
  })
  const cycle: { self?: unknown } = {}
  cycle.self = cycle
  for (const message of [
    undefined,
    { x: undefined },
    { x: NaN },
    { x: Infinity },
    new Date(),
    () => 1,
    [undefined],
    new Array(100_000_000),
    getter,
    cycle,
    { constructor: "unsafe" },
  ]) {
    expect(() => journal.insertQueued({ ...envelope(), message } as unknown as CompletionIntentEnvelope)).toThrow()
    expect(journal.read("one")).toBeUndefined()
  }
  expect(getterCalls).toBe(0)
  expect(() => journal.insertQueued({ ...envelope(), unexpected: true } as CompletionIntentEnvelope)).toThrow()
  expect(() => journal.insertQueued({ ...envelope(), message: "x".repeat(2_097_153) })).toThrow()
})
test("foreign namespace/application/version and corrupted row/index fail closed", async () => {
  const path = file(),
    journal = await open(path)
  const row = journal.insertQueued(envelope())
  await expect(open(path, { namespace: "/foreign" })).rejects.toThrow("namespace")
  raw(path, (db) => {
    db.query("UPDATE intents SET body=? WHERE id=?").run('{"intentID":"one"}', row.intentID)
  })
  expect(() => journal.read(row.intentID)).toThrow("Corrupt")
  const foreign = file()
  raw(foreign, (db) => {
    db.exec("CREATE TABLE alien(value TEXT)")
  })
  await expect(open(foreign)).rejects.toThrow("Foreign")
  const version = file()
  raw(version, (db) => {
    db.exec("PRAGMA user_version=2")
  })
  await expect(open(version)).rejects.toThrow("unsupported")
  const indexed = file(),
    other = await open(indexed)
  other.insertQueued(envelope())
  raw(indexed, (db) => {
    db.exec("DELETE FROM sources")
  })
  expect(() => other.read("one")).toThrow("index")
})
test("full-row CAS rejects stale owner/revision, immutable content and revision jumps", async () => {
  const journal = await open(),
    first = journal.insertQueued(envelope()),
    next = update(journal, first, { phase: "dispatching" })
  expect(() => journal.writeSync(first, { ...first, revision: 1, phase: "dispatching" })).toThrow("Stale")
  expect(() => journal.writeSync(next, { ...next, revision: next.revision + 2 })).toThrow("fence")
  expect(() => journal.writeSync(next, { ...next, revision: next.revision + 1, owner: "foreign" })).toThrow("fence")
  expect(() => journal.writeSync(next, { ...next, revision: next.revision + 1, message: "changed" })).toThrow(
    "immutable",
  )
  expect(() => journal.assertCurrent({ ...next, phase: "uncertain", reason: "controlled" })).toThrow("fence")
})
test("phase gate forbids queued acceptance and every accepted/uncertain resend", async () => {
  const journal = await open(),
    first = journal.insertQueued(envelope())
  expect(() => accepted(journal, first)).toThrow("phase")
  const dispatching = update(journal, first, { phase: "dispatching" })
  const uncertain = update(journal, dispatching, { phase: "uncertain", reason: "CONTROLLED lost ACK" })
  const { reason: _reason, ...base } = uncertain
  expect(() => update(journal, base as CompletionIntent, { phase: "queued_durable" })).toThrow()
  expect(() => journal.insertQueued({ ...envelope(), intentID: "again" })).toThrow("source")
  const ack = accepted(journal, uncertain)
  expect(ack.intentID).toBe(first.intentID)
  expect(() => update(journal, ack, { phase: "dispatching" })).toThrow()
  expect(() => journal.insertQueued({ ...envelope(), intentID: "new-again" })).toThrow("source")
})
test("late same-intent ACK resolves uncertain without enabling another submit or changing accepted identity", async () => {
  const journal = await open()
  const dispatching = update(journal, journal.insertQueued(envelope()), { phase: "dispatching" })
  const uncertain = update(journal, dispatching, { phase: "uncertain", reason: "CONTROLLED ambiguity" })
  const row = accepted(journal, uncertain)
  expect(row.bookkeeping).toBe("pending")
  expect(() => update(journal, row, { acceptance: { kind: "prompt", id: "different", sessionID: "parent" } })).toThrow(
    "immutable",
  )
  const done = update(journal, row, { bookkeeping: "complete" })
  expect(journal.findBySource(defined(done.sources[0]))).toEqual(done)
  expect(() => journal.insertQueued({ ...envelope(), intentID: "after-repair" })).toThrow("source")
})
test("definitive failure retains membership until canonical bookkeeping complete then releases atomically", async () => {
  const journal = await open()
  const first = journal.insertQueued(envelope())
  const failed = update(journal, first, { phase: "definitively_failed", reason: "CONTROLLED pre-admission refusal" })
  expect(() => journal.insertQueued({ ...envelope(), intentID: "too-early" })).toThrow("source")
  const complete = update(journal, failed, { bookkeeping: "complete" })
  expect(journal.findBySource(defined(first.sources[0]))).toBeUndefined()
  const next = journal.insertQueued({ ...envelope(), intentID: "next" })
  expect(journal.read(first.intentID)).toEqual(complete)
  expect(() => accepted(journal, complete)).toThrow()
  expect(() => update(journal, complete, { bookkeeping: "pending" })).toThrow("reopen")
  const history = update(journal, complete, {})
  expect(history.phase).toBe("definitively_failed")
  expect(journal.findBySource(defined(next.sources[0]))).toEqual(next)
})
test("recovered accepted intent preserves business state and source no-resubmit across owner turnover", async () => {
  const path = file(),
    a = await open(path)
  const row = accepted(a, update(a, a.insertQueued(envelope()), { phase: "dispatching" }))
  await a.close()
  const b = await open(path),
    claimed = await b.claim(row.intentID)
  expect(claimed.phase).toBe("accepted")
  expect(claimed.acceptance).toEqual(row.acceptance)
  expect(claimed.bookkeeping).toBe("pending")
  expect(() => b.insertQueued({ ...envelope(), intentID: "new-owner-replay" })).toThrow("source")
  const done = update(b, claimed, { bookkeeping: "complete" })
  expect(done.acceptance).toEqual(row.acceptance)
})
test("controlled alive/unknown owner probes cannot take custody", async () => {
  for (const verdict of ["alive", "unknown"] as const) {
    const path = file(),
      a = await open(path),
      b = await open(path, { probeOwner: async () => verdict })
    a.insertQueued(envelope())
    await expect(b.claim("one")).rejects.toThrow("live or unverified")
    expect(defined(a.read("one")).owner).toBe(a.owner)
  }
})
test("controlled dead owner takeover checks post-probe row and owner snapshots", async () => {
  const path = file(),
    a = await open(path)
  const row = a.insertQueued(envelope())
  const gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>()
  const b = await open(path, {
    probeOwner: async () => {
      entered.resolve()
      await gate.promise
      return "dead"
    },
  })
  const claim = b.claim("one")
  await entered.promise
  update(a, row, { phase: "dispatching" })
  gate.resolve()
  await expect(claim).rejects.toThrow("changed during owner probe")
  const c = await open(path, { probeOwner: async () => "dead" })
  const won = await c.claim("one")
  expect(won.owner).toBe(c.owner)
  expect(won.phase).toBe("dispatching")
})
test("owner snapshot change during held probe is fenced independently of intent revision", async () => {
  const path = file(),
    a = await open(path)
  a.insertQueued(envelope())
  const gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>()
  const b = await open(path, {
    probeOwner: async () => {
      entered.resolve()
      await gate.promise
      return "dead"
    },
  })
  const claim = b.claim("one")
  await entered.promise
  await a.close()
  gate.resolve()
  await expect(claim).rejects.toThrow("changed during owner probe")
  expect((await b.claim("one")).owner).toBe(b.owner)
})
test("close joins the ORIGINAL pending probe and cannot release owner or claim late", async () => {
  const path = file(),
    a = await open(path)
  a.insertQueued(envelope())
  const gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>()
  const b = await open(path, {
    probeOwner: async () => {
      entered.resolve()
      await gate.promise
      return "dead"
    },
  })
  const claim = b.claim("one")
  void claim.catch(() => {})
  await entered.promise
  let closed = false
  const close = b.close()
  expect(b.close()).toBe(close)
  void close.then(() => {
    closed = true
  })
  try {
    await Promise.resolve()
    expect(closed).toBe(false)
    raw(path, (db) => {
      expect(
        JSON.parse(
          defined(db.query<{ body: string }, [string]>("SELECT body FROM owners WHERE token=?").get(b.owner)).body,
        ).released,
      ).toBe(0)
    })
    expect(() => b.read("one")).toThrow("closed")
    expect(() => b.claim("one")).toThrow("closed")
  } finally {
    gate.resolve()
  }
  await expect(claim).rejects.toThrow("closed")
  await close
  expect(closed).toBe(true)
  expect(defined(a.read("one")).owner).toBe(a.owner)
})
test("failed physical database close stays visible and retryable", async () => {
  const journal = await open()
  journal.insertQueued(envelope())
  const original = Database.prototype.close
  const spy = spyOn(Database.prototype, "close").mockImplementationOnce(function (this: Database) {
    throw Error("CONTROLLED physical close fault")
  })
  try {
    await expect(journal.close()).rejects.toThrow("physical close fault")
    expect(() => journal.read("one")).toThrow("closed")
  } finally {
    spy.mockRestore()
  }
  expect(Database.prototype.close).toBe(original)
  await journal.close()
  await journal.close()
})
test("prototype-shaped logical JSON, malformed sources and forged bootstrap token are refused", async () => {
  const journal = await open(),
    input = envelope()
  expect(() =>
    journal.insertQueued({
      ...input,
      sources: input.sources.map((source) => ({ ...source, extra: true })),
    } as CompletionIntentEnvelope),
  ).toThrow()
  expect(() =>
    journal.insertQueued({
      ...input,
      sources: input.sources.map((source) => ({ ...source, parentSessionId: "other" })),
    }),
  ).toThrow("receiver")
  await expect(
    open(file(), {
      ownerIdentity: { pid: 1, start: "unit", token: journal.owner } as CompletionIntentJournalOptions["ownerIdentity"],
    }),
  ).rejects.toThrow()
})

test("dangling source references and missing owner rows are corruption, never adopted as fresh work", async () => {
  const path = file(),
    journal = await open(path)
  journal.insertQueued(envelope())
  raw(path, (db) => {
    db.exec("DELETE FROM intents")
  })
  expect(() => journal.findBySource(defined(envelope().sources[0]))).toThrow("reference")
  expect(() => journal.insertQueued({ ...envelope("one", "other") })).toThrow("orphan")
  const ownedPath = file(),
    other = await open(ownedPath)
  other.insertQueued(envelope())
  raw(ownedPath, (db) => {
    db.exec("DELETE FROM owners")
  })
  expect(() => other.read("one")).toThrow("owner")
})
test("fresh process executes real SQLite journal with SDK and UI runtime poison", () => {
  const url = new URL("./completion-intent-journal.ts", import.meta.url).href
  const script = `
let forbidden=0;
Bun.plugin({name:"C1J-cold",setup(b){b.onResolve({filter:/^(@code-yeongyu\\/senpi|@earendil-works\\/pi-tui|@opencode\\/plugin|@oh-my-opencode\\/omo-senpi)(\\/|$)/},a=>{forbidden++;throw Error("FORBIDDEN:"+a.path)});b.onLoad({filter:/[\\\\/]packages[\\\\/]omo-senpi[\\\\/]/},()=>{forbidden++;throw Error("FORBIDDEN_NATIVE_ADAPTER")})}});
const {mkdtempSync,rmSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
const {openCompletionIntentJournal}=await import(${JSON.stringify(url)});const dir=mkdtempSync(join(tmpdir(),"C1J-cold-"));let journal;
try{journal=await openCompletionIntentJournal({path:join(dir,"state.sqlite"),namespace:"unit",ownerIdentity:{pid:1,start:"CONTROLLED"}});let row=journal.insertQueued({intentID:"one",receiver:{backendID:"unit",directory:"unit",hostVersion:"2.2.6",sessionID:"parent",rootSessionID:"root",leaseGeneration:1,registryGeneration:2},sources:[{taskId:"task",nativeEpoch:0,parentSessionId:"parent",rootSessionId:"root",createdAt:"unit",provenance:null}],message:{content:"unit"}});journal.writeSync(row,{...row,revision:1,phase:"dispatching"});row=journal.read("one");journal.writeSync(row,{...row,revision:2,phase:"accepted",acceptance:{kind:"prompt",id:"CONTROLLED-ACK",sessionID:"parent"}});if(journal.read("one").phase!=="accepted"||forbidden)throw Error("Cold contract failed");console.log(JSON.stringify({forbidden,realSQLite:true,controlledACKOnly:true}))}finally{await journal?.close();rmSync(dir,{recursive:true,force:true})}`
  const child = Bun.spawnSync([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe", timeout: 5000 })
  expect(new TextDecoder().decode(child.stderr)).toBe("")
  expect(child.exitCode).toBe(0)
  expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({
    forbidden: 0,
    realSQLite: true,
    controlledACKOnly: true,
  })
})

test("owner probe receives immutable copied custody snapshot, not mutable comparison aliases", async () => {
  const path = file(),
    a = await open(path)
  a.insertQueued(envelope())
  const b = await open(path, {
    probeOwner: async (owner) => {
      expect(Object.isFrozen(owner)).toBe(true)
      expect(Reflect.set(owner, "start", "forged")).toBe(false)
      return "dead" // Controlled unit fixture, not actual OS death evidence.
    },
  })
  expect((await b.claim("one")).owner).toBe(b.owner)
})
test("record limit measures UTF8 bytes as well as bounding traversal and string units", async () => {
  const journal = await open()
  expect(() => journal.insertQueued({ ...envelope(), message: "界".repeat(800_000) })).toThrow("JSON")
  expect(journal.read("one")).toBeUndefined()
})

test("aggregate object keys are rejected before Zod copies or serializes oversized payload", async () => {
  const journal = await open()
  const message = Object.fromEntries(
    Array.from({ length: 600 }, (_, index) => [String(index).padStart(4, "0") + "k".repeat(4090), true]),
  )
  const spy = spyOn(JSON, "stringify")
  try {
    expect(() => journal.insertQueued({ ...envelope(), message })).toThrow()
    expect(
      spy.mock.calls.some(
        ([value]) => value && typeof value === "object" && "message" in value && value.message === message,
      ),
    ).toBe(false)
  } finally {
    spy.mockRestore()
  }
})
for (const phase of ["accepted", "uncertain"] as const)
  test(`missing source index cannot replay ${phase} intent through negative lookup/new insert`, async () => {
    const path = file(),
      journal = await open(path)
    const dispatching = update(journal, journal.insertQueued(envelope()), { phase: "dispatching" })
    if (phase === "accepted") accepted(journal, dispatching)
    else update(journal, dispatching, { phase: "uncertain", reason: "CONTROLLED lost ACK" })
    raw(path, (db) => {
      db.exec("DELETE FROM sources")
    }) // Persisted-index corruption fixture, not an OS attack claim.
    let findFailure: unknown, insertFailure: unknown, inserted: unknown
    try {
      journal.findBySource(defined(envelope().sources[0]))
    } catch (error) {
      findFailure = error
    }
    try {
      inserted = journal.insertQueued({ ...envelope(), intentID: "must-not-replay" })
    } catch (error) {
      insertFailure = error
    }
    expect(Boolean(inserted)).toBe(false)
    expect(String(findFailure)).toContain("index")
    expect(String(insertFailure)).toContain("index")
    expect(journal.read("must-not-replay")).toBeUndefined()
  })
