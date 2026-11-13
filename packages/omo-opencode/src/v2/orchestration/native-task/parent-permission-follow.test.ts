import { describe, expect, spyOn, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { withOwnedRuntimeUnit } from "./runtime.test"

type Effect = "allow" | "deny" | "ask"
const rules = (effect: Effect) => [{ action: "shell", resource: "*", effect }]
type UnitState = Parameters<Parameters<typeof withOwnedRuntimeUnit>[0]>[1]
type UnitRuntime = Parameters<Parameters<typeof withOwnedRuntimeUnit>[0]>[0]

async function eventually(check: () => boolean, label: string) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

function changeParentMode(state: UnitState, effect: Effect) {
  state.changeSession("parent", { permissions: rules(effect) })
  state.emit("session.permissions", "parent", { permissions: rules(effect) })
}

function childRules(state: UnitState, child: string) {
  return (state.session(child) as { permissions?: unknown }).permissions
}

function taskEvents(state: UnitState, taskId: string): { type: string; payload: { message?: string } }[] {
  const path = join(state.stateDir, "logs", `${taskId}.jsonl`)
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

async function runningChild(runtime: UnitRuntime) {
  const start = await runtime.start({ category: "qa", prompt: "block-until-interrupt follow probe" })
  if (start.kind !== "started") throw new Error(JSON.stringify(start))
  const child = runtime.get(start.task_id)?.child_session_id
  if (!child) throw new Error("Owned child was not issued")
  return { id: start.task_id, child }
}

function recordChildWrites(state: UnitState, child: string, fail: { once: boolean } = { once: false }) {
  const writes: unknown[] = []
  state.onUpdate((input) => {
    if (input.sessionID !== child || input.permissions === undefined) return
    if (fail.once) {
      fail.once = false
      throw new Error("Controlled host refused the child rules write")
    }
    writes.push(structuredClone(input.permissions))
  })
  return writes
}

describe("owned children follow their parent's approval mode", () => {
  test("#given a running child created on its parent's rules #when the parent's rules change in a burst #then the child lands on the latest rules in order", async () => {
    await withOwnedRuntimeUnit(async (runtime, state) => {
      // given
      state.changeSession("parent", { permissions: rules("deny") })
      const { id, child } = await runningChild(runtime)
      const writes = recordChildWrites(state, child)
      await state.drainEvents()
      expect(childRules(state, child)).toEqual(rules("deny"))
      expect(writes).toEqual([])

      // when
      for (const effect of ["ask", "deny", "allow"] as const) changeParentMode(state, effect)
      await eventually(() => JSON.stringify(childRules(state, child)) === JSON.stringify(rules("allow")), "allow")

      // then
      const order = ["ask", "deny", "allow"].map((effect) => JSON.stringify(rules(effect as Effect)))
      const indexes = writes.map((write) => order.indexOf(JSON.stringify(write)))
      expect(indexes.every((index) => index >= 0)).toBe(true)
      expect(indexes).toEqual([...indexes].sort((a, b) => a - b))
      expect(writes.at(-1)).toEqual(rules("allow"))
      await runtime.end(id)
    })
  })

  test("#given a follow push the host refuses #when the parent changes again #then the failure is reported on the task and the next change lands", async () => {
    const warnings = spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      await withOwnedRuntimeUnit(async (runtime, state) => {
        // given
        const { id, child } = await runningChild(runtime)
        const fail = { once: true }
        const writes = recordChildWrites(state, child, fail)
        await state.drainEvents()

        // when
        changeParentMode(state, "allow")
        await eventually(
          () => taskEvents(state, id).some((event) => event.type === "task_parent_mode_follow_failed"),
          "failure",
        )
        changeParentMode(state, "ask")
        await eventually(() => JSON.stringify(childRules(state, child)) === JSON.stringify(rules("ask")), "ask")

        // then
        const failure = taskEvents(state, id).find((event) => event.type === "task_parent_mode_follow_failed")
        expect(failure?.payload.message).toContain(`task ${id} may not have followed its parent's approval mode`)
        expect(warnings.mock.calls.some((call) => String(call[0]).includes(`task ${id} may not have followed`))).toBe(
          true,
        )
        expect(taskEvents(state, id).some((event) => event.type === "task_parent_mode_followed")).toBe(true)
        expect(writes).toEqual([rules("ask")])
        await runtime.end(id)
      })
    } finally {
      warnings.mockRestore()
    }
  })

  test.each(["end", "detach"] as const)(
    "#given a child the parent let go of by %s #when the parent's rules change #then nothing is written to it",
    async (control) => {
      await withOwnedRuntimeUnit(async (runtime, state) => {
        // given
        const { id, child } = await runningChild(runtime)
        const writes = recordChildWrites(state, child)
        await state.drainEvents()
        await runtime[control](id)

        // when
        changeParentMode(state, "allow")
        await state.drainEvents()
        await Bun.sleep(20)

        // then
        expect(writes).toEqual([])
        if (control === "detach") await runtime.end(id)
      })
    },
  )

  test("#given a parent change that raced the child's creation #when following starts #then the child is aligned at once", async () => {
    await withOwnedRuntimeUnit(async (runtime, state) => {
      // given
      state.changeSession("parent", { permissions: rules("deny") })
      state.holdCreate()
      const starting = runtime.start({ category: "qa", prompt: "block-until-interrupt raced probe" })
      await state.createEntered

      // when
      state.changeSession("parent", { permissions: rules("allow") })
      state.releaseCreate()
      const start = await starting
      if (start.kind !== "started") throw new Error(JSON.stringify(start))
      const child = runtime.get(start.task_id)?.child_session_id ?? ""

      // then
      await eventually(() => JSON.stringify(childRules(state, child)) === JSON.stringify(rules("allow")), "aligned")
      await runtime.end(start.task_id)
    })
  })
})
