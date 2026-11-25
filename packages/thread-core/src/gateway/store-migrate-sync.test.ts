import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GATEWAY_MIGRATIONS } from "./schema"
import { Sql, type SqliteConnection } from "./sql"
import { migrate, type StoreContext } from "./store-ops"

function synchronousLevel(sql: Sql): number {
  return Number(sql.one(["synchronous"], "SELECT synchronous FROM pragma_synchronous")?.synchronous)
}

describe("gateway schema migration flushes", () => {
  test("#given a fresh WAL store at synchronous=FULL #when every schema step is migrated #then steps commit at NORMAL and FULL is restored", async () => {
    // given
    const dir = mkdtempSync(join(tmpdir(), "gateway-migrate-sync-"))
    const connection = new DatabaseSync(join(dir, "gateway.db"))
    try {
      const sql = new Sql(connection as unknown as SqliteConnection)
      sql.exec("PRAGMA journal_mode = WAL")
      sql.exec("PRAGMA synchronous = FULL")
      const commitLevels: number[] = []
      const observed = new Proxy(sql, {
        get(target, key) {
          const value: unknown = Reflect.get(target, key, target)
          if (key !== "exec" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value
          return (statement: string) => {
            if (statement === "COMMIT") commitLevels.push(synchronousLevel(target))
            return target.exec(statement)
          }
        },
      })
      const ctx: StoreContext = {
        sql: observed,
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

      // when
      await migrate(ctx)

      // then
      expect(commitLevels).toEqual(GATEWAY_MIGRATIONS.map(() => 1))
      expect(synchronousLevel(sql)).toBe(2)
      expect(Number(sql.one(["user_version"], "SELECT user_version FROM pragma_user_version()")?.user_version)).toBe(
        GATEWAY_MIGRATIONS.length,
      )
    } finally {
      connection.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
