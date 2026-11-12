import { describe, expect, test } from "bun:test"
import type { KernelToolGrant } from "@oh-my-opencode/senpi-task"
import { createOwnedHostToolBridge, type OwnedEvalHostToolCall } from "./codemode-host-tools"
import type { KernelToolsCapabilityProxy } from "./codemode-capability"
import { childKernelScope, createKernelToolInvoker, kernelToolOutcomeCode } from "./kernel-tool-proxy"
import { connectFakeWorker } from "./test-support"

const DOUBLE = { name: "double", description: "Doubles n", input_schema: { type: "object" }, language: "js" as const, kernel_generation: 1, definition_revision: 1 }

/** codemode's live capability as the JS kernel publishes it inside the worker, fenced by kernel generation. */
function liveCapability(invokeScope = true) {
  const calls: { request: unknown; options: Record<string, unknown> }[] = []
  let generation = 1
  const capability = {
    capabilities: { invokeScope },
    describe: async () => ({ results: [] }),
    invoke: async (request: { kernel_generation: number; args: { n: number } }, options: Record<string, unknown> = {}) => {
      calls.push({ request, options })
      if (request.kernel_generation !== generation) throw Object.assign(Error("kernel was reset"), { code: "kernel_tool_stale" })
      return request.args.n * 2
    },
  }
  return { capability, calls, reset: () => { generation++ } }
}

function grantOver(capability: KernelToolGrant["capability"], scope?: KernelToolGrant["scope"]): KernelToolGrant {
  return { capability, descriptors: [DOUBLE], requestedNames: ["double"], ...(scope && { scope }) }
}

/** A root eval cell whose owned host tool captures the main-thread capability proxy, as `tools.task` does. */
async function proxyThroughWorker() {
  const live = liveCapability()
  const seen: OwnedEvalHostToolCall[] = []
  const fake = connectFakeWorker({
    ownedTools: [{ name: "probe", description: "p", parameters: {}, async execute(_params, call) { seen.push(call); return { content: [] } } }],
    execute: async input => {
      await createOwnedHostToolBridge({ sessionID: input.sessionID, tools: input.ownedTools, readKernelTools: () => live.capability }).executeTool("probe", {})
      return { content: [] }
    },
  })
  const session = await fake.backend.acquire("ses_root", new AbortController().signal)
  await session.run("call_eval", {}, new AbortController().signal, () => {})
  const proxy = seen[0]?.kernelTools as KernelToolsCapabilityProxy | undefined
  if (!proxy) throw Error("the owned host tool received no capability proxy")
  return { live, fake, proxy, seen }
}

const call = (name = "double", n = 21) => ({ name, args: { n }, callID: "kc_1", signal: new AbortController().signal })

