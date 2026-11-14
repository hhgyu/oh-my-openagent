import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { loadGoalEngine } from "./engine"
import { goalStoreDir, goalStoreFile, goalStoreRef } from "./store-ref"

describe("V2 goal store location", () => {
  test("#given a project #when a session's store is located #then it is the project's .omo/goal, and never ~/.omo when the project is the home directory", () => {
    // given / when
    const inProject = goalStoreDir("/home/user/project", "/home/user")
    const atHome = goalStoreDir("/home/user", "/home/user")

    // then
    expect(inProject).toBe(join("/home/user/project", ".omo", "goal"))
    expect(atHome.replaceAll("\\", "/")).not.toContain("/home/user/.omo")
  })

  test("#given the installed senpi engine #when the goal file path is computed #then it is the engine's own goalFilePath", async () => {
    // given
    const ref = goalStoreRef("/home/user/project", "ses/with space", "/home/user")

    // when
    const engine = await loadGoalEngine()

    // then
    expect(goalStoreFile(ref)).toBe(engine.store.goalFilePath(ref))
  })
})
