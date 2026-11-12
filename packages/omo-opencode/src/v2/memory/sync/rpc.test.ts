import { afterEach, describe, expect, test } from "bun:test"
import { registerMemoryComponent } from "../index"
import { createMemoryFixture, type MemoryFixture } from "../test-support"
import { MEMORY_SYNC_RPC_ID } from "./rpc"

const fixtures: MemoryFixture[] = []
const kindOf = (answer: unknown): unknown => typeof answer === "object" && answer !== null && "kind" in answer ? answer.kind : undefined
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup() })

/** The real lazily loaded sync host and memory-core coordinator over a signed-out device: no keyring, no network. */
async function signedOut() {
  const f = createMemoryFixture()
  fixtures.push(f)
  const cleanup = await registerMemoryComponent(f.host, f.options({ sync: { accountSource: async () => null } }))
  const registered = f.rpcs.get(MEMORY_SYNC_RPC_ID)
  if (registered === undefined) throw new Error("omo.memory.sync was not registered")
  const call = (method: string, input: unknown): Promise<unknown> => {
    const handler = registered.handlers[method]
    if (handler === undefined) throw new Error(`no ${method} handler`)
    return Reflect.apply(handler, undefined, [input, { signal: new AbortController().signal }])
  }
  return { f, cleanup, registered, call }
}

describe("omo.memory.sync RPC", () => {
  test("#given the memory component #when it registers #then omo.memory.sync carries Senpi's five methods and no events", async () => {
    // given
    const { cleanup, registered } = await signedOut()

    // when
    const methods = Object.keys(registered.definition.methods).sort()
    await cleanup()

    // then
    expect(methods).toEqual(["approve", "devices", "enable", "pending", "status"])
  })

  test("#given malformed requests #when each method is called #then the coordinator refuses them with Senpi's refusal shape", async () => {
    // given
    const { cleanup, call } = await signedOut()

    // when
    const approve = await call("approve", { action: "confirm", pendingId: "p", code: "12" })
    const enable = await call("enable", { unexpected: true })
    await cleanup()

    // then
    expect([kindOf(approve), kindOf(enable)]).toEqual(["refused", "refused"])
  })

  test("#given a signed-out device #when status, pending and devices are called #then each answers a typed problem, never a throw", async () => {
    // given
    const { cleanup, call } = await signedOut()

    // when
    const answers = [await call("status", {}), await call("pending", {}), await call("devices", {})]
    await cleanup()

    // then
    expect(answers.map(kindOf)).toEqual(["unavailable", "unavailable", "unavailable"])
  })

  test("#given the component closed #when a captured handler is called #then it answers unavailable", async () => {
    // given
    const { cleanup, call } = await signedOut()
    await cleanup()

    // when
    const answer = await call("status", {})

    // then
    expect(kindOf(answer)).toBe("unavailable")
  })
})