describe("child kernel tool invoker over the worker capability proxy", () => {
  test("#given a granted double #when the child invokes it #then the worker's live capability answers 42 with the child invoker and the child scope", async () => {
    // given
    const { live, fake, proxy, seen } = await proxyThroughWorker()
    const invoker = createKernelToolInvoker({ grant: grantOver(proxy, { tools: { allow: ["read", "task"], deny: ["bash"] } }), invokerSessionID: "ses_child" })
    // when
    const outcome = await invoker.invoke(call())
    // then
    expect(seen[0]?.toolCallId).toBe("call_eval")
    expect(JSON.parse(outcome.text)).toEqual({ kernel_tool: "double", value: 42 })
    expect(outcome.isError).toBe(false)
    expect(live.calls[0]?.request).toEqual({ name: "double", kernel_generation: 1, definition_revision: 1, args: { n: 21 }, call_id: "kc_1" })
    expect(live.calls[0]?.options.invoker).toEqual({ sessionId: "ses_child" })
    expect(live.calls[0]?.options.scope).toEqual({ tools: { allow: ["read"], deny: ["bash", "task"] } })
    await fake.backend.dispose()
    fake.close()
  })

  test("#given a bound child #when the parent kernel resets, then its session is released #then calls fail kernel_tool_stale, then tools_unavailable", async () => {
    // given
    const { live, fake, proxy } = await proxyThroughWorker()
    const invoker = createKernelToolInvoker({ grant: grantOver(proxy), invokerSessionID: "ses_child" })
    // when
    live.reset()
    const stale = await invoker.invoke(call())
    await fake.backend.release("ses_root")
    const released = await invoker.invoke(call())
    // then
    expect(stale.details.error?.code).toBe("kernel_tool_stale")
    expect(released.details.error?.code).toBe("tools_unavailable")
    expect(live.calls).toHaveLength(1)
    await fake.backend.dispose()
    fake.close()
  })

  test("#given a bound child #when the eval worker crashes or eval is disposed #then calls fail cleanly as tools_unavailable", async () => {
    // given
    const crashed = await proxyThroughWorker()
    const disposed = await proxyThroughWorker()
    const first = createKernelToolInvoker({ grant: grantOver(crashed.proxy), invokerSessionID: "ses_child" })
    const second = createKernelToolInvoker({ grant: grantOver(disposed.proxy), invokerSessionID: "ses_child" })
    // when
    crashed.fake.crash("boom")
    await disposed.fake.backend.dispose()
    const outcomes = [await first.invoke(call()), await second.invoke(call())]
    // then
    expect(outcomes.map(outcome => outcome.details.error?.code)).toEqual(["tools_unavailable", "tools_unavailable"])
    await crashed.fake.backend.dispose()
    crashed.fake.close()
    disposed.fake.close()
  })

  test("#given a cell call that ran after its eval call returned #then the host tool sees no running eval call", async () => {
    // given
    const live = liveCapability()
    const seen: OwnedEvalHostToolCall[] = []
    let later: (() => Promise<unknown>) | undefined
    const fake = connectFakeWorker({
      ownedTools: [{ name: "probe", description: "p", parameters: {}, async execute(_params, hostCall) { seen.push(hostCall); return { content: [] } } }],
      execute: async input => {
        const bridge = createOwnedHostToolBridge({ sessionID: input.sessionID, tools: input.ownedTools, readKernelTools: () => live.capability })
        later = () => bridge.executeTool("probe", {})
        return { content: [] }
      },
    })
    const session = await fake.backend.acquire("ses_root", new AbortController().signal)
    await session.run("call_eval", {}, new AbortController().signal, () => {})
    // when
    await later?.()
    // then
    expect(seen).toHaveLength(1)
    expect(seen[0]?.toolCallId).toBeUndefined()
    await fake.backend.dispose()
    fake.close()
  })
})

describe("child kernel tool invoker semantics", () => {
  test("#given a revoked binding or an ungranted name #then the call never reaches the capability", async () => {
    // given
    const live = liveCapability()
    let current = true
    const invoker = createKernelToolInvoker({ grant: grantOver(live.capability), invokerSessionID: "ses_child", isCurrent: () => current })
    // when
    const missing = await invoker.invoke(call("triple"))
    current = false
    const revoked = await invoker.invoke(call())
    // then
    expect(missing.details.error?.code).toBe("kernel_tool_missing")
    expect(revoked.details.error?.code).toBe("tools_unavailable")
    expect(live.calls).toEqual([])
  })

  test("#given a capability without invokeScope #then no scope is sent", async () => {
    // given
    const live = liveCapability(false)
    const invoker = createKernelToolInvoker({ grant: grantOver(live.capability), invokerSessionID: "ses_child" })
    // when
    await invoker.invoke(call())
    // then
    expect(childKernelScope(grantOver(live.capability))).toBeUndefined()
    expect(live.calls[0]?.options.scope).toBeUndefined()
    expect(live.calls[0]?.options.invoker).toEqual({ sessionId: "ses_child" })
  })

  test("#given thrown errors #then codemode codes survive, a released capability is unavailable and anything else is a failure", () => {
    // given
    const errors = [{ code: "kernel_tool_recursion" }, { code: "kernel_capability_released" }, { code: "something_else" }, Error("plain"), "text"]
    // when
    const codes = errors.map(kernelToolOutcomeCode)
    // then
    expect(codes).toEqual(["kernel_tool_recursion", "tools_unavailable", "kernel_tool_failed", "kernel_tool_failed", "kernel_tool_failed"])
  })
})
