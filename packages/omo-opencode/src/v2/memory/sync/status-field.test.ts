import { describe, expect, test } from "bun:test"
import { failureRpcSync } from "./status-copy"
import { readRpcSync, type RunnerStatus } from "./status-field"

const SINCE = Date.parse("2026-11-13T10:00:00.000Z")
const OVERSIZED = {
  kind: "oversized_item",
  keys: ["big.md", "old.md"],
  stuck: ["old.md"],
  limitBytes: 8388608,
  reason: "r",
  action: "a",
} as const
const HELD_FAILURE = {
  kind: "unknown",
  reason: "r",
  action: "a",
  sinceISO: "2026-11-13T10:00:00.000Z",
  attempts: 2,
  keys: ["big.md", "old.md"],
  stuckKeys: ["old.md"],
  limitBytes: 8388608,
} as const

const engineChunk = async (status: Parameters<typeof failureRpcSync>[0]) => failureRpcSync(status)

describe("the V2 memory status sync field (#12284)", () => {
  test("#given the engine holds files too large to sync #when the field is read #then the failure names every held file, the stuck ones and the limit", async () => {
    // given
    const status: RunnerStatus = { kind: "failing", since: SINCE, attempts: 2, failure: OVERSIZED }

    // when
    const field = await readRpcSync(async () => status, engineChunk)

    // then
    expect(field).toEqual({ state: "failing", failure: HELD_FAILURE })
  })

  test("#given the engine is paused at a refused entry while it holds files #when the field is read #then it stays paused and carries the held files", async () => {
    // given
    const status: RunnerStatus = {
      kind: "paused",
      seq: 1,
      code: "signature",
      held: { since: SINCE, attempts: 2, failure: OVERSIZED },
    }

    // when
    const field = await readRpcSync(async () => status, engineChunk)

    // then
    expect(field).toEqual({ state: "paused", failure: HELD_FAILURE })
  })

  test("#given a pause that holds nothing #when the field is read #then it is a plain pause and the engine chunk is not loaded", async () => {
    // given
    const loads: string[] = []

    // when
    const field = await readRpcSync(
      async () => ({ kind: "paused", seq: 1, code: "signature" }),
      async (status) => {
        loads.push(status.kind)
        return failureRpcSync(status)
      },
    )

    // then
    expect(field).toEqual({ state: "paused" })
    expect(loads).toEqual([])
  })

  test("#given a stranded git lock #when the field is read #then its paths survive and no held-file fields appear", async () => {
    // given
    const status: RunnerStatus = {
      kind: "failing",
      since: SINCE,
      attempts: 1,
      failure: { kind: "stranded_lock", paths: [".git/index.lock"], reason: "r", action: "a" },
    }

    // when
    const field = await readRpcSync(async () => status, engineChunk)

    // then
    expect(field).toEqual({
      state: "failing",
      failure: {
        kind: "stranded_lock",
        reason: "r",
        action: "a",
        sinceISO: "2026-11-13T10:00:00.000Z",
        attempts: 1,
        paths: [".git/index.lock"],
      },
    })
  })
})
