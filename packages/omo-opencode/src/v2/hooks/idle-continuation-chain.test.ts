import { describe, expect, test } from "bun:test"
import { attachIdleContinuation, createIdleContinuationChain, IDLE_CONTINUATION_RANK } from "./idle-continuation-chain"

type IdleInput = { sessionID: string; background: readonly unknown[] }

function fakeSession() {
  const hooks: ((input: IdleInput) => Promise<void>)[] = []
  return {
    hooks,
    port: {
      hook: async (name: string, callback: (input: IdleInput) => Promise<void>) => {
        if (name !== "experimental.idle") throw Error(name)
        hooks.push(callback)
        return { dispose: async () => void hooks.splice(hooks.indexOf(callback), 1) }
      },
    },
  }
}

describe("idle continuation chain", () => {
  test("#given goal, ulw-execute and ulw-loop handlers added in any order #when a session settles #then they run in Native precedence and stop at the first that continues", async () => {
    // given
    const session = fakeSession()
    const chain = createIdleContinuationChain()
    const ran: string[] = []
    const handler = (name: string, continues: boolean) => async () => {
      ran.push(name)
      return continues
    }
    await attachIdleContinuation(session.port, chain, IDLE_CONTINUATION_RANK.ulwLoop, handler("ulw-loop", true))
    await attachIdleContinuation(session.port, chain, IDLE_CONTINUATION_RANK.ulwExecute, handler("ulw-execute", true))
    await attachIdleContinuation(session.port, chain, IDLE_CONTINUATION_RANK.goal, handler("goal", false))
    const registration = await chain.register(session.port)

    // when
    await session.hooks[0]?.({ sessionID: "ses_a", background: [] })

    // then
    expect(session.hooks).toHaveLength(1)
    expect(ran).toEqual(["goal", "ulw-execute"])
    await registration.dispose()
    expect(session.hooks).toHaveLength(0)
  })

  test("#given a disposed handler #when a session settles #then it no longer runs", async () => {
    // given
    const session = fakeSession()
    const chain = createIdleContinuationChain()
    const ran: string[] = []
    const goal = await attachIdleContinuation(session.port, chain, IDLE_CONTINUATION_RANK.goal, async () => {
      ran.push("goal")
      return true
    })
    await attachIdleContinuation(session.port, chain, IDLE_CONTINUATION_RANK.ulwLoop, async () => {
      ran.push("ulw-loop")
      return true
    })
    await chain.register(session.port)

    // when
    await goal.dispose()
    await session.hooks[0]?.({ sessionID: "ses_a", background: [] })

    // then
    expect(ran).toEqual(["ulw-loop"])
  })

  test("#given no chain #when a handler attaches #then it registers its own idle hook", async () => {
    // given
    const session = fakeSession()
    const ran: string[] = []

    // when
    await attachIdleContinuation(session.port, undefined, IDLE_CONTINUATION_RANK.ulwExecute, async (input) => {
      ran.push(input.sessionID)
      return false
    })
    await session.hooks[0]?.({ sessionID: "ses_a", background: [] })

    // then
    expect(ran).toEqual(["ses_a"])
  })
})
