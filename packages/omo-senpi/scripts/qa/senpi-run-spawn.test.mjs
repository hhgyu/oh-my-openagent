import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { resumeRunTreeKill } from "./resume-e2e-runtime.mjs"
import { senpiRunSpawnOptions, senpiTreeKill } from "./senpi-run-spawn.mjs"

const qaDir = dirname(fileURLToPath(import.meta.url))

// Not a senpi run: `--keep` hands this synthetic provider to the lead, so it must outlive the driver.
const DETACH_ALLOWED = new Map([["reflection-recap-runtime.mjs", "retained synthetic provider"]])

function driverSources() {
  return readdirSync(qaDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(mjs|js|ts)$/.test(entry.name) && !/\.test\.(mjs|js|ts)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.split(/[\\/]/).includes("node_modules") && relative(qaDir, path) !== "senpi-run-spawn.mjs")
    .map((path) => ({ file: relative(qaDir, path).replaceAll("\\", "/"), source: readFileSync(path, "utf8") }))
}

function offendingLines(source, pattern) {
  return source.split(/\r?\n/).flatMap((line, index) => (pattern.test(line) ? [index + 1] : []))
}

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

  describe("#given every QA driver under scripts/qa", () => {
    test("#when it spawns a run that owns a process tree #then the detach decision comes from senpiRunSpawnOptions, so no run detaches on win32", () => {
      const offenders = driverSources().flatMap(({ file, source }) =>
        DETACH_ALLOWED.has(file) ? [] : offendingLines(source, /\bdetached\s*:/).map((line) => `${file}:${line}`),
      )
      expect(offenders).toEqual([])
    })

    test("#when it kills a run's tree #then it goes through killSenpiRunTree, so win32 takes the tree with taskkill /T /F", () => {
      const offenders = driverSources().flatMap(({ file, source }) =>
        offendingLines(source, /process\.kill\(\s*-/).map((line) => `${file}:${line}`),
      )
      expect(offenders).toEqual([])
    })
  })

  describe("#given a POSIX platform", () => {
    test("#when a senpi run is spawned #then it leads its own process group for the group kill", () => {
      expect(senpiRunSpawnOptions("linux")).toEqual({ detached: true, windowsHide: true })
      expect(senpiRunSpawnOptions("linux", false)).toEqual({ detached: false, windowsHide: true })
      expect(senpiRunSpawnOptions("win32", true)).toEqual({ detached: false, windowsHide: true })
      expect(resumeRunTreeKill(42, "linux")).toBeUndefined()
      expect(senpiTreeKill(42, "darwin")).toEqual({ command: "pkill", args: ["-9", "-P", "42"] })
    })
  })
})
