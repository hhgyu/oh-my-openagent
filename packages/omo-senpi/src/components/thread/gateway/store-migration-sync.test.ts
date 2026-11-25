import { Database } from "bun:sqlite"
import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { gatewayDatabasePath } from "@oh-my-opencode/thread-core/gateway/paths"
import { GATEWAY_MIGRATIONS } from "@oh-my-opencode/thread-core/gateway/schema"
import { createGatewayStore, type GatewayStore } from "@oh-my-opencode/thread-core/gateway/store"
import type { GatewayStoreEvent } from "@oh-my-opencode/thread-core/gateway/types"

// The schema step that first creates `extension_schema` with a plain CREATE TABLE.
const STEP_CREATING_EXTENSION_SCHEMA = 6

const dirs: string[] = []
const stores: GatewayStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) await store.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function agentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "gateway-migration-sync-"))
  dirs.push(dir)
  return dir
}

function openStore(dir: string): { readonly store: GatewayStore; readonly migrations: GatewayStoreEvent[] } {
  const store = createGatewayStore({ agentDir: dir })
  stores.push(store)
  const migrations: GatewayStoreEvent[] = []
  store.onEvent((event) => {
    if (event.kind === "schema_migrated") migrations.push(event)
  })
  return { store, migrations }
}

function readDatabase<T>(dir: string, read: (db: Database) => T): T {
  const db = new Database(gatewayDatabasePath(dir))
  try {
    return read(db)
  } finally {
    db.close()
  }
}

function userVersion(db: Database): number {
  return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version
}

function schemaOf(db: Database): unknown[] {
  return db.query("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
}

function blockStep(dir: string): void {
  const path = gatewayDatabasePath(dir)
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  try {
    db.exec("CREATE TABLE extension_schema (blocker INTEGER)")
  } finally {
    db.close()
  }
}

test("#given a fresh store #when it opens #then every schema step commits at NORMAL and FULL is restored", async () => {
  // given
  const { store, migrations } = openStore(agentDir())

  // when
  await store.identity()

  // then
  expect(migrations).toEqual([
    {
      kind: "schema_migrated",
      from: 0,
      to: GATEWAY_MIGRATIONS.length,
      step_synchronous: GATEWAY_MIGRATIONS.map(() => 1),
      synchronous: 2,
    },
  ])
})

test("#given a schema step that fails #when the store opens #then FULL is restored and the steps before it stay committed", async () => {
  // given
  const dir = agentDir()
  blockStep(dir)
  const { store, migrations } = openStore(dir)

  // when
  const failure = await store.identity().then(
    () => "opened",
    () => "refused",
  )
  await store.dispose()

  // then
  const committed = STEP_CREATING_EXTENSION_SCHEMA - 1
  expect(failure).toBe("refused")
  expect(migrations).toEqual([
    {
      kind: "schema_migrated",
      from: 0,
      to: committed,
      step_synchronous: Array.from({ length: committed }, () => 1),
      synchronous: 2,
    },
  ])
  expect(readDatabase(dir, userVersion)).toBe(committed)
})

test("#given a migration interrupted midway #when the store opens again #then the remaining steps apply and the schema equals a clean store", async () => {
  // given an interrupted store whose blocker is then removed
  const dir = agentDir()
  blockStep(dir)
  const interrupted = openStore(dir).store
  await interrupted.identity().catch(() => undefined)
  await interrupted.dispose()
  readDatabase(dir, (db) => db.exec("DROP TABLE extension_schema"))
  const cleanDir = agentDir()
  await openStore(cleanDir).store.identity()

  // when
  const { store, migrations } = openStore(dir)
  await store.identity()

  // then
  expect(migrations).toEqual([
    {
      kind: "schema_migrated",
      from: STEP_CREATING_EXTENSION_SCHEMA - 1,
      to: GATEWAY_MIGRATIONS.length,
      step_synchronous: Array.from({ length: GATEWAY_MIGRATIONS.length - STEP_CREATING_EXTENSION_SCHEMA + 1 }, () => 1),
      synchronous: 2,
    },
  ])
  for (const open of stores.splice(0)) await open.dispose()
  expect(readDatabase(dir, schemaOf)).toEqual(readDatabase(cleanDir, schemaOf))
})
