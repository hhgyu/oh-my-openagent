import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runBoundedSenpi } from "./bounded-senpi-run.mjs"
import { stopSenpiRunTree } from "./senpi-run-spawn.mjs"

const dirs = []
const strays = []

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readGrandchildPid(cwd) {
  const text = readFileSync(join(cwd, "grandchild.pid"), "utf8")
  const pid = Number(text)
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`grandchild.pid does not hold a process id: ${JSON.stringify(text)}`)
  return pid
}

const PARENT = `
const { spawn } = require("node:child_process")
const fs = require("node:fs")
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] })
fs.writeFileSync("grandchild.pid.tmp", String(grandchild.pid))
fs.renameSync("grandchild.pid.tmp", "grandchild.pid")
setInterval(() => {}, 1000)
`

describe("bounded senpi launch", () => {
  test("#given a launch whose child started a grandchild that holds its stdout #when the budget runs out #then the whole tree is ended and the run reports the timeout", async () => {
    // given
    const cwd = mkdtempSync(join(tmpdir(), "bounded-senpi-run-"))
    dirs.push(cwd)

    // when
    const run = await runBoundedSenpi(process.execPath, ["-e", PARENT], { cwd, env: process.env, timeoutMs: 3_000 })

    // then
    const grandchild = readGrandchildPid(cwd)
    strays.push(grandchild)
    expect(run.timedOut).toBe(true)
    expect(run.status).toBeNull()
    expect(run.treeStop.ok).toBe(true)
    expect(alive(grandchild)).toBe(false)
  })

  test("#given a launch past its budget whose tree stop fails #when the stop rejects #then the launch resolves at once and reports the failure", async () => {
    // given
    const cwd = mkdtempSync(join(tmpdir(), "bounded-senpi-run-"))
    dirs.push(cwd)
    const stopped = []
    const stopTreeOf = async (pid) => {
      stopped.push(pid)
      throw new Error(`taskkill exited with code 1 for pid ${pid}`)
    }

    // when
    const run = await runBoundedSenpi(process.execPath, ["-e", PARENT], {
      cwd,
      env: process.env,
      timeoutMs: 3_000,
      stopTreeOf,
    })

    // then
    strays.push(readGrandchildPid(cwd))
    // The fake stop left the real tree running; end it for real before the temp dir is removed.
    await stopSenpiRunTree(stopped[0])
    expect(run.timedOut).toBe(true)
    expect(run.status).toBeNull()
    expect(run.treeStop).toEqual({
      ok: false,
      detail: `tree stop FAILED, descendants may still be alive: taskkill exited with code 1 for pid ${stopped[0]}`,
    })
  })

  test("#given a launch that finishes within its budget #when it exits #then its status and output are returned untouched", async () => {
    // given
    const cwd = mkdtempSync(join(tmpdir(), "bounded-senpi-run-"))
    dirs.push(cwd)

    // when
    const run = await runBoundedSenpi(process.execPath, ["-e", "process.stdout.write('done'); process.exit(3)"], {
      cwd,
      env: process.env,
      timeoutMs: 60_000,
    })

    // then
    expect(run).toMatchObject({ status: 3, stdout: "done", timedOut: false })
  })
})
