import { describe, expect, test } from "bun:test"
import { createRpcPeer, type RpcHandler, type RpcPort } from "./codemode-rpc"

function pair() {
  const channel = new MessageChannel()
  const port = (side: MessagePort): RpcPort => ({
    postMessage: (message) => side.postMessage(message),
    addEventListener: (_type, listener) => {
      side.addEventListener("message", listener)
      side.start()
    },
  })
  return {
    a: port(channel.port1),
    b: port(channel.port2),
    close: () => {
      channel.port1.close()
      channel.port2.close()
    },
  }
}

describe("codemode rpc peer", () => {
  test("#given a handler #when called #then progress updates stream, the result returns and a thrown code survives the boundary", async () => {
    // given
    const ports = pair()
    const handlers: Record<string, RpcHandler> = {
      echo: (params, call) => {
        call.update("half")
        return { echoed: params }
      },
      fail: () => {
        throw Object.assign(Error("stale"), { name: "KernelError", code: "kernel_tool_stale" })
      },
    }
    createRpcPeer(ports.b, handlers)
    const caller = createRpcPeer(ports.a, {})
    const updates: unknown[] = []

    // when
    const value = await caller.call("echo", 7, { onUpdate: (update) => updates.push(update) })
    const error = await caller.call("fail", null).catch((caught: unknown) => caught)
    const unknown = await caller.call("nope", null).catch((caught: unknown) => caught)

    // then
    expect(value).toEqual({ echoed: 7 })
    expect(updates).toEqual(["half"])
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: "KernelError", message: "stale", code: "kernel_tool_stale" })
    expect((unknown as Error).message).toContain("unknown codemode worker method nope")
    ports.close()
  })

  test("#given a long call #when the caller aborts with and without grace #then the callee signal aborts with the reason and the caller rejects", async () => {
    // given
    const ports = pair()
    const reasons: string[] = []
    createRpcPeer(ports.b, {
      wait: (_params, call) =>
        new Promise((_resolve, reject) =>
          call.signal.addEventListener(
            "abort",
            () => {
              reasons.push((call.signal.reason as Error).message)
              reject(Error("cell stopped"))
            },
            { once: true },
          ),
        ),
    })
    const caller = createRpcPeer(ports.a, {})
    const quick = new AbortController(),
      graceful = new AbortController()

    // when
    const first = caller.call("wait", null, { signal: quick.signal }).catch((caught: unknown) => caught)
    const second = caller
      .call("wait", null, { signal: graceful.signal, abortGraceMs: 1_000 })
      .catch((caught: unknown) => caught)
    await Bun.sleep(5)
    quick.abort(Error("now"))
    graceful.abort(Error("later"))

    // then
    expect(((await first) as Error).message).toBe("now")
    expect(((await second) as Error).message).toBe("cell stopped")
    expect(reasons.sort()).toEqual(["later", "now"])
    ports.close()
  })

  test("#given pending calls #when the peer closes #then they reject and new calls are refused; an uncloneable result becomes an error", async () => {
    // given
    const ports = pair()
    createRpcPeer(ports.b, { hang: () => new Promise(() => {}), fn: () => () => 1 })
    const caller = createRpcPeer(ports.a, {})
    const pending = caller.call("hang", null).catch((caught: unknown) => caught)
    const uncloneable = await caller.call("fn", null).catch((caught: unknown) => caught)

    // when
    caller.close(Error("worker gone"))
    const refused = await caller.call("hang", null).catch((caught: unknown) => caught)

    // then
    expect(((await pending) as Error).message).toBe("worker gone")
    expect((refused as Error).message).toBe("worker gone")
    expect(uncloneable).toMatchObject({ name: "DataCloneError" })
    ports.close()
  })
})
