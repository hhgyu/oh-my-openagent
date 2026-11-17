import { describe, expect, test } from "bun:test"
import { statSync } from "node:fs"

import { nodeSessionHistoryFs, toFileStats } from "./session-history-fs"

describe("session-history file stats", () => {
  test("#given two directories whose file IDs differ only beyond 2^53 #when converted #then their identities stay distinct", () => {
    // given
    const real = statSync(import.meta.dir, { bigint: true })
    const first = Object.assign(Object.create(real), { ino: 2n ** 60n + 1n, dev: 7n })
    const second = Object.assign(Object.create(real), { ino: 2n ** 60n + 2n, dev: 7n })

    // when
    const [a, b] = [toFileStats(first), toFileStats(second)]

    // then
    expect(a.ino).toBeNull()
    expect(a.identity).toBe(`7:${2n ** 60n + 1n}`)
    expect(b.identity).toBe(`7:${2n ** 60n + 2n}`)
    expect(a.type).toBe("Directory")
  })

  test("#given a directory on disk #when stat is read #then the identity is its exact dev and inode", async () => {
    // given
    const real = statSync(import.meta.dir, { bigint: true })

    // when
    const stats = await nodeSessionHistoryFs.stat(import.meta.dir)

    // then
    expect(stats.identity).toBe(`${real.dev}:${real.ino}`)
  })
})
