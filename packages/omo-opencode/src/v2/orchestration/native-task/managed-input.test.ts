import { expect, test } from "bun:test"
import { InputUncertainError } from "@oh-my-opencode/senpi-task/manager-kernel"
import { SessionBackendError, type ChildHandle } from "../../host/session-backend"
import { createOwnedManagedInput, ownedInputID } from "./managed-input"

const locator = {
  format: 1 as const,
  backendID: "owned",
  location: "/project",
  parentID: "parent",
  sessionID: "child",
  generation: 1,
  hostVersion: "2.2.6",
} as unknown as ChildHandle["locator"]
const child = { locator } as unknown as ChildHandle
test("Native IDs map unambiguously to SDK msg_ IDs across recovery without owner/generation churn", () => {
  expect(ownedInputID(locator, "task:0:1")).toMatch(/^msg_omo_[a-f0-9]{64}$/)
  expect(ownedInputID(locator, "task:0:1")).toBe(ownedInputID({ ...locator, generation: 9 }, "task:0:1"))
  expect(ownedInputID(locator, "ab:c")).not.toBe(
    ownedInputID({ ...locator, sessionID: "child:ab" as ChildHandle["locator"]["sessionID"] }, "c"),
  )
  expect(ownedInputID(locator, "task:0:1")).not.toBe(
    ownedInputID({ ...locator, sessionID: "other" as ChildHandle["locator"]["sessionID"] }, "task:0:1"),
  )
})
test("managed input registers ownership/expected ID before actual dispatch and keeps queue delivery", async () => {
  const order: string[] = [],
    sent: unknown[] = []
  const input = createOwnedManagedInput({
    child,
    backend: {
      async promptContinuation(_child, value) {
        order.push("dispatch")
        sent.push(value)
        return { state: "accepted", inboxID: value.id, consumption: "unconfirmed" }
      },
    },
    assertOwned() {
      order.push("guard")
    },
    identify() {
      order.push("identity")
    },
    expectInput() {
      order.push("expect")
    },
    async synchronize() {
      order.push("sync")
    },
    onUncertain() {
      throw Error("unexpected")
    },
  })
  await input.send("hello", "queue", { clientMessageId: "native-queued-id" })
  expect(order).toEqual(["guard", "identity", "expect", "dispatch", "sync", "guard"])
  expect(sent).toEqual([
    { id: ownedInputID(locator, "native-queued-id"), text: "hello", delivery: "queue", resume: true },
  ])
  expect(input.diagnostics().last?.disposition).toBe("accepted")
  await input.close()
})
test("unknown dispatch is the canonical uncertainty and cannot trigger another attempt", async () => {
  let sends = 0,
    marked = 0
  const input = createOwnedManagedInput({
    child,
    backend: {
      async promptContinuation() {
        sends++
        throw new SessionBackendError("uncertain", "lost ACK")
      },
    },
    assertOwned() {},
    identify() {},
    expectInput() {},
    async synchronize() {},
    onUncertain() {
      marked++
    },
  })
  await expect(input.send("hello", "steer", { clientMessageId: "native-id" })).rejects.toBeInstanceOf(
    InputUncertainError,
  )
  await expect(input.send("again", "steer", { clientMessageId: "native-id" })).rejects.toBeInstanceOf(
    InputUncertainError,
  )
  expect(sends).toBe(1)
  expect(marked).toBe(1)
  expect(input.diagnostics().uncertainEffectID).toBe("native-id")
  await input.close()
})
test("an accepted reserved ID is not resent or mislabeled as exact payload equivalence", async () => {
  const ids = new Set<string>()
  let dispatches = 0
  const input = createOwnedManagedInput({
    child,
    backend: {
      async promptContinuation(_child, value) {
        if (ids.has(value.id)) throw new SessionBackendError("state", "Admission ID already reserved or empty")
        ids.add(value.id)
        dispatches++
        return { state: "accepted", inboxID: value.id, consumption: "unconfirmed" }
      },
    },
    assertOwned() {},
    identify() {},
    expectInput() {},
    async synchronize() {},
    onUncertain() {},
  })
  await input.send("first", "steer", { clientMessageId: "same-native-id" })
  const error = await input.send("changed", "steer", { clientMessageId: "same-native-id" }).catch((error) => error)
  expect(error).toBeInstanceOf(InputUncertainError)
  expect(error.message).toContain("equivalence is unconfirmed")
  expect(dispatches).toBe(1)
  await input.close()
})
test("owner cancellation joins an actual pending input request without claiming host interruption", async () => {
  const entered = Promise.withResolvers<void>()
  let joined = false
  const input = createOwnedManagedInput({
    child,
    backend: {
      async promptContinuation(_child, _value, options) {
        entered.resolve()
        await new Promise<void>((_yes, no) =>
          defined(defined(options).signal).addEventListener(
            "abort",
            () => {
              joined = true
              no(new SessionBackendError("uncertain", "controlled abort"))
            },
            { once: true },
          ),
        )
        throw Error("unreachable")
      },
    },
    assertOwned() {},
    identify() {},
    expectInput() {},
    async synchronize() {},
    onUncertain() {},
  })
  const sending = input.send("hello", "steer")
  const rejected = sending.catch((error) => error)
  await entered.promise
  await input.abortPending()
  expect(await rejected).toBeInstanceOf(InputUncertainError)
  expect(joined).toBe(true)
  expect(input.diagnostics().pending).toBe(0)
  await input.close()
})
function defined<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("expected a defined value")
  return value
}
