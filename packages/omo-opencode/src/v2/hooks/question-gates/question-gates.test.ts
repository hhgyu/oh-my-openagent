import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { GATED_NO_ANSWER, matchGate, PINNED_GATE_HEADERS, registerQuestionGates } from "./index"

type Callback = (event: Record<string, unknown>) => void | Promise<void>

function fakeHost(options: Record<string, unknown> = {}) {
  const hooks = new Map<string, Callback>()
  let registrations = 0,
    disposals = 0
  const host = {
    options,
    tool: {
      hook: async (name: string, callback: Callback) => {
        hooks.set(name, callback)
        registrations++
        return {
          dispose: async () => {
            disposals++
            hooks.delete(name)
          },
        }
      },
    },
    session: {
      hook: async (name: string, callback: Callback) => {
        hooks.set(`session.${name}`, callback)
        registrations++
        return {
          dispose: async () => {
            disposals++
            hooks.delete(`session.${name}`)
          },
        }
      },
    },
  } as unknown as Parameters<typeof registerQuestionGates>[0]
  let call = 0
  const ask = (input: Record<string, unknown>, settle: Record<string, unknown>, tool = "question") => {
    const id = `call-${++call}`
    const base = { tool, sessionID: "s1", agent: "build", messageID: "m", id }
    const before = { ...base, input }
    void hooks.get("execute.before")?.(before)
    const after = { ...base, input, ...settle }
    void hooks.get("execute.after")?.(after)
    return { before, after }
  }
  const beforeOnly = (input: Record<string, unknown>, sessionID = "s1") => {
    void hooks.get("execute.before")?.({
      tool: "question",
      sessionID,
      agent: "build",
      messageID: "m",
      id: `call-${++call}`,
      input,
    })
  }
  const context = (sessionID = "s1") => {
    const value = { sessionID, system: [] as { type: string; text: string; metadata?: Record<string, unknown> }[] }
    void hooks.get("session.context")?.(value)
    return value.system.filter((part) => part.text === GATED_NO_ANSWER).length
  }
  return { host, hooks, ask, beforeOnly, context, counts: () => [registrations, disposals] }
}

function fork(header: string, question: string, labels: readonly string[]): Record<string, unknown> {
  return { header, question, multiple: false, options: labels.map((label) => ({ label, description: label })) }
}

// The ulw-plan approval gate as recorded in the Senpi live QA (#9775), in OpenCode 2's question shape.
function gateInput(): Record<string, unknown> {
  return {
    questions: [
      fork("Approval", "Approve this plan approach?", ["Approve", "Approve, skip review", "Change approach"]),
    ],
  }
}

const dismissed = () => ({
  status: "error",
  error: new ToolError({ message: "The user dismissed this question", metadata: { keep: 1 } }),
})

