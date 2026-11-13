import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { withNativeOperationService } from "./service.test"

type Invoke = Parameters<Parameters<typeof withNativeOperationService>[0]>[0]["invoke"]

/** One finished resident child, started and awaited through a genuine Native operation call. */
async function finished(invoke: Invoke, prompt: string): Promise<string> {
  return invoke(async (api) => {
    const started = await api.start({ category: "qa", prompt })
    if (started.kind !== "started") throw Error(`start: ${started.kind}`)
    await api.wait(started.task_id)
    return started.task_id
  })
}

describe("#given a finished resident child released by task_cancel", () => {
  test("#when the parent reads it and another child in later calls #then both reads still succeed", async () => {
    await withNativeOperationService(async (f) => {
      // given
      const released = await finished(f.invoke, "released child")
      const other = await finished(f.invoke, "other child")
      const cancel = await f.invoke((api) =>
        api.operation(async (_manager, _ancestry, _signal, operation) => operation.cancel.cancelTask(released)),
      )
      expect(cancel).toMatchObject({ kind: "released", task_id: released })
      // when
      const read = await f.invoke((api) =>
        api.operation(async (_manager, _ancestry, _signal, operation) => operation.output.get(released)),
      )
      const otherRead = await f.invoke((api) =>
        api.operation(async (_manager, _ancestry, _signal, operation) => operation.output.get(other)),
      )
      // then
      expect(read).toMatchObject({
        task_id: released,
        status: "completed",
        residency_state: "persisted_only",
        final_response: "result:released child",
      })
      expect(otherRead).toMatchObject({ task_id: other, status: "completed" })
    })
  })

  test("#when the parent destroys it through the operation destruction port #then teardown completes and a repeat read still succeeds", async () => {
    await withNativeOperationService(async (f) => {
      // given
      const released = await finished(f.invoke, "released member")
      await f.invoke((api) =>
        api.operation(async (_manager, _ancestry, _signal, operation) => operation.cancel.cancelTask(released)),
      )
      // when
      await f.invoke((api) =>
        api.operation(async (_manager, _ancestry, _signal, operation) => {
          await operation.destruction.destroyResidentTask(released, "cancel")
          return null
        }),
      )
      const read = await f.invoke((api) =>
        api.operation(async (_manager, _ancestry, _signal, operation) => operation.output.get(released)),
      )
      // then
      expect(f.calls).toContain("remove")
      expect(read).toMatchObject({ task_id: released, status: "completed" })
    })
  })

  test("#when the stored row changes identity after the release #then the read is refused", async () => {
    await withNativeOperationService(async (f) => {
      // given
      const released = await finished(f.invoke, "released child")
      await f.invoke((api) =>
        api.operation(async (_manager, _ancestry, _signal, operation) => operation.cancel.cancelTask(released)),
      )
      const file = join(f.dir, "parent", "tasks", `${released}.json`)
      const row = JSON.parse(readFileSync(file, "utf8"))
      writeFileSync(
        file,
        JSON.stringify({
          ...row,
          residency_claim: "foreign-claim",
          owned_session: { ...row.owned_session, residencyClaim: "foreign-claim" },
        }),
      )
      // when
      const read = await f
        .invoke((api) =>
          api.operation(async (_manager, _ancestry, _signal, operation) => operation.output.get(released)),
        )
        .then(
          () => "read",
          (error: unknown) => String(error),
        )
      // then
      expect(read).toContain("Accepted Native custody unavailable")
    })
  })

  test("#when the plugin reloads (a new runtime over the same state dir) #then the released read still succeeds", async () => {
    await withNativeOperationService(async (f) => {
      // given
      const released = await finished(f.invoke, "released before reload")
      await f.invoke((api) =>
        api.operation(async (_manager, _ancestry, _signal, operation) => operation.cancel.cancelTask(released)),
      )
      await f.reopen()
      // when
      const read = await f.invoke((api) =>
        api.operation(async (_manager, _ancestry, _signal, operation) => operation.output.get(released)),
      )
      // then
      expect(read).toMatchObject({
        task_id: released,
        status: "completed",
        residency_state: "persisted_only",
        final_response: "result:released before reload",
      })
    })
  })

  test("#when the stored row changes identity across a reload #then the read is still refused", async () => {
    await withNativeOperationService(async (f) => {
      // given
      const released = await finished(f.invoke, "released then changed")
      await f.invoke((api) =>
        api.operation(async (_manager, _ancestry, _signal, operation) => operation.cancel.cancelTask(released)),
      )
      await f.reopen()
      const file = join(f.dir, "parent", "tasks", `${released}.json`)
      const row = JSON.parse(readFileSync(file, "utf8"))
      writeFileSync(
        file,
        JSON.stringify({
          ...row,
          residency_claim: "foreign-claim",
          owned_session: { ...row.owned_session, residencyClaim: "foreign-claim" },
        }),
      )
      // when
      const read = await f
        .invoke((api) =>
          api.operation(async (_manager, _ancestry, _signal, operation) => operation.output.get(released)),
        )
        .then(
          () => "read",
          (error: unknown) => String(error),
        )
      // then
      expect(read).not.toBe("read")
    })
  })
})
