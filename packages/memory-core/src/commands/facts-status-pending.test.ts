import { afterEach, describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FactsQueue, type FactsFailureRecord } from "../facts"
import { buildIdentityPaths } from "../identity"
import type { TranscriptEntry } from "../journal"
import { removeTree } from "../../../../test-support/remove-tree"
import { formatFactsStatus, readFactsOverview } from "./facts-status"

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => removeTree(dir, { maxRetries: 10, retryDelay: 200 })))
})

function entry(kind: "user" | "assistant", text: string): TranscriptEntry {
  return { kind, text, captured_at: "2026-01-01T00:00:00.000Z", source_line_id: `m1:${kind}`, source_message_id: "m1" }
}

describe("facts status pending count", () => {
  test("#given one queued entry under a live claim #when the overview is read before and after the commit #then claims.json is not a batch: 1 pending, then 0", async () => {
    // given
    const dir = realpathSync.native(await mkdtemp(join(tmpdir(), "memory-facts-status-pending-")))
    tempDirs.push(dir)
    const identityPaths = buildIdentityPaths(join(dir, "memory"), "agent")
    const queue = new FactsQueue({ identityPaths })
    await queue.enqueue({
      identity: "agent",
      sessionId: "conv",
      conversationId: "conv",
      entries: [entry("user", "ask"), entry("assistant", "answer")],
    })
    const pending = await queue.listPending()
    await queue.claim(pending, "claim-1")
    const now = new Date("2026-01-01T00:00:00.000Z")
    // when
    const before = await readFactsOverview({ identityPaths, now })
    await queue.markConsumed(pending)
    const after = await readFactsOverview({ identityPaths, now })
    // then
    expect(formatFactsStatus("agent", before)).toContain("queued: 1 pending")
    expect(formatFactsStatus("agent", after)).toContain("queued: 0 pending")
  })
})

describe("facts status wait wording", () => {
  test("#given a backoff that ends in under a minute #when rendering the status view #then the wait is shown in seconds, not now", () => {
    // given
    const now = new Date("2026-08-16T12:00:00.000Z")
    const record: FactsFailureRecord = {
      conversationId: "conv-a",
      end_message_id: "msg-a",
      end_snapshot_line: 4,
      state: "backoff",
      streak: 1,
      firstFailureAt: "2026-08-16T11:59:30.000Z",
      lastFailureAt: "2026-08-16T11:59:30.000Z",
      lastReason: "child_exit",
      lastFailureId: "run-1",
      nextEligibleAt: "2026-08-16T12:00:42.000Z",
    }
    // when
    const text = formatFactsStatus("agent", { pending: 1, records: [record], now })
    // then
    expect(text).toContain("backoff: 1 (next eligible 42s)")
  })
})
