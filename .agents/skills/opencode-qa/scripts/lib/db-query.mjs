#!/usr/bin/env node
// db-query.mjs - read-only SQLite runner for opencode-qa when the opencode CLI
// has no `db` subcommand (OpenCode 2.x). Prints the rows as one JSON array.
//
// Usage: node db-query.mjs <db-path> "<SELECT ...>"
//        bun  db-query.mjs <db-path> "<SELECT ...>"
//
// The database is opened read-only and with PRAGMA query_only, and only
// SELECT / WITH / PRAGMA statements are accepted, so the live DB is never written.

const [dbPath, sql] = process.argv.slice(2)

function fail(message) {
  process.stderr.write(`db-query: ${message}\n`)
  process.exit(2)
}

if (!dbPath || !sql) fail("usage: db-query.mjs <db-path> <sql>")
if (!/^\s*(select|with|pragma)\b/i.test(sql)) fail("only SELECT, WITH or PRAGMA statements are allowed")

const { existsSync } = await import("node:fs")
if (!existsSync(dbPath)) fail(`database not found: ${dbPath}`)

async function openReadOnly(path) {
  if (process.versions.bun) {
    const { Database } = await import("bun:sqlite")
    const db = new Database(path, { readonly: true })
    return { all: (query) => db.query(query).all(), exec: (query) => db.run(query), close: () => db.close() }
  }
  const { DatabaseSync } = await import("node:sqlite")
  const db = new DatabaseSync(path, { readOnly: true })
  return { all: (query) => db.prepare(query).all(), exec: (query) => db.exec(query), close: () => db.close() }
}

let db
try {
  db = await openReadOnly(dbPath)
} catch (error) {
  fail(`cannot open ${dbPath} read-only: ${error instanceof Error ? error.message : String(error)}`)
}

try {
  db.exec("PRAGMA query_only = ON")
  db.exec("PRAGMA busy_timeout = 5000")
  const rows = db.all(sql).map((row) => ({ ...row }))
  process.stdout.write(
    `${JSON.stringify(rows, (_key, value) => (typeof value === "bigint" ? Number(value) : value))}\n`,
  )
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  db.close()
}
