import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { createNodeGitExec } from "./exec"
import { armGitStallRecord, GIT_STALL_MIN_BUDGET_MS, settleGitStallRecords } from "./stall-diagnostics"
import { GIT_TIMEOUT_DIAGNOSTICS_ENV } from "./timeout-diagnostics"
import { volumeSnapshotEvidencePath } from "./volume-snapshot-diagnostics"

const roots: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL")
  await settleGitStallRecords()
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })),
  )
})

async function scratch(prefix: string): Promise<string> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(root)
  return root
}

function standIn(script: string): ChildProcess {
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore", windowsHide: true })
  children.push(child)
  return child
}

/** A scheduler the test fires by hand, so no assertion depends on how fast the host runs. */
function manualScheduler() {
  const scheduled: { callback: () => void; delayMs: number; cancelled: boolean }[] = []
  return {
    scheduled,
    schedule: (callback: () => void, delayMs: number) => {
      const entry = { callback, delayMs, cancelled: false }
      scheduled.push(entry)
      return () => {
        entry.cancelled = true
      }
    },
  }
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => (child.exitCode === null ? child.once("exit", () => resolve()) : resolve()))
}

describe("a git still running at half its budget (stall diagnostics)", () => {
  test("#given diagnostics mode and a git that keeps running #when half its budget passes #then a stall record with its pid, argv and a slowly collected process table is written, stamped before the budget, and its volume evidence is requested", async () => {
    // #given
    const diagnostics = join(await scratch("git-stall-record-"), "diagnostics")
    const git = standIn("setInterval(() => {}, 1000)")
    const timer = manualScheduler()
    let clock = 1_000_000
    const snapshotStarted = Promise.withResolvers<void>()
    const finishSnapshot = Promise.withResolvers<void>()
    const published: string[] = []
    const recorded = Promise.withResolvers<string | undefined>()
    armGitStallRecord(git, { [GIT_TIMEOUT_DIAGNOSTICS_ENV]: diagnostics }, ["add", "-A"], "repo-dir", 10_000, {
      schedule: timer.schedule,
      now: () => clock,
      snapshot: async (pid) => {
        snapshotStarted.resolve()
        await finishSnapshot.promise
        return `table naming ${pid}`
      },
      publishVolume: async (path) => {
        published.push(path)
      },
      onRecorded: recorded.resolve,
    })

    // #when: half the budget passes, and the snapshot is still being collected
    expect(timer.scheduled.map((entry) => entry.delayMs)).toEqual([5_000])
    clock += 5_000
    timer.scheduled[0]?.callback()
    await snapshotStarted.promise
    const beforeCollected = existsSync(diagnostics) ? await readdir(diagnostics) : []
    finishSnapshot.resolve()
    const recordPath = await recorded.promise

    // #then
    expect(beforeCollected).toEqual([])
    expect(recordPath).toMatch(new RegExp(`git-stall-${git.pid}-\\d+\\.json$`))
    expect(await readdir(diagnostics)).toEqual([basename(recordPath ?? "")])
    const record = JSON.parse(await readFile(recordPath ?? "", "utf8"))
    expect(record).toMatchObject({ pid: git.pid, cwd: "repo-dir", timeoutMs: 10_000, argv: ["add", "-A"] })
    expect(record.processes).toBe(`table naming ${git.pid}`)
    expect(record.runningForMs).toBe(5_000)
    expect(record.runningForMs).toBeLessThan(record.timeoutMs)
    expect(published).toEqual([recordPath ?? ""])
  })

  test("#given a diagnostics directory that cannot be created #when a stall is recorded #then the record reports no path and nothing is written", async () => {
    // #given
    const root = await scratch("git-stall-unwritable-")
    const diagnostics = join(root, "diagnostics")
    await writeFile(diagnostics, "a file where the directory should be", "utf8")
    const git = standIn("setInterval(() => {}, 1000)")
    const timer = manualScheduler()
    const recorded = Promise.withResolvers<string | undefined>()
    let published = 0
    armGitStallRecord(git, { [GIT_TIMEOUT_DIAGNOSTICS_ENV]: diagnostics }, ["add"], "repo-dir", 10_000, {
      schedule: timer.schedule,
      snapshot: async () => "table",
      publishVolume: async () => {
        published += 1
      },
      onRecorded: recorded.resolve,
    })

    // #when
    timer.scheduled[0]?.callback()

    // #then
    expect(await recorded.promise).toBeUndefined()
    expect(await readdir(root)).toEqual(["diagnostics"])
    expect(published).toBe(0)
  })

  test("#given diagnostics mode #when the git exits before half its budget #then the check is cancelled and nothing is recorded", async () => {
    // #given
    const diagnostics = join(await scratch("git-stall-exited-"), "diagnostics")
    const git = standIn("")
    const timer = manualScheduler()
    armGitStallRecord(git, { [GIT_TIMEOUT_DIAGNOSTICS_ENV]: diagnostics }, ["status"], "repo-dir", 10_000, {
      schedule: timer.schedule,
      snapshot: async () => {
        throw new Error("a git that exited must not be snapshotted")
      },
    })

    // #when
    await exited(git)

    // #then
    expect(timer.scheduled).toHaveLength(1)
    expect(timer.scheduled[0]?.cancelled).toBe(true)
    expect(existsSync(diagnostics)).toBe(false)
  })

  test("#given a budget below the stall minimum #when armed #then no check is scheduled", async () => {
    // #given
    const git = standIn("setInterval(() => {}, 1000)")
    const timer = manualScheduler()

    // #when
    armGitStallRecord(
      git,
      { [GIT_TIMEOUT_DIAGNOSTICS_ENV]: "unused" },
      ["add"],
      "repo-dir",
      GIT_STALL_MIN_BUDGET_MS - 1,
      {
        schedule: timer.schedule,
      },
    )

    // #then
    expect(timer.scheduled).toEqual([])
  })

  test("#given diagnostics mode is off #when armed #then no check is scheduled", async () => {
    // #given
    const git = standIn("setInterval(() => {}, 1000)")
    const timer = manualScheduler()

    // #when
    armGitStallRecord(git, {}, ["add"], "repo-dir", 10_000, { schedule: timer.schedule })

    // #then
    expect(timer.scheduled).toEqual([])
  })

  test("#given diagnostics mode and a real commit whose hook outlives half the budget #when the exec runs it #then the stall is recorded while it runs and the commit still succeeds within its budget", async () => {
    // #given
    const root = await scratch("git-stall-exec-")
    const repo = join(root, "repo")
    const diagnostics = join(root, "diagnostics")
    await mkdir(repo, { recursive: true })
    const exec = createNodeGitExec()
    const env = { ...process.env, [GIT_TIMEOUT_DIAGNOSTICS_ENV]: diagnostics }
    expect((await exec.run(["init", "-q"], { cwd: repo, timeoutMs: 30_000, env })).code).toBe(0)
    const hook = join(repo, ".git", "hooks", "pre-commit")
    await writeFile(hook, "#!/bin/sh\nsleep 9\n", "utf8")
    await chmod(hook, 0o755)

    // #when
    const result = await exec.run(
      ["-c", "user.name=stall", "-c", "user.email=stall@omo.local", "commit", "-q", "--allow-empty", "-m", "slow"],
      { cwd: repo, timeoutMs: 14_000, env },
    )

    // #then
    expect(result.code).toBe(0)
    const written = (await settleGitStallRecords()).filter((path) => path !== undefined)
    expect(written).toHaveLength(1)
    const recordPath = written[0] ?? ""
    expect(await readdir(diagnostics)).toContain(basename(recordPath))
    const record = JSON.parse(await readFile(recordPath, "utf8"))
    expect(record.argv).toContain("commit")
    expect(record.timeoutMs).toBe(14_000)
    expect(record.processes).toContain(String(record.pid))
    // The record settles only after its volume evidence is published, which happens on Windows only.
    expect(existsSync(volumeSnapshotEvidencePath(recordPath))).toBe(process.platform === "win32")
  })
})
