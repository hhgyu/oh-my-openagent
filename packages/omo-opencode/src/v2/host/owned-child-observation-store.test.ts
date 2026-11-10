import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openOwnedChildObservationStore } from "./owned-child-observation-store"
import type { ChildLocator } from "./session-backend"
import type { OwnedChildObservationStore, ObservationRecord } from "./owned-child-observation-types"

function defined<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error("Expected value to be defined")
  return value
}
const roots: string[] = [], stores: OwnedChildObservationStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function path() { const root = mkdtempSync(join(tmpdir(), "omo-observation-store-")); roots.push(root); return join(root, "observations.sqlite") }
function open(file = path(), options = {}) { const store = openOwnedChildObservationStore({ path: file, ...options }); stores.push(store); return store }
function locator(): ChildLocator { return { format: 1, backendID: "actual-host", location: process.cwd(), hostVersion: "2.2.6", parentID: "parent" as never, sessionID: "child" as never, generation: 1 } }
function host(id = "event", seq = 0): Extract<ObservationRecord, { kind: "host" }> { return { kind: "host", id, event: { id, type: "session.execution.started", created: 1, sessionID: "child", durable: { aggregateID: "child", seq, version: 1 }, data: {} } } }
const bind = (store: OwnedChildObservationStore, guard = () => {}) => store.bind({ key: "owned", locator: locator(), guard })

