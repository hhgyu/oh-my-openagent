import { describe, expect, test } from "bun:test"
import { createUlwLoopStatusRpc, type UlwLoopStatusRpcPort } from "./status-rpc"

function harness() {
  const emitted: unknown[] = []
  let status: ((input: { sessionID: string }) => Promise<unknown>) | undefined
  const port = {
    register: async (_definition: unknown, handlers: { status: typeof status }) => {
      status = handlers.status
      return {
        events: { emit: async (_name: string, data: unknown) => void emitted.push(data) },
        dispose: async () => {},
      }
    },
  } as unknown as UlwLoopStatusRpcPort
  return { port, emitted, status: (sessionID: string) => status?.({ sessionID }) }
}

describe("V2 footer status RPC", () => {
  test("#given a goal status and a loop flag #when either changes #then each update carries both", async () => {
    // given
    const { port, emitted } = harness()
    const footer = createUlwLoopStatusRpc()
    await footer.register(port)

    // when
    footer.publishGoal("ses_a", "Pursuing goal")
    footer.publish("ses_a", true)
    footer.publishGoal("ses_a", "Pursuing goal")
    footer.publishGoal("ses_a", undefined)

    // then
    expect(emitted).toEqual([
      { sessionID: "ses_a", active: false, goal: "Pursuing goal" },
      { sessionID: "ses_a", active: true, goal: "Pursuing goal" },
      { sessionID: "ses_a", active: true },
    ])
  })

  test("#given a session this process never published #when the TUI asks for its status #then the goal source is read once", async () => {
    // given
    const { port, status } = harness()
    const footer = createUlwLoopStatusRpc()
    const reads: string[] = []
    footer.readGoalsFrom(async (sessionID) => {
      reads.push(sessionID)
      return "Goal blocked: continuation cap reached"
    })
    await footer.register(port)

    // when
    const first = await status("ses_a")
    const second = await status("ses_a")

    // then
    expect(first).toEqual({ sessionID: "ses_a", active: false, goal: "Goal blocked: continuation cap reached" })
    expect(second).toEqual(first)
    expect(reads).toEqual(["ses_a"])
  })
})
