import { afterEach, describe, expect, jest, spyOn, test } from "bun:test"
import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { waitForFile, waitForGoFile } from "./task-id-race-gate.mjs"

const GATE_ENV = ["SENPI_QA_READY_FILE", "SENPI_QA_GO_FILE", "SENPI_QA_GATE_TIMEOUT_MS"]
const savedEnv = Object.fromEntries(GATE_ENV.map((name) => [name, process.env[name]]))
const roots = []
const spies = []

afterEach(() => {
  jest.useRealTimers()
  for (const spy of spies.splice(0)) spy.mockRestore()
  for (const name of GATE_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name]
    else process.env[name] = savedEnv[name]
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function untilExists(path) {
  while (!existsSync(path)) await new Promise((resolve) => setTimeout(resolve, 10))
}

function gatePaths() {
  const root = mkdtempSync(join(tmpdir(), "omo-race-gate-"))
  roots.push(root)
  const readyFile = join(root, "gates", "ready")
  const goFile = join(root, "gates", "go")
  process.env.SENPI_QA_READY_FILE = readyFile
  process.env.SENPI_QA_GO_FILE = goFile
  process.env.SENPI_QA_GATE_TIMEOUT_MS = "2000"
  return { readyFile, goFile }
}

describe("task-id race mock provider gate", () => {
  test("#given native platform gate paths #when GO lands after READY #then the gate opens instead of timing out", async () => {
    // given - the platform contract: on win32 the driver hands over backslash paths
    const { readyFile, goFile } = gatePaths()

    // when
    const gate = waitForGoFile()
    await untilExists(readyFile)
    writeFileSync(goFile, "go\n", { flag: "wx" })

    // then
    await expect(gate).resolves.toBeUndefined()
  })

  test("#given fs notifications that never arrive #when GO lands after READY #then the gate still opens", async () => {
    // given - Bun on macOS arms an fs.watch FSEventStream asynchronously on its CF thread, so a GO
    // created right after READY can precede the stream and is never reported; a silent watcher
    // reproduces that ordering on every OS
    const silentWatch = spyOn(fs, "watch").mockImplementation(() => Object.assign(new EventEmitter(), { close() {} }))
    spies.push(silentWatch)
    const { readyFile, goFile } = gatePaths()

    // when
    const gate = waitForGoFile()
    await untilExists(readyFile)
    writeFileSync(goFile, "go\n", { flag: "wx" })

    // then
    await expect(gate).resolves.toBeUndefined()
  })

  test("#given fs notifications that never arrive #when the driver's READY lands after its wait began #then waitForFile resolves", async () => {
    // given
    spies.push(spyOn(fs, "watch").mockImplementation(() => Object.assign(new EventEmitter(), { close() {} })))
    const { readyFile } = gatePaths()
    fs.mkdirSync(dirname(readyFile), { recursive: true })

    // when
    const wait = waitForFile(readyFile, 2000)
    writeFileSync(readyFile, "ready\n", { flag: "wx" })

    // then
    await expect(wait).resolves.toBeUndefined()
  })

  test("#given a file created after the last check #when the deadline fires #then waitForFile resolves", async () => {
    // given - checks land every 20 ms, so with a 1990 ms deadline the last check runs at 1980 ms
    const { readyFile } = gatePaths()
    fs.mkdirSync(dirname(readyFile), { recursive: true })
    jest.useFakeTimers()
    const wait = waitForFile(readyFile, 1990)
    jest.advanceTimersByTime(1985)
    writeFileSync(readyFile, "ready\n", { flag: "wx" })

    // when
    jest.advanceTimersByTime(5)

    // then
    await expect(wait).resolves.toBeUndefined()
  })

  test("#given a file that never appears #when the deadline fires #then waitForFile rejects at the deadline", async () => {
    // given
    const { readyFile } = gatePaths()
    jest.useFakeTimers()
    let settled = false
    const wait = waitForFile(readyFile, 1990).finally(() => {
      settled = true
    })
    jest.advanceTimersByTime(1989)
    await Promise.resolve()
    expect(settled).toBe(false)

    // when
    jest.advanceTimersByTime(1)

    // then
    await expect(wait).rejects.toThrow(`timed out after 1990ms waiting for ${readyFile}`)
  })
})
