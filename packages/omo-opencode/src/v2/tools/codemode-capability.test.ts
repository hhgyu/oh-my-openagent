import { describe, expect, test } from "bun:test"
import { createOwnedHostToolBridge, type OwnedEvalHostToolCall } from "./codemode-host-tools"
import type { KernelToolsCapabilityProxy } from "./codemode-capability"
import { connectFakeWorker } from "./test-support"

const REQUEST = { name: "double", kernel_generation: 1, definition_revision: 1, args: { n: 21 }, call_id: "k1" }

/** A live kernel-tools capability as codemode's JS kernel publishes it: it exists only in the worker. */
function liveCapability() {
  const calls: { request: unknown; options: Record<string, unknown> }[] = []
  let generation = 1
  const capability = {
    capabilities: { invokeScope: true },
    describe: async (names: readonly string[]) => ({ results: names.map(name => ({ name, ok: true })) }),
    invoke: (request: { kernel_generation: number; args: { n: number } }, options: Record<string, unknown> = {}) => {
      calls.push({ request, options })
      if (request.kernel_generation !== generation) return Promise.reject(Object.assign(Error("kernel was reset"), { code: "kernel_tool_stale" }))
      const signal = options.signal as AbortSignal | undefined
      if (request.args.n < 0) return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }))
      return Promise.resolve(request.args.n * 2)
    },
  }
  return { capability, calls, reset: () => { generation++ } }
}

describe("kernel tools capability across the worker boundary", () => {
  test("#given a cell calls an owned host tool #when it runs on the main thread #then it gets a proxy whose invoke and describe reach the live capability with scope, invoker and signal", async () => {
    // given
    const live = liveCapability()
    const received: { call?: OwnedEvalHostToolCall; proxy?: KernelToolsCapabilityProxy } = {}
    let outcome: unknown
    const fake = connectFakeWorker({
      ownedTools: [{
        name: "probe", description: "p", parameters: {},
        async execute(_params, call) {
          const proxy = call.kernelTools as KernelToolsCapabilityProxy
          Object.assign(received, { call, proxy })
          const doubled = await proxy.invoke(REQUEST, { scope: { tools: { allow: ["read"], deny: ["bash"] } }, invoker: { sessionId: "ses_child" }, signal: new AbortController().signal })
          const described = await proxy.describe(["double"])
          return { content: [{ type: "text", text: JSON.stringify({ doubled, described }) }] }
        },
      }],
      execute: async input => {
        const bridge = createOwnedHostToolBridge({ sessionID: input.sessionID, tools: input.ownedTools, readKernelTools: () => live.capability })
        outcome = await bridge.executeTool("probe", { x: 1 })
        return { content: [] }
      },
    })
    const session = await fake.backend.acquire("ses_root", new AbortController().signal)

    // when
    await session.run("call_1", {}, new AbortController().signal, () => {})

    // then
    expect(received.call?.sessionID).toBe("ses_root")
    expect(received.proxy?.ownerSessionID).toBe("ses_root")
    expect(received.proxy?.capabilities).toEqual({ invokeScope: true })
    expect(outcome).toEqual({ content: [{ type: "text", text: JSON.stringify({ doubled: 42, described: { results: [{ name: "double", ok: true }] } }) }] })
    expect(live.calls).toHaveLength(1)
    expect(live.calls[0]?.request).toEqual(REQUEST)
    expect(live.calls[0]?.options.scope).toEqual({ tools: { allow: ["read"], deny: ["bash"] } })
    expect(live.calls[0]?.options.invoker).toEqual({ sessionId: "ses_child" })
    expect(live.calls[0]?.options.signal).toBeInstanceOf(AbortSignal)
    await fake.backend.dispose()
    fake.close()
  })

  test("#given a held proxy #when the caller aborts, the kernel resets, and the session is released #then the abort reaches the capability and codemode's codes survive", async () => {
    // given
    const live = liveCapability()
    let proxy: KernelToolsCapabilityProxy | undefined
    const fake = connectFakeWorker({
      ownedTools: [{ name: "probe", description: "p", parameters: {}, async execute(_params, call) { proxy = call.kernelTools as KernelToolsCapabilityProxy; return { content: [] } } }],
      execute: async input => {
        await createOwnedHostToolBridge({ sessionID: input.sessionID, tools: input.ownedTools, readKernelTools: () => live.capability }).executeTool("probe", {})
        return { content: [] }
      },
    })
    const session = await fake.backend.acquire("ses_root", new AbortController().signal)
    await session.run("call_1", {}, new AbortController().signal, () => {})
    const held = proxy
    if (!held) throw Error("the host tool never received a capability proxy")
    const controller = new AbortController()

    // when
    const hanging = held.invoke({ ...REQUEST, args: { n: -1 } }, { signal: controller.signal })
    await Bun.sleep(5)
    controller.abort(Error("child cancelled"))
    const aborted = await hanging.catch((caught: unknown) => caught)
    await Bun.sleep(5)
    live.reset()
    const stale = await held.invoke(REQUEST).catch((caught: unknown) => caught)
    await fake.backend.release("ses_root")
    const released = await held.invoke(REQUEST).catch((caught: unknown) => caught)

    // then
    expect((aborted as Error).message).toBe("child cancelled")
    expect((live.calls[0]?.options.signal as AbortSignal).aborted).toBe(true)
    expect((stale as { code?: string }).code).toBe("kernel_tool_stale")
    expect((released as { code?: string }).code).toBe("kernel_capability_released")
    await fake.backend.dispose()
    fake.close()
  })

  test("#given an isolated cell without a capability #when it calls an owned tool #then the tool gets no kernelTools", async () => {
    // given
    const seen: unknown[] = []
    const fake = connectFakeWorker({
      ownedTools: [{ name: "probe", description: "p", parameters: {}, async execute(_params, call) { seen.push(call.kernelTools); return { content: [] } } }],
      execute: async input => {
        await createOwnedHostToolBridge({ sessionID: input.sessionID, tools: input.ownedTools, readKernelTools: () => undefined }).executeTool("probe", {})
        return { content: [] }
      },
    })
    const session = await fake.backend.acquire("ses_root", new AbortController().signal)

    // when
    await session.run("call_1", {}, new AbortController().signal, () => {})

    // then
    expect(seen).toEqual([undefined])
    await fake.backend.dispose()
    fake.close()
  })
})
