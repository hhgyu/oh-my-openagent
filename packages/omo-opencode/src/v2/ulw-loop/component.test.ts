import { describe, expect, test } from "bun:test"
import {
  ULW_LOOP_CONTINUATION_PROMPT,
  ULW_LOOP_STEERING_REMINDER,
  type ClassifiedLoopStatus,
} from "@oh-my-opencode/omo-codex/ulw-loop-session-sdk/loop-continuation"
import { registerUlwLoop } from "./component"
import { activeLoop, fakeUlwLoopHost, NO_LOOP } from "./test-support"

function setup(read: (sessionID: string) => ClassifiedLoopStatus) {
  const fake = fakeUlwLoopHost()
  const reads: string[] = []
  const registered = registerUlwLoop(fake.host, {
    skillFile: null,
    readStatus: async (_cwd, sessionID) => {
      reads.push(sessionID)
      return read(sessionID)
    },
  })
  return { ...fake, reads, registered }
}

describe("V2 ulw-loop component", () => {
  test("#given an active incomplete loop #when the session settles #then one hidden steer continuation resumes that session", async () => {
    // given
    const { idle, synthetic, emitted, registered } = setup(() => activeLoop("plan-1"))
    const dispose = await registered

    // when
    await idle("ses_a")

    // then
    expect(synthetic).toEqual([
      expect.objectContaining({
        sessionID: "ses_a",
        text: ULW_LOOP_CONTINUATION_PROMPT,
        delivery: "steer",
        resume: true,
        id: expect.stringMatching(/^msg_omo_ulw_[0-9a-f]+$/),
      }),
    ])
    expect(emitted).toEqual([{ sessionID: "ses_a", active: true }])
    await dispose()
  })

  test("#given the same status twice or no loop #when sessions settle #then only a changed active status continues", async () => {
    // given
    const { idle, synthetic, registered } = setup((sessionID) => (sessionID === "ses_a" ? activeLoop("same") : NO_LOOP))
    const dispose = await registered

    // when
    await idle("ses_a")
    await idle("ses_a")
    await idle("ses_b")

    // then
    expect(synthetic.map((input) => input["sessionID"])).toEqual(["ses_a"])
    await dispose()
  })

  test("#given the continuation cap #when a real user prompt arrives #then the budget restarts, and the host's own continuation never restarts it", async () => {
    // given
    let round = 0
    const { idle, prompt, synthetic, reads, registered } = setup(() => activeLoop(`round-${round++}`))
    const dispose = await registered
    for (let index = 0; index < 10; index++) await idle("ses_a")
    const capped = synthetic.length
    const readsAtCap = reads.length

    // when
    const own = synthetic.at(-1) ?? {}
    await prompt("ses_a", ULW_LOOP_CONTINUATION_PROMPT, own["metadata"] as Record<string, unknown>)
    await idle("ses_a")
    const afterOwn = synthetic.length
    await prompt("ses_a", "keep going")
    await idle("ses_a")

    // then
    expect(capped).toBe(8)
    expect(readsAtCap).toBe(8)
    expect(afterOwn).toBe(8)
    expect(synthetic.length).toBe(9)
    await dispose()
  })

  test("#given an active loop #when the user steers a running turn #then the reminder is appended only mid-run", async () => {
    // given
    const { prompt, event, registered } = setup(() => activeLoop("plan-1"))
    const dispose = await registered

    // when
    const idleText = await prompt("ses_a", "first")
    await event("session.execution.started", "ses_a")
    const runningText = await prompt("ses_a", "steer")
    await event("session.execution.succeeded", "ses_a")
    const settledText = await prompt("ses_a", "after")

    // then
    expect(idleText).toBe("first")
    expect(runningText).toBe(`steer\n\n${ULW_LOOP_STEERING_REMINDER}`)
    expect(settledText).toBe("after")
    await dispose()
  })

  test("#given a status read that throws #when the session settles #then nothing is injected", async () => {
    // given
    const { idle, synthetic, registered } = setup(() => {
      throw Error("disk gone")
    })
    const dispose = await registered

    // when
    await idle("ses_a")

    // then
    expect(synthetic).toEqual([])
    await dispose()
  })
})
