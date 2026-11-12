import { describe, expect, test } from "bun:test"
import type { Result, ToolContext } from "@opencode/plugin/promise/tool"
import type { OwnedEvalHostTool, OwnedEvalHostToolCall } from "./codemode-host-tools"
import { createEvalTaskHostTool, createEvalTaskPort, EVAL_TASK_HOST_TOOL_NAME } from "./eval-task-host-tool"
import { bindEvalCallers } from "./native-eval"

function evalContext(sessionID = "ses_root", id = "call_eval"): ToolContext {
  return { sessionID, id, agent: "build", messageID: "msg_1", signal: new AbortController().signal, progress: async () => {} } as unknown as ToolContext
}

describe("eval task port", () => {
  test("#given no attached Native task component #when a cell calls task #then it is refused, and a second attach is refused", async () => {
    // given
    const port = createEvalTaskPort()
    // when
    const unattached = await port.invoke({}, evalContext(), undefined).catch((error: unknown) => error)
    const detach = port.attach(async () => ({ content: [] }))
    const second = (() => { try { port.attach(async () => ({ content: [] })); return undefined } catch (error) { return error } })()
    detach()
    const detached = await port.invoke({}, evalContext(), undefined).catch((error: unknown) => error)
    // then
    expect(unattached).toBeInstanceOf(Error)
    expect(second).toBeInstanceOf(Error)
    expect(detached).toBeInstanceOf(Error)
  })
})

describe("owned eval task host tool", () => {
  test("#given a running eval call #when the cell calls task #then the Native task runs under that call's identity with the cell's capability", async () => {
    // given
    const port = createEvalTaskPort()
    const received: { input?: unknown; caller?: ToolContext; kernelTools?: unknown } = {}
    port.attach(async (input, caller, kernelTools) => {
      Object.assign(received, { input, caller, kernelTools })
      await caller.progress({ ignored: true } as unknown as Parameters<ToolContext["progress"]>[0])
      return { content: [{ type: "text", text: "task started" }], metadata: { nativeTask: { task_id: "st_1" } } } as Result
    })
    const tool = createEvalTaskHostTool(port)
    const caller = evalContext(), capability = { capabilityId: "cap_1" }, hostSignal = new AbortController()
    // when
    const result = await tool.execute({ prompt: "p", tools: ["double"] }, { sessionID: "ses_root", caller, kernelTools: capability, signal: hostSignal.signal })
    hostSignal.abort(Error("cell aborted"))
    // then
    expect(tool.name).toBe(EVAL_TASK_HOST_TOOL_NAME)
    expect(received.input).toEqual({ prompt: "p", tools: ["double"] })
    expect(received.kernelTools).toBe(capability)
    expect([received.caller?.sessionID, received.caller?.id, received.caller?.agent, received.caller?.messageID]).toEqual(["ses_root", "call_eval", "build", "msg_1"])
    expect(received.caller?.signal.aborted).toBe(true)
    expect(result).toEqual({ content: [{ type: "text", text: "task started" }], details: { nativeTask: { task_id: "st_1" } } })
    expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual(tool.parameters)
  })

  test("#given no running eval call #when a detached cell calls task #then it is refused before the Native task component", async () => {
    // given
    const port = createEvalTaskPort()
    let calls = 0
    port.attach(async () => { calls++; return { content: [] } })
    const tool = createEvalTaskHostTool(port)
    // when
    const detached = await tool.execute({ prompt: "p" }, { sessionID: "ses_root" }).catch((error: unknown) => error)
    const foreign = await tool.execute({ prompt: "p" }, { sessionID: "ses_root", caller: evalContext("ses_other") }).catch((error: unknown) => error)
    // then
    expect(detached).toBeInstanceOf(Error)
    expect(foreign).toBeInstanceOf(Error)
    expect(calls).toBe(0)
  })
})

describe("eval caller binding", () => {
  test("#then a host-tool call gets the running eval call's context only in the same session", async () => {
    // given
    const seen: (ToolContext | undefined)[] = []
    const probe: OwnedEvalHostTool = { name: "probe", description: "p", parameters: {}, async execute(_params, call) { seen.push(call.caller); return { content: [] } } }
    const context = evalContext()
    const running = new Map([["call_eval", context]])
    const [bound] = bindEvalCallers([probe], running)
    if (!bound) throw Error("no bound tool")
    const call = (patch: Partial<OwnedEvalHostToolCall>): OwnedEvalHostToolCall => ({ sessionID: "ses_root", ...patch })
    // when
    await bound.execute({}, call({ toolCallId: "call_eval" }))
    await bound.execute({}, call({ toolCallId: "call_eval", sessionID: "ses_other" }))
    await bound.execute({}, call({ toolCallId: "call_done" }))
    await bound.execute({}, call({}))
    // then
    expect(seen).toEqual([context, undefined, undefined, undefined])
  })
})
