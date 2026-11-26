import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runBoundedSenpi } from "./bounded-senpi-run.mjs"

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

const PARENT = `
const { spawn } = require("node:child_process")
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: ["ignore", "inherit", "inherit"] })
require("node:fs").writeFileSync("grandchild.pid", String(grandchild.pid))
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
    const grandchild = Number(readFileSync(join(cwd, "grandchild.pid"), "utf8"))
    strays.push(grandchild)
    expect(run.timedOut).toBe(true)
    expect(run.status).toBeNull()
    expect(run.treeStop).not.toContain("FAILED")
    expect(alive(grandchild)).toBe(false)
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
