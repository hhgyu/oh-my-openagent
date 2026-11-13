import { expect, test } from "bun:test"
import { suspendHandle } from "../lifecycle/shutdown"

test("owned suspension loses authority during await and writes or forgets nothing afterward", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const writes: unknown[] = [],
    forgotten: unknown[] = []
  let owns = true
  const record = { task_id: "st_000000ef", owned_session: { format: 1 } }
  const context = {
    store: {
      load: () => record,
      transition(...args: unknown[]) {
        writes.push(args)
      },
    },
    ownedSessions: {
      async suspend() {
        entered.resolve()
        await release.promise
      },
    },
    registry: {
      forget(...args: unknown[]) {
        forgotten.push(args)
      },
    },
    now: () => 1000,
  }
  const pending = suspendHandle(context as never, { task_id: record.task_id } as never, "reload", () => owns)
  await entered.promise
  owns = false
  release.resolve()
  await pending
  expect(writes).toEqual([])
  expect(forgotten).toEqual([])
})
