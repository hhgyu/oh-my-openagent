import { describe, expect, test } from "bun:test"
import { EvalHostToolRefusedError, createOwnedHostToolBridge, type OwnedEvalHostToolCall } from "./codemode-host-tools"

describe("eval host tool bridge", () => {
  test("#given a cell calls a host tool the plugin does not own #when executeTool runs #then it is refused and nothing executes", async () => {
    // given
    const bridge = createOwnedHostToolBridge({ sessionID: "ses_1", tools: [], readKernelTools: () => undefined })

    // when
    const error = await bridge.executeTool("bash", { command: "rm -rf /" }).catch((caught: unknown) => caught)

    // then
    expect(error).toBeInstanceOf(EvalHostToolRefusedError)
    expect((error as Error).message).toContain(`Tool "bash" is not available inside an OpenCode eval cell`)
    expect(bridge.executeTool.isToolAvailable("bash")).toBe(false)
    expect(bridge.listTools()).toEqual([])
  })

  test("#given an owned tool #when a JS cell calls it #then the live capability read at entry is passed explicitly", async () => {
    // given
    const calls: OwnedEvalHostToolCall[] = []
    const capability = { invoke() {} }
    let store: unknown = capability
    const bridge = createOwnedHostToolBridge({
      sessionID: "ses_1",
      readKernelTools: () => store,
      tools: [
        {
          name: "probe",
          description: "probe",
          parameters: { type: "object" },
          async execute(_params, call) {
            await Promise.resolve()
            calls.push(call)
            return { content: [{ type: "text", text: "ok" }] }
          },
        },
      ],
    })
    const signal = new AbortController().signal

    // when
    const pending = bridge.executeTool("probe", { a: 1 }, { signal })
    store = undefined
    const result = await pending

    // then
    expect(result.content).toEqual([{ type: "text", text: "ok" }])
    expect(calls).toEqual([{ sessionID: "ses_1", signal, kernelTools: capability }])
    expect(bridge.executeTool.isToolAvailable("probe")).toBe(true)
    expect(bridge.listTools()).toEqual([{ name: "probe", description: "probe", parameters: { type: "object" } }])
  })

  test("#given two owned tools with one name #when the bridge is built #then it refuses the ambiguity", () => {
    // given
    const tool = { name: "probe", description: "", parameters: {}, execute: async () => ({ content: [] }) }

    // when
    const build = () =>
      createOwnedHostToolBridge({ sessionID: "s", tools: [tool, tool], readKernelTools: () => undefined })

    // then
    expect(build).toThrow("Duplicate eval host tool probe")
  })
})
