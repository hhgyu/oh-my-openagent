import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { BoundMemorySession } from "./binding"
import { createFactsRunner } from "./facts-runner"
import { createBoundIdentity } from "./reflection.test-support"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function identity(): BoundMemorySession {
  const created = createBoundIdentity()
  cleanups.push(created.cleanup)
  return created.bound
}

/** A terminal run in the V2 layout: ledger plus a `final.json` sentinel stamped with `at`. */
function seedTerminalRun(bound: BoundMemorySession, runId: string, index: number): void {
  const runDir = join(bound.paths.facts, "runs", runId)
  mkdirSync(runDir, { recursive: true })
  const at = new Date(Date.parse("2026-11-01T00:00:00.000Z") + index * 60_000).toISOString()
  writeFileSync(join(runDir, "ledger.json"), JSON.stringify({ version: 1, runId, kind: "facts", queued: [], hardDeadlineAt: 0 }))
  writeFileSync(join(runDir, "final.json"), JSON.stringify({ version: 1, runId, at, outcome: "no_facts" }))
}

function runner(bound: BoundMemorySession) {
  return createFactsRunner({
    identity: bound.identity, paths: bound.paths, owner: "test-owner", now: () => new Date(), logger: { warn: () => undefined },
    people: () => ({ enabled: false, maxEntries: 0, maxEntryChars: 0 }),
    resolveModel: async () => ({ kind: "unavailable", cause: "no_catalog" }),
    launchChild: async () => ({ status: "failed", detail: "unused" }),
    deadlineMs: 60_000, ownerAlive: () => false,
  })
}

describe("facts run retention at bind recovery (P-15)", () => {
  test("#given 24 terminal runs and a prune tombstone #when bind recovery reconciles #then the newest 20 runs survive and the tombstone is gone", async () => {
    // given
    const bound = identity()
    for (let index = 0; index < 24; index += 1) seedTerminalRun(bound, `facts-abcdef012345-${String(index + 1).padStart(2, "0")}`, index)
    mkdirSync(join(bound.paths.facts, "runs", ".prune-facts-abcdef012345-00-stale"), { recursive: true })

    // when
    await runner(bound).reconcilePending()

    // then
    const remaining = readdirSync(join(bound.paths.facts, "runs")).sort()
    expect(remaining).toHaveLength(20)
    expect(remaining[0]).toBe("facts-abcdef012345-05")
    expect(remaining.at(-1)).toBe("facts-abcdef012345-24")
  })

  test("#given an open run among old terminal runs #when bind recovery reconciles #then the open run is kept and only the oldest terminal run is pruned", async () => {
    // given
    const bound = identity()
    for (let index = 0; index < 21; index += 1) seedTerminalRun(bound, `facts-0123456789ab-${String(index + 1).padStart(2, "0")}`, index)
    const open = join(bound.paths.facts, "runs", "facts-ffffffffffff-1")
    mkdirSync(open, { recursive: true })
    writeFileSync(join(open, "ledger.json"), JSON.stringify({
      version: 1, runId: "facts-ffffffffffff-1", kind: "facts", queued: [], hardDeadlineAt: 0, batchId: "b", claimId: "c", owner: "gone",
    }))

    // when
    await runner(bound).reconcilePending()

    // then
    const remaining = readdirSync(join(bound.paths.facts, "runs"))
    expect(remaining).toContain("facts-ffffffffffff-1")
    expect(remaining).not.toContain("facts-0123456789ab-01")
    expect(remaining).toContain("facts-0123456789ab-02")
  })
})