describe("v2 question-gates", () => {
  test("#given a gated question dismissed with no execute.after #when the session's next model request is built #then it carries the refusal exactly once", async () => {
    // given
    const f = fakeHost()
    await registerQuestionGates(f.host)
    f.beforeOnly(gateInput())

    // when
    const other = f.context("s2"),
      first = f.context(),
      second = f.context()

    // then
    expect([other, first, second]).toEqual([0, 1, 0])
  })

  test("#given a gated question that settled #when the next model request is built #then nothing is injected", async () => {
    // given
    const f = fakeHost()
    await registerQuestionGates(f.host)
    f.ask(gateInput(), { status: "completed", result: { content: "Approve" } })

    // when
    const injected = f.context()

    // then
    expect(injected).toBe(0)
  })

  test.each([
    ["pinned header", gateInput(), "header", "Approval"],
    ["lowercase british header", { questions: [fork("authorise", "Proceed?", ["Yes", "No"])] }, "header", "authorise"],
    ["korean header", { questions: [fork("승인", "진행할까요?", ["예", "아니오"])] }, "header", "승인"],
    [
      "approve label without pinned header",
      { questions: [fork("Next step", "Pick one", ["Approve and run", "Stop"])] },
      "label",
      "Next step",
    ],
  ])(
    "#given a gating question with a %s #when it settles without an answer #then the tool error refuses the gated action",
    async (_label, input, rule, header) => {
      // given
      const f = fakeHost()
      await registerQuestionGates(f.host)
      const snapshot = structuredClone(input)

      // when
      const { after } = f.ask(input, dismissed())

      // then
      const error = after.error as ToolError
      expect(error).toBeInstanceOf(ToolError)
      expect(error.message.startsWith("The user dismissed this question")).toBe(true)
      expect(error.message.endsWith(GATED_NO_ANSWER)).toBe(true)
      expect(error.metadata).toEqual({ keep: 1, omoQuestionGate: { rule, header } })
      expect(input).toEqual(snapshot)
    },
  )

  test.each([
    [
      "question text that mentions approval",
      { questions: [fork("Scope", "Do you approve this plan?", ["Full", "Minimal"])] },
    ],
    ["header that only contains a gate word", { questions: [fork("Approval flow", "Pick", ["Yes", "No"])] }],
    ["label that only continues a gate word", { questions: [fork("Pick", "Pick", ["Approved list", "Other"])] }],
  ])(
    "#given a fork whose %s #when it settles without an answer #then the error is untouched",
    async (_label, input) => {
      // given
      const f = fakeHost()
      await registerQuestionGates(f.host)
      const settle = dismissed()

      // when
      const { after } = f.ask(input, settle)

      // then
      expect(after.error).toBe(settle.error)
    },
  )

  test("#given a gating question #when the user answers #then the result passes through untouched", async () => {
    // given
    const f = fakeHost()
    await registerQuestionGates(f.host)
    const result = { content: "Approve", metadata: { answers: [["Approve"]] } }

    // when
    const { after } = f.ask(gateInput(), { status: "completed", result })

    // then
    expect(after.result).toBe(result)
    expect("error" in after).toBe(false)
  })

  test("#given a gate input on a non-question tool #when it errors #then the error is untouched", async () => {
    // given
    const f = fakeHost()
    await registerQuestionGates(f.host)
    const settle = dismissed()

    // when
    const { after } = f.ask(gateInput(), settle, "todowrite")

    // then
    expect(after.error).toBe(settle.error)
  })

  test("#given an error that already carries the refusal #when it settles #then the refusal is not repeated", async () => {
    // given
    const f = fakeHost()
    await registerQuestionGates(f.host)
    const settle = { status: "error", error: new ToolError({ message: `No user attached\n${GATED_NO_ANSWER}` }) }

    // when
    const { after } = f.ask(gateInput(), settle)

    // then
    expect(after.error).toBe(settle.error)
  })

  test("#given strict disable options or env #when registering #then no hook is registered", async () => {
    const prior = process.env.OMO_SENPI_DISABLED
    try {
      delete process.env.OMO_SENPI_DISABLED
      for (const key of ["omo-senpi-disabled", "omo-senpi-question-gates-disabled"]) {
        // given
        const f = fakeHost({ [key]: true })
        // when
        await registerQuestionGates(f.host)
        // then
        expect(f.counts()).toEqual([0, 0])
      }
      process.env.OMO_SENPI_DISABLED = "1"
      const g = fakeHost()
      await registerQuestionGates(g.host)
      expect(g.counts()).toEqual([0, 0])
    } finally {
      if (prior === undefined) delete process.env.OMO_SENPI_DISABLED
      else process.env.OMO_SENPI_DISABLED = prior
    }
  })

  test("#given a registration #when cleanup runs twice #then every hook is disposed once and captured hooks go inert", async () => {
    // given
    const f = fakeHost()
    const close = await registerQuestionGates(f.host)
    const before = f.hooks.get("execute.before"),
      after = f.hooks.get("execute.after")

    // when
    await close()
    await close()

    // then
    expect(f.counts()).toEqual([3, 3])
    const settle = dismissed()
    const event = { tool: "question", sessionID: "s1", id: "late", input: gateInput(), ...settle }
    await before?.(event)
    await after?.(event)
    expect(event.error).toBe(settle.error)
  })
})

describe("v2 question-gates parity with the Senpi component", () => {
  const senpiComponents = join(
    dirname(dirname(dirname(dirname(dirname(import.meta.dir))))),
    "omo-senpi",
    "src",
    "components",
  )

  test("#given Senpi's gate rule #when both classify the same inputs #then headers and matches agree", async () => {
    // given
    const senpi = (await import(pathToFileURL(join(senpiComponents, "question-gates", "gate-rule.ts")).href)) as {
      PINNED_GATE_HEADERS: readonly string[]
      matchGate(input: unknown): unknown
    }
    const inputs: unknown[] = [
      gateInput(),
      null,
      [],
      { questions: "x" },
      { questions: [null, 3] },
      { questions: [fork("  Authorize  ", "q", ["a"])] },
      { questions: [fork("x", "q", ["authorize-ish"]), fork("Approval", "q", [])] },
      { questions: [fork("x", "q", ["Approve"])] },
      { questions: [fork("Approvals", "q", ["Approver"])] },
      { questions: [{ options: [{ label: 4 }, { label: " APPROVE " }] }] },
    ]

    // when
    const v2 = inputs.map(matchGate)

    // then
    expect([...PINNED_GATE_HEADERS]).toEqual([...senpi.PINNED_GATE_HEADERS])
    expect(v2).toEqual(inputs.map((input) => senpi.matchGate(input)))
  })

  test("#given senpi's shipped ask-user formatter #when its gated no-answer constant is read #then the V2 refusal is the same string", () => {
    // given
    const senpiDist = dirname(fileURLToPath(import.meta.resolve("@code-yeongyu/senpi")))
    const source = readFileSync(join(senpiDist, "core", "extensions", "builtin", "ask-user", "format.js"), "utf8")

    // when
    const shipped = /const GATED_NO_ANSWER = "([^"]+)";/.exec(source)?.[1]

    // then
    expect(shipped).toBe(GATED_NO_ANSWER)
  })
})
