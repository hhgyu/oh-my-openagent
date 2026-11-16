import { describe, expect, test } from "bun:test"
import { finishedTurnText } from "./owned-child-transcript"

const assistant = (patch: Record<string, unknown> = {}) => ({
  id: "msg_answer",
  type: "assistant",
  agent: "build",
  model: { providerID: "qa", id: "model" },
  content: [
    { type: "text", text: "final " },
    { type: "text", text: "answer" },
  ],
  finish: "stop",
  time: { created: 1, completed: 2 },
  ...patch,
})
const user = { id: "msg_user", type: "user", text: "next", time: { created: 3 } }
const idle = { id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 4 } }

describe("#given the host transcript of a child session", () => {
  test("#when it ends with a finished assistant answer #then that answer is the turn's text", () => {
    expect(finishedTurnText([user, assistant()])).toBe("final answer")
  })

  test("#when only host bookkeeping follows the answer #then the answer still counts", () => {
    expect(finishedTurnText([user, assistant(), idle, { id: "m", type: "model-switched", time: { created: 5 } }])).toBe(
      "final answer",
    )
  })

  test("#when an input follows the answer #then nothing is adopted", () => {
    expect(finishedTurnText([assistant(), user])).toBeUndefined()
    expect(finishedTurnText([assistant(), { ...user, type: "synthetic" }])).toBeUndefined()
  })

  test("#when the last reply failed, was cut, is still streaming or asked for a tool #then nothing is adopted", () => {
    expect(finishedTurnText([assistant({ error: { type: "provider", message: "down" } })])).toBeUndefined()
    expect(finishedTurnText([assistant({ finish: "length" })])).toBeUndefined()
    expect(finishedTurnText([assistant({ time: { created: 1 } })])).toBeUndefined()
    expect(
      finishedTurnText([
        assistant({ content: [{ type: "tool", id: "c", name: "shell", state: { status: "running" } }] }),
      ]),
    ).toBeUndefined()
  })

  test("#when the answer has no text or the transcript is unreadable #then nothing is adopted", () => {
    expect(finishedTurnText([assistant({ content: [] })])).toBeUndefined()
    expect(finishedTurnText({})).toBeUndefined()
    expect(finishedTurnText([null])).toBeUndefined()
    expect(finishedTurnText([])).toBeUndefined()
  })
})
