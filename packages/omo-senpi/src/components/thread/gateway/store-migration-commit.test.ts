import { expect, test } from "bun:test"

import { GATEWAY_MIGRATIONS } from "@oh-my-opencode/thread-core/gateway/schema"
import type { Sql } from "@oh-my-opencode/thread-core/gateway/sql"
import { migrate, type StoreContext } from "@oh-my-opencode/thread-core/gateway/store-ops"
import type { GatewayStoreEvent } from "@oh-my-opencode/thread-core/gateway/types"

// A transactional stand-in for the store's statement-free SQL surface: pragmas, user_version, BEGIN/COMMIT/ROLLBACK.
// Its COMMIT fails at the chosen transaction, as a deferred constraint or an I/O error would at commit time.
function fakeSql(failingCommit: number): Sql {
  let committedVersion = 0
  let pendingVersion: number | undefined
  let synchronous = 2
  let commits = 0
  const one = (columns: readonly string[]): Record<string, unknown> | undefined => {
    const column = columns[0]
    if (column === "user_version") return { user_version: pendingVersion ?? committedVersion }
    if (column === "synchronous") return { synchronous }
    if (column === "foreign_keys") return { foreign_keys: 1 }
    return undefined
  }
  const exec = (statement: string): void => {
    const level = /^PRAGMA synchronous = (\w+)$/.exec(statement)?.[1]
    if (level !== undefined) synchronous = level === "NORMAL" ? 1 : level === "FULL" ? 2 : Number(level)
    const version = /^PRAGMA user_version = (\d+)$/.exec(statement)
    if (version !== null) pendingVersion = Number(version[1])
    if (statement === "BEGIN IMMEDIATE") pendingVersion = undefined
    if (statement === "ROLLBACK") pendingVersion = undefined
    if (statement === "COMMIT") {
      commits += 1
      if (commits === failingCommit) throw new Error("injected COMMIT failure")
      committedVersion = pendingVersion ?? committedVersion
      pendingVersion = undefined
    }
  }
  const surface = { one, exec, all: () => [] }
  return surface as unknown as Sql
}

test("#given a schema step whose COMMIT fails #when migrating #then the reported steps are exactly the committed ones", async () => {
  // given
  const failingCommit = 3
  const events: GatewayStoreEvent[] = []
  const ctx: StoreContext = {
    sql: fakeSql(failingCommit),
    config: {
      agent_dir: "unused",
      busy_timeout_ms: 100,
      lock_wait_max_ms: 1_000,
      instance_id: "migration-commit",
      runtime_instance: null,
      legacy_mailbox_directories: [],
      test_hooks: {},
    },
    self: { pid: process.pid, process_start_time: null, instance_id: "migration-commit", runtime_instance: null },
    stats: { writes: 0, marker_unlinks: 0, transactions: 0 },
    emit: (event) => events.push(event),
    hook: async () => undefined,
    delay: async () => undefined,
  }

  // when
  const failure = await migrate(ctx).then(
    () => "migrated",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  )

  // then
  expect(GATEWAY_MIGRATIONS.length).toBeGreaterThan(failingCommit)
  expect(failure).toBe("injected COMMIT failure")
  expect(events).toEqual([
    { kind: "schema_migrated", from: 0, to: failingCommit - 1, step_synchronous: [1, 1], synchronous: 2 },
  ])
})
