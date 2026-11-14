import { describe, expect, test } from "bun:test"
import { ULW_LOOP_FOOTER_FRAMES } from "@oh-my-opencode/omo-codex/ulw-loop-session-sdk/loop-continuation"
import { createUlwLoopFooterView } from "./ulw-loop-status"

function harness(loaded: Record<string, boolean>) {
  const handlers: ((data: unknown) => void)[] = []
  const ticks: (() => void)[] = []
  let cleared = 0
  const view = createUlwLoopFooterView({
    load: async (sessionID) => ({ sessionID, active: loaded[sessionID] ?? false }),
    subscribe: (handler) => {
      handlers.push(handler)
      return () => {}
    },
    changed: () => {},
    timers: {
      set: (callback) => ticks.push(callback),
      clear: () => void cleared++,
    },
  })
  return {
    view,
    push: (data: unknown) => {
      for (const handler of handlers) handler(data)
    },
    tick: () => ticks.at(-1)?.(),
    cleared: () => cleared,
  }
}

describe("V2 ulw-loop footer", () => {
  test("#given an active loop #when the session is shown #then the footer animates the shared frames until the loop ends", async () => {
    // given
    const { view, push, tick, cleared } = harness({ ses_a: true })

    // when
    view.select("ses_a")
    await Promise.resolve()
    await Promise.resolve()
    const first = view.frame()
    tick()
    const second = view.frame()
    push({ sessionID: "ses_a", active: false })

    // then
    expect(first).toBe(ULW_LOOP_FOOTER_FRAMES[0])
    expect(second).toBe(ULW_LOOP_FOOTER_FRAMES[1])
    expect(view.frame()).toBeUndefined()
    expect(cleared()).toBe(1)
    view.close()
  })

  test("#given another session's update #when the shown session has no loop #then the footer stays empty", async () => {
    // given
    const { view, push } = harness({})

    // when
    view.select("ses_a")
    await Promise.resolve()
    push({ sessionID: "ses_b", active: true })

    // then
    expect(view.frame()).toBeUndefined()
    view.close()
  })
})
