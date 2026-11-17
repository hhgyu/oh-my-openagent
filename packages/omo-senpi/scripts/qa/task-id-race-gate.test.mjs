import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { waitForGoFile } from "./task-id-race-gate.mjs"

const GATE_ENV = ["SENPI_QA_READY_FILE", "SENPI_QA_GO_FILE", "SENPI_QA_GATE_TIMEOUT_MS"]
const savedEnv = Object.fromEntries(GATE_ENV.map((name) => [name, process.env[name]]))
const roots = []

afterEach(() => {
  for (const name of GATE_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function untilExists(path) {
  while (!existsSync(path)) await new Promise((resolve) => setTimeout(resolve, 10))
}

describe("task-id race mock provider gate", () => {
  test("#given native platform gate paths #when GO lands after READY #then the gate opens instead of timing out", async () => {
    // given - the platform contract: on win32 the driver hands over backslash paths
    const root = mkdtempSync(join(tmpdir(), "omo-race-gate-"))
    roots.push(root)
    const readyFile = join(root, "gates", "ready")
    const goFile = join(root, "gates", "go")
    process.env.SENPI_QA_READY_FILE = readyFile
    process.env.SENPI_QA_GO_FILE = goFile
    process.env.SENPI_QA_GATE_TIMEOUT_MS = "2000"

    // when
    const gate = waitForGoFile()
    await untilExists(readyFile)
    writeFileSync(goFile, "go\n", { flag: "wx" })

    // then
    await expect(gate).resolves.toBeUndefined()
  })
})
