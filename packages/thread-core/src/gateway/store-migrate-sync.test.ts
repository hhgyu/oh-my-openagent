import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GATEWAY_MIGRATIONS } from "./schema"
import { Sql, type SqliteConnection } from "./sql"
import { migrate, type StoreContext } from "./store-ops"

const dirs: string[] = []
const connections: DatabaseSync[] = []

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function synchronousLevel(sql: Sql): number {
  return Number(sql.one(["synchronous"], "SELECT synchronous FROM pragma_synchronous")?.synchronous)
}

function userVersion(sql: Sql): number {
  return Number(sql.one(["user_version"], "SELECT user_version FROM pragma_user_version()")?.user_version)
}

function schemaOf(sql: Sql): readonly unknown[] {
  return sql.all(
    ["type", "name", "sql"],
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
    [],
    "type, name",
  )
}

function freshDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "gateway-migrate-sync-"))
  dirs.push(dir)
  return dir
}

function openStore(path: string): Sql {
  const connection = new DatabaseSync(path)
  connections.push(connection)
  const sql = new Sql(connection as unknown as SqliteConnection)
  sql.exec("PRAGMA journal_mode = WAL")
  sql.exec("PRAGMA synchronous = FULL")
  return sql
}

function closeStore(): void {
  connections.pop()?.close()
}

function observe(sql: Sql, onExec: (statement: string) => void): Sql {
  return new Proxy(sql, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target)
      if (key !== "exec" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value
      return (statement: string) => {
        onExec(statement)
        return target.exec(statement)
      }
    },
  })
}

function contextFor(sql: Sql, dir: string): StoreContext {
  return {
    sql,
    config: {
      agent_dir: dir,
      busy_timeout_ms: 100,
      lock_wait_max_ms: 1_000,
      instance_id: "migrate-sync",
      runtime_instance: null,
      legacy_mailbox_directories: [],
      test_hooks: {},
    },
    self: { pid: process.pid, process_start_time: null, instance_id: "migrate-sync", runtime_instance: null },
    stats: { writes: 0, marker_unlinks: 0, transactions: 0 },
    emit: () => undefined,
    hook: async () => undefined,
    delay: async () => undefined,
  }
}

describe("gateway schema migration flushes", () => {
  test("#given a fresh WAL store at synchronous=FULL #when every schema step is migrated #then steps commit at NORMAL and FULL is restored", async () => {
    // given
    const dir = freshDirectory()
    const sql = openStore(join(dir, "gateway.db"))
    const commitLevels: number[] = []
    const observed = observe(sql, (statement) => {
      if (statement === "COMMIT") commitLevels.push(synchronousLevel(sql))
    })

    // when
    await migrate(contextFor(observed, dir))

    // then
    expect(commitLevels).toEqual(GATEWAY_MIGRATIONS.map(() => 1))
    expect(synchronousLevel(sql)).toBe(2)
    expect(userVersion(sql)).toBe(GATEWAY_MIGRATIONS.length)
  })

  test("#given a schema step that fails midway #when the migration aborts #then FULL is restored and the committed steps stay", async () => {
    // given
    const dir = freshDirectory()
    const sql = openStore(join(dir, "gateway.db"))
    const failAtCommit = Math.floor(GATEWAY_MIGRATIONS.length / 2)
    let commits = 0
    const faulty = observe(sql, (statement) => {
      if (statement === "COMMIT" && ++commits === failAtCommit) throw new Error("injected migration failure")
    })

    // when
    const failure = await migrate(contextFor(faulty, dir)).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )

    // then
    expect(failure).toBe("injected migration failure")
    expect(synchronousLevel(sql)).toBe(2)
    expect(userVersion(sql)).toBe(failAtCommit - 1)
  })

  test("#given a migration interrupted midway #when the store is opened again #then the remaining steps apply and the schema equals a clean migration", async () => {
    // given an interrupted store, closed with only its first steps committed
    const interruptedDir = freshDirectory()
    const interruptedPath = join(interruptedDir, "gateway.db")
    let commits = 0
    const interrupted = observe(openStore(interruptedPath), (statement) => {
      if (statement === "COMMIT" && ++commits === 3) throw new Error("injected interruption")
    })
    await migrate(contextFor(interrupted, interruptedDir)).catch(() => undefined)
    closeStore()
    const cleanDir = freshDirectory()
    const clean = openStore(join(cleanDir, "gateway.db"))
    await migrate(contextFor(clean, cleanDir))

    // when
    const reopened = openStore(interruptedPath)
    await migrate(contextFor(reopened, interruptedDir))

    // then
    expect(userVersion(reopened)).toBe(GATEWAY_MIGRATIONS.length)
    expect(synchronousLevel(reopened)).toBe(2)
    expect(schemaOf(reopened)).toEqual(schemaOf(clean))
  })
})
