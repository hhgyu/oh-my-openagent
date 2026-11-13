import { expect, test } from "bun:test"
import { createAcceptedOperationRegistry } from "./accepted-operation"

test("accepted registry retains the original promise and joins actual settlement without racing it", async () => {
  const registry = createAcceptedOperationRegistry(),
    gate = Promise.withResolvers<void>()
  const original = gate.promise
  expect(registry.track(original)).toBe(original)
  let joined = false
  const closing = registry.join().then(() => {
    joined = true
  })
  await Promise.resolve()
  expect(joined).toBe(false)
  expect(registry.diagnostics().pending).toBe(1)
  gate.resolve()
  await closing
  expect(registry.diagnostics().pending).toBe(0)
})

test("registry stops admission and joins original continuations including rejected transport", async () => {
  const registry = createAcceptedOperationRegistry(),
    first = Promise.withResolvers<void>(),
    late = Promise.withResolvers<void>()
  let stops = 0
  registry.add(() => {
    stops++
  })
  registry
    .track(
      first.promise.then(() => {
        registry.track(late.promise)
        throw Error("actual rejection")
      }),
    )
    .catch(() => {})
  registry.stop()
  expect(() => registry.add(() => {})).toThrow()
  first.resolve()
  let joined = false
  const closing = registry.join().then(() => {
    joined = true
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(joined).toBe(false)
  late.resolve()
  await closing
  expect(stops).toBe(1)
})

test("actual cleanup rejection remains a retryable resource instead of allSettled success", async () => {
  const registry = createAcceptedOperationRegistry()
  let fail = true,
    attempts = 0
  registry.cleanup(() => {
    attempts++
    if (fail) throw Error("controlled original resource close failure")
  })
  await expect(registry.join()).rejects.toThrow("resource cleanup incomplete")
  expect(registry.diagnostics().resources).toBe(1)
  fail = false
  await registry.join()
  expect(attempts).toBe(2)
  expect(registry.diagnostics().resources).toBe(0)
})
