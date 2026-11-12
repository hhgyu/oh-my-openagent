import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { acquireLock, createLockRecord, releaseLock, runFinalizationLockPath } from "../locks"
import {
  FACTS_RUN_KEEP_LAST,
  FACTS_RUN_MAX_TOTAL_BYTES,
  PRUNE_TOMBSTONE_PREFIX,
  pruneTerminalFactsRuns,
  sweepFactsRunTombstones,
} from "./run-prune"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  )
})

async function fixture(): Promise<{ readonly factsDir: string; readonly locksDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "omo-core-facts-prune-"))
  roots.push(root)
  const factsDir = join(root, "facts")
  const locksDir = join(root, "locks")
  await mkdir(join(factsDir, "runs"), { recursive: true })
  await mkdir(locksDir, { recursive: true })
  return { factsDir, locksDir }
}

function instant(index: number): string {
  return new Date(Date.parse("2026-08-01T00:00:00.000Z") + index * 60_000).toISOString()
}

/** A terminal run dir in either host's sentinel shape, plus optional filler bytes. */
async function seedRun(options: {
  readonly factsDir: string
  readonly runId: string
  readonly at?: string
  readonly shape?: "senpi-final" | "senpi-abandoned" | "v2-final" | "v2-abandoned" | "open"
  readonly bytes?: number
}): Promise<void> {
  const runDir = join(options.factsDir, "runs", options.runId)
  await mkdir(runDir, { recursive: true })
  await writeFile(
    join(runDir, "ledger.json"),
    JSON.stringify({ version: 1, runId: options.runId, kind: "facts" }),
    "utf8",
  )
  const at = options.at ?? instant(0)
  const shape = options.shape ?? "senpi-final"
  if (shape === "senpi-final")
    await writeFile(join(runDir, "final.json"), JSON.stringify({ runId: options.runId, finishedAt: at }), "utf8")
  if (shape === "senpi-abandoned")
    await writeFile(join(runDir, "abandoned.json"), JSON.stringify({ runId: options.runId, abandonedAt: at }), "utf8")
  if (shape === "v2-final")
    await writeFile(
      join(runDir, "final.json"),
      JSON.stringify({ version: 1, runId: options.runId, at, outcome: "committed" }),
      "utf8",
    )
  if (shape === "v2-abandoned")
    await writeFile(
      join(runDir, "abandoned.json"),
      JSON.stringify({ version: 1, runId: options.runId, at, reason: "unknown_liveness" }),
      "utf8",
    )
  if (options.bytes !== undefined) await writeFile(join(runDir, "filler.log"), "x".repeat(options.bytes), "utf8")
}

async function runNames(factsDir: string): Promise<readonly string[]> {
  return (await readdir(join(factsDir, "runs"))).sort()
}

describe("pruneTerminalFactsRuns", () => {
  test("#given the retention defaults #when read #then they keep the last 20 runs under a 128 MiB cap", () => {
    // given / when / then
    expect(FACTS_RUN_KEEP_LAST).toBe(20)
    expect(FACTS_RUN_MAX_TOTAL_BYTES).toBe(128 * 1024 * 1024)
  })

  test("#given 23 terminal runs in both hosts' sentinel shapes #when pruning with defaults #then the newest 20 survive", async () => {
    // given
    const { factsDir, locksDir } = await fixture()
    const shapes = ["senpi-final", "senpi-abandoned", "v2-final", "v2-abandoned"] as const
    for (let index = 0; index < 23; index += 1) {
      await seedRun({
        factsDir,
        runId: `facts-aaaa-${String(index).padStart(2, "0")}`,
        at: instant(index),
        shape: shapes[index % 4],
      })
    }

    // when
    const result = await pruneTerminalFactsRuns({ factsDir, locksDir })

    // then
    expect([...result.pruned].sort()).toEqual(["facts-aaaa-00", "facts-aaaa-01", "facts-aaaa-02"])
    expect(await runNames(factsDir)).toHaveLength(20)
  }, 30_000)

  test("#given runs past the byte cap #when pruning #then only the newest-first prefix under the cap survives and the newest always stays", async () => {
    // given
    const { factsDir, locksDir } = await fixture()
    for (let index = 1; index <= 4; index += 1) {
      await seedRun({ factsDir, runId: `facts-bbbb-${index}`, at: instant(index), shape: "v2-final", bytes: 100_000 })
    }

    // when
    await pruneTerminalFactsRuns({ factsDir, locksDir, maxTotalBytes: 250_000 })
    const second = await pruneTerminalFactsRuns({ factsDir, locksDir, maxTotalBytes: 1 })

    // then
    expect(second.pruned).toEqual(["facts-bbbb-3"])
    expect(await runNames(factsDir)).toEqual(["facts-bbbb-4"])
  }, 30_000)

  test("#given an open run and a run being finalized #when pruning keeps one #then neither is touched", async () => {
    // given
    const { factsDir, locksDir } = await fixture()
    await seedRun({ factsDir, runId: "facts-cccc-0", shape: "open" })
    await seedRun({ factsDir, runId: "facts-cccc-1", at: instant(1), shape: "v2-final" })
    await seedRun({ factsDir, runId: "facts-cccc-2", at: instant(2), shape: "v2-final" })
    await seedRun({ factsDir, runId: "facts-cccc-3", at: instant(3), shape: "v2-final" })
    const record = await createLockRecord("facts-finalize", { runId: "facts-cccc-1" })
    const lock = runFinalizationLockPath(locksDir, "facts-cccc-1")
    await acquireLock(lock, record)

    // when
    let result
    try {
      result = await pruneTerminalFactsRuns({ factsDir, locksDir, keepLast: 1 })
    } finally {
      await releaseLock(lock, record)
    }

    // then
    expect(result.pruned).toEqual(["facts-cccc-2"])
    expect(await runNames(factsDir)).toEqual(["facts-cccc-0", "facts-cccc-1", "facts-cccc-3"])
  }, 30_000)

  test("#given a tombstone a crash left behind #when the sweep runs #then it is removed and live runs stay", async () => {
    // given
    const { factsDir } = await fixture()
    await seedRun({ factsDir, runId: "facts-dddd-1", shape: "v2-final" })
    await mkdir(join(factsDir, "runs", `${PRUNE_TOMBSTONE_PREFIX}facts-dddd-0-x`, "nested"), { recursive: true })

    // when
    const removed = await sweepFactsRunTombstones({ factsDir })

    // then
    expect(removed).toEqual([`${PRUNE_TOMBSTONE_PREFIX}facts-dddd-0-x`])
    expect(await runNames(factsDir)).toEqual(["facts-dddd-1"])
  })
})