test("real SQLite rows survive reopen; rebind fences old token and marks historic data uncertain", () => {
 const file=path(),a=open(file),first=bind(a);first.append(host());a.close()
 const b=open(file),next=bind(b)
 expect(next.snapshot().records).toEqual([host()]);expect(next.snapshot().uncertainty).toContain("rebound")
 expect(next.binding.token).not.toBe(first.binding.token);expect(()=>first.snapshot()).toThrow("closed")
})
test("two SQLite connections compare binding token; old invalidation cannot downgrade a replacement", () => {
 const file=path(),a=bind(open(file)),b=bind(open(file))
 expect(()=>a.append(host())).toThrow("binding");expect(()=>a.snapshot()).toThrow("binding")
 a.invalidate("stale-owner");expect(b.snapshot().uncertainty).not.toContain("stale-owner")
})
test("guard loss persists only current binding uncertainty, then throws identical error", () => {
 const failure={ownership:"lost"};let alive=true
 const store=open(),child=bind(store,()=>{if(!alive)throw failure});child.append(host());alive=false
 try{child.append({kind:"stop",id:"stop"});throw Error("unexpected")}catch(error){expect(error).toBe(failure)}
 const next=bind(store);expect(next.snapshot().uncertainty).toContain("custody-lost");expect(next.snapshot().records).toEqual([host()])
})
test("duplicate exact bodies are idempotent; conflicts persist uncertainty and refuse", () => {
 const child=bind(open());child.append(host());child.append(host());expect(child.snapshot().records).toHaveLength(1)
 expect(()=>child.append(host("event",2))).toThrow("conflict");expect(child.snapshot().uncertainty).toContain("conflicting-record")
})
test("entry/byte overflow is sticky and never evicts earlier coverage", () => {
 const child=bind(open(undefined,{maxEntries:1}));child.append(host());expect(()=>child.append({kind:"stop",id:"stop"})).toThrow("limit")
 expect(child.snapshot().records).toEqual([host()]);expect(child.snapshot().uncertainty).toContain("overflow")
 const tiny=bind(open(undefined,{maxBytes:8}));expect(()=>tiny.append(host())).toThrow("limit");expect(tiny.snapshot().records).toEqual([])
})
test("foreign session/aggregate and unsafe secret fields fail closed without storing values", () => {
 for(const bad of [{...host(),event:{...host().event,sessionID:"foreign"}}, {...host(),event:{...host().event,durable:{aggregateID:"foreign",seq:1,version:1}}}, {...host(),headers:{Authorization:"synthetic-sensitive"}}, {...host(),event:{...host().event,data:{headers:{Authorization:"synthetic-sensitive"}}}}]) {
  const child=bind(open());expect(()=>child.append(bad as never)).toThrow();expect(child.snapshot().records).toEqual([]);expect(JSON.stringify(child.snapshot())).not.toContain("synthetic-sensitive")
 }
})
test("foreign database, malformed locator and closed-store operations refuse", () => {
 const file=path(),db=new Database(file);db.exec("CREATE TABLE foreign_table(value TEXT)");db.close();expect(()=>open(file)).toThrow("Foreign")
 const store=open();expect(()=>store.bind({key:"owned",locator:{...locator(),location:"relative"},guard:()=>{}})).toThrow("locator")
 const child=bind(store);store.close();expect(()=>child.append(host())).toThrow("closed");expect(()=>bind(store)).toThrow("closed");expect(()=>child.invalidate("late")).toThrow("closed")
})
test("corrupt persisted JSON/identity/ordinal is refused by reads and later appends", () => {
 for(const change of ["UPDATE observation_records SET body='broken'", "UPDATE observation_records SET id='different'", "UPDATE observation_records SET ordinal=4"]) {
  const file=path(),store=open(file),child=bind(store);child.append(host());const db=new Database(file);db.exec(change)
  expect(()=>child.snapshot()).toThrow();expect(()=>child.append({kind:"stop",id:"later"})).toThrow("Corrupt")
  const reasons=JSON.parse((db.query("SELECT uncertainty FROM observation_bindings").get() as {uncertainty:string}).uncertainty)
  expect(reasons).toContain("corrupt-store");expect((db.query("SELECT count(*) as count FROM observation_records").get() as {count:number}).count).toBe(1);db.close()
 }
})
test("strict database schema and future version cannot be adopted", () => {
 for(const mutation of ["CREATE TABLE extra(value TEXT)", "CREATE TRIGGER injection AFTER INSERT ON observation_records BEGIN SELECT 1; END", "PRAGMA user_version=2"]) {
  const file=path(),store=open(file);bind(store);store.close();const db=new Database(file);db.exec(mutation);db.close();expect(()=>open(file)).toThrow("Foreign")
 }
})
test("guard is required synchronously and runs before bind/append/snapshot but not invalidate", () => {
 const store=open();expect(()=>store.bind({key:"owned",locator:locator(),guard:undefined as never})).toThrow("guard")
 expect(()=>store.bind({key:"owned",locator:locator(),guard:async()=>{}})).toThrow("Synchronous")
 let calls=0;const child=bind(store,()=>{calls++});expect(calls).toBe(1);child.append(host());expect(calls).toBe(2);child.snapshot();expect(calls).toBe(3)
 child.invalidate("stream-ended");expect(calls).toBe(3);expect(child.snapshot().uncertainty).toContain("stream-ended")
})
test("lost guard can replace binding but cannot poison replacement before throwing", () => {
 const store=open();const failure=Error("LOST");let lost=false;let replacement:ReturnType<typeof bind>|undefined
 const old=bind(store,()=>{if(lost){replacement=bind(store);throw failure}});old.append(host());lost=true
 try{old.snapshot();throw Error("unexpected")}catch(error){expect(error).toBe(failure)}
 expect(defined(replacement).snapshot().uncertainty).toEqual(["rebound"])
 expect(defined(replacement).snapshot().records).toEqual([host()])
})
test("binding/snapshot objects cannot mutate persisted identity or append bodies", () => {
 const child=bind(open());const record=host();child.append(record)
 ;record.event.data.title="later caller mutation"
 const view=child.snapshot(),viewed=view.records[0];if(viewed?.kind!=="host")throw Error("expected a host record in the snapshot");viewed.event.data.title="snapshot mutation"
 expect(child.snapshot().records).toEqual([host()]);expect(Object.isFrozen(child.binding)).toBe(true);expect(Object.isFrozen(child.binding.locator)).toBe(true)
})
test("same key cannot bind foreign child, backwards generation or unsafe locator fields", () => {
 const store=open();bind(store)
 for(const bad of [{...locator(),sessionID:"different"}, {...locator(),generation:0}, {...locator(),secret:"synthetic-sensitive"}])expect(()=>store.bind({key:"owned",locator:bad as never,guard:()=>{}})).toThrow()
 expect(()=>open(undefined,{maxEntries:0})).toThrow("limits")
})
test("unsafe nested model/error/input fields are rejected without secret-bearing validation errors", () => {
 const child=bind(open())
 const record={...host(),event:{...host().event,data:{model:{providerID:"qa",id:"model",headers:{Authorization:"synthetic-sensitive"}}}}}
 try{child.append(record as never);throw Error("unexpected")}catch(error){expect(String(error)).toBe("Error: Invalid observation record");expect((error as Error).cause).toBeUndefined()}
 expect(child.snapshot().records).toEqual([])
})
test("orphaned history can never be adopted by a fresh binding in an open store or after reopen", () => {
 const file=path(),store=open(file),first=bind(store);first.append(host())
 const db=new Database(file);db.exec("DELETE FROM observation_bindings WHERE key='owned'")
 try {
 expect(()=>bind(store)).toThrow("Orphan")
 expect((db.query("SELECT count(*) AS count FROM observation_bindings").get() as {count:number}).count).toBe(0)
 expect((db.query("SELECT count(*) AS count FROM observation_records").get() as {count:number}).count).toBe(1)
 store.close();expect(()=>open(file)).toThrow("Orphan")
 expect((db.query("SELECT count(*) AS count FROM observation_records").get() as {count:number}).count).toBe(1)
 } finally { db.close() }
})
test("global orphan detection rejects unrelated binding keys instead of hiding corrupt history", () => {
 const file=path(),store=open(file),first=bind(store);first.append(host());const db=new Database(file)
 try {
 db.exec("UPDATE observation_records SET key='unassociated'")
 expect(()=>store.bind({key:"different",locator:locator(),guard:()=>{}})).toThrow("Orphan")
 store.close();expect(()=>open(file)).toThrow("Orphan")
 expect((db.query("SELECT count(*) AS count FROM observation_records WHERE key='unassociated'").get() as {count:number}).count).toBe(1)
 } finally { db.close() }
})

test("parent hook metadata persistence remains bounded to actual bound child session",()=>{
 const metadata={sessionID:"foreign",messageID:"assistant",callID:"actual",tool:"final_target",status:"completed" as const}
 const child=bind(open());expect(()=>child.append({kind:"tool-metadata",id:`tool-metadata:${JSON.stringify([metadata.sessionID,metadata.messageID,metadata.callID])}`,metadata})).toThrow("Foreign")
 expect(child.snapshot().records).toEqual([]);expect(child.snapshot().uncertainty).toContain("invalid-record")
})

test("safe parent metadata survives existing SQLite JSON rows without schema or version migration",()=>{
 const file=path(),store=open(file),child=bind(store)
 const metadata={sessionID:"child",messageID:"assistant",callID:"actual",tool:"final_target",status:"error" as const}
 const record:ObservationRecord={kind:"tool-metadata",id:`tool-metadata:${JSON.stringify([metadata.sessionID,metadata.messageID,metadata.callID])}`,metadata}
 child.append(record);child.append(record);expect(child.snapshot().records).toEqual([record]);store.close()
 const db=new Database(file,{readonly:true});expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(1);db.close()
 const next=bind(open(file));expect(next.snapshot().records).toEqual([record]);expect(next.snapshot().uncertainty).toContain("rebound")
})
