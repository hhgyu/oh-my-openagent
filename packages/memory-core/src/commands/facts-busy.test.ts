import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FactsFailureStore, factsQueuePaths } from "../facts"
import { buildIdentityPaths } from "../identity"
import { createLockRecord, factsQueueLockPath, LockContentionError, withLock } from "../locks"
import { runFactsCommand } from "./facts"
import { factsRemediationHint, formatFactsAdvisory, readFactsOverview } from "./facts-status"
import type { MemoryCommandDeps } from "./types"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "facts-busy-command-"))
  roots.push(root)
  const paths = buildIdentityPaths(root, "agent")
  const store = new FactsFailureStore({ identityPaths: paths })
  await store.recordFailure({ targets: [{ conversationId: "conv", endMessageId: "m1", endSnapshotLine: 1 }], failureId: "run-1", reason: "child_exit" })
  let launches = 0
  const deps: MemoryCommandDeps = {
    contextForSession: () => ({ identity: "agent", identityPaths: paths }), bustPromptCache: () => undefined,
    factsSink: { reconcile: async () => { launches += 1 } },
  }
  return { paths, deps, launches: () => launches, ctx: { sessionManager: { getSessionId: () => "root" } } }
}

test("#given a held facts queue lock #when status and retry read it #then busy is surfaced without corruption advice or writes", async () => {
  // given
  const f = await fixture()
  const before = await readFile(factsQueuePaths(f.paths).failuresPath, "utf8")
  // when / then
  await withLock(factsQueueLockPath(f.paths.locks), await createLockRecord("facts-queue"), async () => {
    const overview = await readFactsOverview({ identityPaths: f.paths, now: new Date() })
    expect(overview.corrupt).toBeUndefined()
    expect(formatFactsAdvisory(overview)).toContain("busy")
    expect(factsRemediationHint(overview)).toContain("busy")
    for (const args of ["", "retry"]) {
      const text = await runFactsCommand(f.deps, args, f.ctx)
      expect(text).toContain("busy")
      expect(text).not.toMatch(/unreadable|repair|remove|no failing batches/i)
    }
  })
  expect(f.launches()).toBe(0)
  expect(await readFile(factsQueuePaths(f.paths).failuresPath, "utf8")).toBe(before)
}, 15_000)

test("#given contention after the retry read #when clearing records #then retry defers without throwing or launching", async () => {
  // given
  const f = await fixture()
  const before = await readFile(factsQueuePaths(f.paths).failuresPath, "utf8")
  const clear = spyOn(FactsFailureStore.prototype, "clearForRetry").mockRejectedValue(new LockContentionError("facts-queue.lock", null))
  // when / then
  try {
    expect(await runFactsCommand(f.deps, "retry", f.ctx)).toContain("busy")
    expect(f.launches()).toBe(0)
    expect(await readFile(factsQueuePaths(f.paths).failuresPath, "utf8")).toBe(before)
  } finally {
    clear.mockRestore()
  }
})
