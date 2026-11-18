import { describe, expect, test } from "bun:test"
import { recoverWhileHeldElsewhere } from "./left-behind-retry"

describe("#given a parent whose left-behind child another live runtime holds", () => {
  test("#when that runtime releases it on the third attempt #then recovery stops right after it takes the child", async () => {
    // given
    const reports = [{ elsewhere: ["st_a"] }, { elsewhere: ["st_a"] }, { elsewhere: [] }]
    let attempts = 0

    // when
    await recoverWhileHeldElsewhere(async () => reports[attempts++], {
      signal: new AbortController().signal,
      intervalMs: 1,
      budgetMs: 1_000,
    })

    // then
    expect(attempts).toBe(3)
  })

  test("#when the holder never releases it #then recovery stops once its budget is spent", async () => {
    // given
    let attempts = 0

    // when
    await recoverWhileHeldElsewhere(
      async () => {
        attempts++
        return { elsewhere: ["st_a"] }
      },
      { signal: new AbortController().signal, intervalMs: 20, budgetMs: 70 },
    )

    // then
    expect(attempts).toBeGreaterThanOrEqual(2)
    expect(attempts).toBeLessThanOrEqual(4)
  })

  test("#when the retry follows the startup pass and the component closes before its first interval #then it makes no attempt", async () => {
    // given
    const stop = new AbortController()
    let attempts = 0

    // when
    const running = recoverWhileHeldElsewhere(
      async () => {
        attempts++
        return { elsewhere: [] }
      },
      { signal: stop.signal, intervalMs: 60_000, budgetMs: 600_000, initialDelay: true },
    )
    stop.abort()
    await running

    // then
    expect(attempts).toBe(0)
  })

  test("#when the component closes while it waits #then no further attempt runs", async () => {
    // given
    const stop = new AbortController()
    let attempts = 0

    // when
    const running = recoverWhileHeldElsewhere(
      async () => {
        attempts++
        return { elsewhere: ["st_a"] }
      },
      { signal: stop.signal, intervalMs: 60_000, budgetMs: 600_000 },
    )
    stop.abort()
    await running

    // then
    expect(attempts).toBe(1)
  })
})
