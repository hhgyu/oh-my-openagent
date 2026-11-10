import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { openChildJournal, probeJournalOwner, type DurableChildJournal } from "./child-journal"
import type { ChildRecord } from "./session-backend"

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}
const directories: string[] = [], opened: DurableChildJournal[] = []
afterEach(() => { for (const journal of opened.splice(0)) journal.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
function path() { const dir = mkdtempSync(join(tmpdir(), "omo-child-journal-")); directories.push(dir); return join(dir, "state.sqlite") }
async function open(file = path(), probeOwner?: typeof probeJournalOwner) { const journal = await openChildJournal({ path: file, probeOwner }); opened.push(journal); return journal }
function record(owner: string, key = "child"): ChildRecord { return { key, owner, revision: 0, locator: { format: 1, backendID: "host", location: "/project", hostVersion: "2.2.6", parentID: "parent" as never, sessionID: "child" as never, generation: 1 }, phase: "creating", admission: "none", receipts: {} } }

test("insert is exclusive across actual SQLite connections and never overwrites an existing key", async () => {
 const file=path(), a=await open(file), b=await open(file)
 await a.claim("child",a.owner,record(a.owner))
 await expect(b.claim("child",b.owner,record(b.owner))).rejects.toThrow("already exists")
 expect((await b.read("child"))?.owner).toBe(a.owner)
})

test("own turn descriptor survives actual SQLite close/reopen without losing reserved receipts",async()=>{
 const file=path(),a=await open(file)
 const initial={...record(a.owner),turn:{nativeEpoch:2,observationKey:"owned-turn:2",firstInputID:"msg_owned_turn"},receipts:{msg_reserved:"pending" as const}}
 await a.claim("child",a.owner,initial);a.close();const b=await open(file),row=await b.read("child")
 expect((row as typeof initial).turn).toEqual(initial.turn);expect(row?.receipts).toEqual(initial.receipts)
})

test("invalid own turn descriptors refuse before actual journal insertion",async()=>{
 const a=await open()
 for(const turn of [{nativeEpoch:-1,observationKey:"bad"},{nativeEpoch:1,observationKey:""},{nativeEpoch:1,observationKey:"key",unexpected:true},{nativeEpoch:1,observationKey:"key",firstInputID:""}]){
  await expect(a.claim("child",a.owner,{...record(a.owner),turn})).rejects.toThrow("Invalid")
  expect(await a.read("child")).toBeUndefined()
 }
})
test("same-owner reload advances a durable fence and stale writes fail", async () => {
 const a=await open();const first=await a.claim("child",a.owner,record(a.owner));const next=await a.claim("child",a.owner)
 expect(next.revision).toBe(1)
 await expect(a.write(first,{...first,revision:1,phase:"staged"})).rejects.toThrow("Stale")
 await a.write(next,{...next,revision:2,phase:"staged"})
 expect((await a.read("child"))?.phase).toBe("staged")
})
test("committed bytes survive close/reopen and released custody transfers with a newer revision", async () => {
 const file=path(), a=await open(file);await a.claim("child",a.owner,record(a.owner));a.close()
 const b=await open(file);const recovered=await b.claim("child",b.owner)
 expect(recovered.owner).toBe(b.owner);expect(recovered.revision).toBe(1)
 await expect(a.read("child")).rejects.toThrow("closed")
})
test("live and unknown owners are never stolen", async () => {
 for (const verdict of ["alive","unknown"] as const) {
  const file=path(),a=await open(file),b=await open(file,async()=>verdict);await a.claim("child",a.owner,record(a.owner))
  await expect(b.claim("child",b.owner)).rejects.toThrow("live or unverified")
  expect((await a.read("child"))?.revision).toBe(0)
 }
})
test("OS probe sees the actual process alive and null identity is not proof of death", async () => {
 expect(await probeJournalOwner({pid:process.pid,start:null})).toBe("unknown")
 const file=path(),a=await open(file),b=await open(file);await a.claim("child",a.owner,record(a.owner))
 expect(b.owner).not.toBe(a.owner)
 await expect(b.claim("child",b.owner)).rejects.toThrow("live or unverified")
})
test("competing dead-owner claims compare the post-probe snapshot atomically", async () => {
 const file=path(),a=await open(file);await a.claim("child",a.owner,record(a.owner))
 let release!:()=>void;const wait=new Promise<void>(yes=>release=yes)
 const b=await open(file,async()=>{await wait;return "dead"}),c=await open(file,async()=>{await wait;return "dead"})
 const claims=[b.claim("child",b.owner),c.claim("child",c.owner)];release()
 const results=await Promise.allSettled(claims)
 expect(results.filter(x=>x.status==="fulfilled")).toHaveLength(1)
 expect(results.filter(x=>x.status==="rejected")).toHaveLength(1)
})
test("closing during an owner probe prevents a late transfer", async () => {
 const file=path(),a=await open(file);await a.claim("child",a.owner,record(a.owner))
 let release!:()=>void;const wait=new Promise<void>(yes=>release=yes)
 const b=await open(file,async()=>{await wait;return "dead"});const pending=b.claim("child",b.owner);b.close();release()
 await expect(pending).rejects.toThrow("closed");expect((await a.read("child"))?.owner).toBe(a.owner)
})
test("foreign owner, identity replacement, revision jumps and malformed records are refused", async () => {
 const a=await open(),initial=record(a.owner);await a.claim("child",a.owner,initial)
 await expect(a.claim("child","foreign")).rejects.toThrow("Foreign")
 await expect(a.write(initial,{...initial,revision:2})).rejects.toThrow("fence")
 await expect(a.write(initial,{...initial,revision:1,locator:{...initial.locator,sessionID:"other" as never}})).rejects.toThrow("identity")
 await expect(a.claim("bad",a.owner,{...initial,key:"bad",phase:"invalid" as never})).rejects.toThrow("Invalid")
})
test("foreign databases and symlink database paths are rejected without adopting their data", async () => {
 const file=path();const db=new Database(file);db.exec("CREATE TABLE unrelated (value TEXT)");db.close()
 await expect(openChildJournal({path:file})).rejects.toThrow("Foreign")
 const alias=join(defined(directories.at(-1)),"alias.sqlite");symlinkSync(file,alias,"file")
 await expect(openChildJournal({path:alias})).rejects.toThrow("link")
})
test("a corrupted record fails closed instead of erasing custody", async () => {
 const file=path(),a=await open(file);await a.claim("child",a.owner,record(a.owner));const db=new Database(file)
 db.query("UPDATE children SET body=? WHERE key=?").run('{"key":"child"}',"child");db.close()
 await expect(a.read("child")).rejects.toThrow("Corrupt")
})

test("prototype-shaped receipt IDs cannot disappear during schema normalization", async () => {
 const a=await open(),initial=record(a.owner)
 for (const key of ["__proto__","constructor","prototype"]) {
  await expect(a.claim("child",a.owner,{...initial,receipts:{[key]:"pending"}})).rejects.toThrow("Unsafe")
  expect(await a.read("child")).toBeUndefined()
 }
})
test("unsafe SQLite versions are rejected even on an otherwise empty file", async () => {
 const file=path(),db=new Database(file);db.exec("PRAGMA user_version=2");db.close()
 await expect(openChildJournal({path:file})).rejects.toThrow("unsupported")
})


test("synchronous observation custody validates the whole current row and rejects renewed fences", async () => {
 const journal=await open(), first=await journal.claim("child",journal.owner,record(journal.owner))
 expect(()=>journal.assertCurrent(first)).not.toThrow()
 expect(()=>journal.assertCurrent({...first,phase:"accepted"})).toThrow("fence")
 expect(()=>journal.assertCurrent({...first,owner:"foreign"})).toThrow("Foreign")
 const renewed=await journal.claim("child",journal.owner)
 expect(()=>journal.assertCurrent(first)).toThrow("fence")
 expect(()=>journal.assertCurrent(renewed)).not.toThrow()
 journal.close()
 expect(()=>journal.assertCurrent(renewed)).toThrow("closed")
})

test("synchronous observation refuses corrupted durable custody", async () => {
 const file=path(),journal=await open(file),first=await journal.claim("child",journal.owner,record(journal.owner))
 const db=new Database(file);db.query("UPDATE children SET body=? WHERE key=?").run('{"key":"child"}',"child");db.close()
 expect(()=>journal.assertCurrent(first)).toThrow("Corrupt")
})
test("synchronous checkpoint commits exact SQLite CAS before immediate current-row observation",async()=>{
 const journal=await open(),first=await journal.claim("child",journal.owner,record(journal.owner)),next={...first,revision:first.revision+1,phase:"staged" as const}
 expect(journal.writeSync(first,next)).toBeUndefined();expect(journal.assertCurrent(next)).toBeUndefined();expect(()=>journal.assertCurrent(first)).toThrow("fence")
 expect(()=>journal.writeSync(first,next)).toThrow("Stale");expect(await journal.read("child")).toEqual(next)
 const accepted={...next,revision:next.revision+1,phase:"accepted" as const};await journal.write(next,accepted);expect(()=>journal.assertCurrent(accepted)).not.toThrow()
 journal.close();expect(()=>journal.writeSync(accepted,{...accepted,revision:accepted.revision+1})).toThrow("closed")
})

// Storage contract: the durable parking descriptor (parked is NOT closed) round-trips exactly and
// malformed parking state can never be persisted as a receipt.
test("parking descriptor survives actual SQLite reopen with exact ordered rules while phase stays truthful", async () => {
 const file=path(),a=await open(file),initial=await a.claim("child",a.owner,{...record(a.owner),phase:"accepted"})
 const parking={format:1 as const,state:"parked" as const,id:"park-1",owner:a.owner,original:{present:true,rules:[{action:"read",resource:"*",effect:"allow" as const},{action:"edit",resource:"/x",effect:"ask" as const}]},
  fingerprint:"a".repeat(64),marker:"omo.native-task.parking" as const,agent:"build",nativeEpoch:3,intentRevision:1,readback:"verified" as const}
 a.writeSync(initial,{...initial,revision:1,parking});a.close()
 const row=await (await open(file)).read("child")
 expect(row?.parking).toEqual(parking);expect(row?.phase).toBe("accepted")
})

test("malformed parking descriptors refuse before actual journal insertion", async () => {
 const a=await open(),base={format:1 as const,state:"intent" as const,id:"park-1",owner:a.owner,original:{present:false,rules:[]},fingerprint:"b".repeat(64),marker:"omo.native-task.parking" as const,intentRevision:1}
 for(const parking of [{...base,state:"parked" as const},{...base,state:"conflict" as const},{...base,readback:"verified" as const},{...base,fingerprint:"short"},{...base,marker:"foreign.marker"},{...base,original:{present:true,rules:[{action:"*",resource:"*",effect:"maybe"}]}},{...base,token:"capability"}]){
  await expect(a.claim("child",a.owner,{...record(a.owner),parking} as never)).rejects.toThrow("Invalid")
  expect(await a.read("child")).toBeUndefined()
 }
})
