import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerGoal } from "./component"
import { goalStoreFile, goalStoreRef } from "./store-ref"
import { fakeGoalHost } from "./test-support"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "v2-goal-"))
  roots.push(root)
  return root
}

const textOf = (result: { content: readonly { type: string; text?: string }[] }) =>
  result.content.map((part) => part.text ?? "").join("\n")

describe("V2 goal tools", () => {
  test("#given the engine goal tools #when they register #then create_goal, update_goal and get_goal exist with the engine's schemas", async () => {
    // given
    const fake = fakeGoalHost(project())

    // when
    const dispose = await registerGoal(fake.host)

    // then
    expect(fake.tools.map((tool) => tool.name).sort()).toEqual(["create_goal", "get_goal", "update_goal"])
    const create = fake.tools.find((tool) => tool.name === "create_goal")
    expect(create?.input).toMatchObject({ type: "object", required: ["objective"] })
    await dispose()
  })

  test("#given a goal created in one session #when each session reads its goal #then only the calling session sees it, and the file is the engine's store", async () => {
    // given
    const directory = project()
    const fake = fakeGoalHost(directory)
    const dispose = await registerGoal(fake.host)

    // when
    await fake.call("create_goal", { objective: "ship the port" }, "ses_a")
    const mine = textOf(await fake.call("get_goal", {}, "ses_a"))
    const theirs = await fake.call("get_goal", {}, "ses_b").then(textOf, (error: Error) => error.message)

    // then
    expect(mine).toContain("ship the port")
    expect(theirs).not.toContain("ship the port")
    const file = goalStoreFile(goalStoreRef(directory, "ses_a"))
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      version: 1,
      goal: { threadId: "ses_a", objective: "ship the port", status: "active" },
    })
    expect(existsSync(goalStoreFile(goalStoreRef(directory, "ses_b")))).toBe(false)
    await dispose()
  })

  test("#given open todowrite tasks #when update_goal completes #then the engine's todo gate refuses until the tasks close", async () => {
    // given
    const directory = project()
    const fake = fakeGoalHost(directory)
    const dispose = await registerGoal(fake.host)
    await fake.call("create_goal", { objective: "finish" }, "ses_a")
    await fake.todowrite("ses_a", [{ content: "write the tests", status: "in_progress" }])

    // when
    const refused = await fake.call("update_goal", { status: "complete" }, "ses_a").then(
      () => "accepted",
      (error: Error) => error.message,
    )
    await fake.todowrite("ses_a", [{ content: "write the tests", status: "completed" }])
    await fake.call("update_goal", { status: "complete" }, "ses_a")

    // then
    expect(refused).toContain('cannot mark the goal complete: 1 open todo task(s) remain: "write the tests"')
    const stored = JSON.parse(readFileSync(goalStoreFile(goalStoreRef(directory, "ses_a")), "utf8"))
    expect(stored.goal.status).toBe("complete")
    await dispose()
  })

  test("#given steps of the session's own turns #when get_goal reads the goal #then their tokens are accounted to it and another session's are not", async () => {
    // given
    const directory = project()
    const fake = fakeGoalHost(directory)
    const dispose = await registerGoal(fake.host)
    await fake.call("create_goal", { objective: "count tokens" }, "ses_a")

    // when
    await fake.step("ses_a", { input: 100, output: 20, reasoning: 5 })
    await fake.step("ses_b", { input: 9000, output: 9000, reasoning: 0 })
    await fake.call("get_goal", {}, "ses_a")

    // then
    const stored = JSON.parse(readFileSync(goalStoreFile(goalStoreRef(directory, "ses_a")), "utf8"))
    expect(stored.goal.tokensUsed).toBe(125)
    await dispose()
  })
})
