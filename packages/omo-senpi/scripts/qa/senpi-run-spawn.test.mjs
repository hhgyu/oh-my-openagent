import { describe, expect, test } from "bun:test"

import { resumeRunTreeKill } from "./resume-e2e-runtime.mjs"
import { senpiRunSpawnOptions, senpiTreeKill } from "./senpi-run-spawn.mjs"

describe("QA driver senpi process trees", () => {
  describe("#given the win32 platform", () => {
    test("#when a senpi run is spawned #then it stays attached and hidden instead of detaching", () => {
      expect(senpiRunSpawnOptions("win32")).toEqual({ detached: false, windowsHide: true })
    })

    test("#when a run's tree is killed #then taskkill takes the whole tree", () => {
      expect(senpiTreeKill(42, "win32")).toEqual({ command: "taskkill", args: ["/T", "/F", "/PID", "42"] })
      expect(resumeRunTreeKill(42, "win32")).toEqual({ command: "taskkill", args: ["/T", "/F", "/PID", "42"] })
    })
  })

  describe("#given a POSIX platform", () => {
    test("#when a senpi run is spawned #then it leads its own process group for the group kill", () => {
      expect(senpiRunSpawnOptions("linux")).toEqual({ detached: true, windowsHide: true })
      expect(resumeRunTreeKill(42, "linux")).toBeUndefined()
      expect(senpiTreeKill(42, "darwin")).toEqual({ command: "pkill", args: ["-9", "-P", "42"] })
    })
  })
})
