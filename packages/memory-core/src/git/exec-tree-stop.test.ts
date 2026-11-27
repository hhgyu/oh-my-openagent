import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GitAbortedError } from "./errors"
import { createNodeGitExec, type GitExecResult } from "./exec"
import type { GitTreeStopper } from "./stop-git-tree"

// The settlement contract of a stopped git with a process-tree stopper (taskkill on Windows), driven with an
// injected stopper so it runs on every host: nothing settles while the stop is still in flight, and an
// abort that arrives after git exited never reaches the stopper.
const tempDirs: string[] = []
const processes: ChildProcess[] = []
const strayPids: number[] = []

afterEach(async () => {
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
  for (const child of processes.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "git-exec-tree-stop-"))
  tempDirs.push(dir)
  const init = await createNodeGitExec().run(["init", "-q"], { cwd: dir, timeoutMs: 30_000 })
  expect(init.code).toBe(0)
  return dir
}

async function waitFor(condition: () => boolean, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met")
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("git tree stop settlement", () => {
  test("#given git closes its stdio while the tree stop is still running and a descendant lives #when the stop finishes #then the call settles only after it", async () => {
    // given
    const dir = await initRepo()
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: dir, stdio: "ignore" })
    processes.push(descendant)
    let settled = false
    let settledBeforeStopFinished: boolean | undefined
    let descendantAliveAtSettle: boolean | undefined
    const treeStopper: GitTreeStopper = async (child) => {
      const closed = once(child, "close")
      writeFileSync(join(dir, "release"), "")
      await closed
      await new Promise((resolve) => setImmediate(resolve))
      settledBeforeStopFinished = settled
      const descendantExit = once(descendant, "exit")
      descendant.kill("SIGKILL")
      await descendantExit
    }
    const controller = new AbortController()
    const run = createNodeGitExec({ treeStopper })
      .run(["-c", "alias.omo-wait=!echo > started; until [ -f release ]; do sleep 0.05; done", "omo-wait"], {
        cwd: dir,
        timeoutMs: 60_000,
        signal: controller.signal,
      })
      .finally(() => {
        settled = true
        descendantAliveAtSettle = descendant.exitCode === null && descendant.signalCode === null
      })
    const outcome = run.then(
      () => undefined,
      (error: unknown) => error,
    )
    await waitFor(() => existsSync(join(dir, "started")), 30_000)

    // when
    controller.abort()
    const error = await outcome

    // then
    expect(error).toBeInstanceOf(GitAbortedError)
    expect(settledBeforeStopFinished).toBe(false)
    expect(descendantAliveAtSettle).toBe(false)
  })

  test("#given git exited normally and a hook child still holds its stdout #when the caller aborts during the drain #then the exited pid is never stopped and the call settles as aborted only once the stdio closes", async () => {
    // given
    const dir = await initRepo()
    writeFileSync(
      join(dir, "hold.js"),
      'require("fs").writeFileSync("hold.pid", String(process.pid)); setInterval(() => {}, 1000)\n',
    )
    let stopperCalls = 0
    const treeStopper: GitTreeStopper = async () => {
      stopperCalls++
    }
    let launcher: ChildProcess | undefined
    const controller = new AbortController()
    const run: Promise<GitExecResult> = createNodeGitExec({
      treeStopper,
      onSpawn: (child) => {
        launcher = child
      },
    }).run(["-c", 'alias.omo-drain=!"$OMO_TEST_NODE" hold.js & until [ -f go ]; do sleep 0.05; done', "omo-drain"], {
      cwd: dir,
      timeoutMs: 60_000,
      exitDrainMs: 120_000,
      signal: controller.signal,
      env: { ...process.env, OMO_TEST_NODE: process.execPath.replaceAll("\\", "/") },
    })
    await waitFor(() => existsSync(join(dir, "hold.pid")), 30_000)
    const holder = Number(readFileSync(join(dir, "hold.pid"), "utf8"))
    strayPids.push(holder)
    if (launcher === undefined) throw new Error("git was not spawned")
    // The exec's own exit listener was attached before onSpawn, so it has run once this resolves.
    const launcherExit = once(launcher, "exit")
    writeFileSync(join(dir, "go"), "")
    await launcherExit

    // when
    let settled = false
    const outcome = run.then(
      () => undefined,
      (error: unknown) => error,
    )
    void outcome.finally(() => {
      settled = true
    })
    controller.abort()
    // An abort that settled the call on the spot would have run its handlers by now.
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    const settledWhileStdioHeld = settled
    const holderExit = waitFor(() => !alive(holder), 30_000)
    process.kill(holder, "SIGKILL")
    await holderExit
    const error = await outcome

    // then
    expect(stopperCalls).toBe(0)
    expect(settledWhileStdioHeld).toBe(false)
    expect(error).toBeInstanceOf(GitAbortedError)
  })
})
