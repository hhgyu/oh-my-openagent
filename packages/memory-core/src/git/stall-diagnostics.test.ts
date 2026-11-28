import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { createNodeGitExec } from "./exec"
import { armGitStallRecord, GIT_STALL_MIN_BUDGET_MS } from "./stall-diagnostics"
import { GIT_TIMEOUT_DIAGNOSTICS_ENV } from "./timeout-diagnostics"
import { volumeSnapshotEvidencePath } from "./volume-snapshot-diagnostics"
import { probeUntil } from "../locks/process-liveness.test-support"

const roots: string[] = []
const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill("SIGKILL")
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("a git still running at half its budget (stall diagnostics)", () => {
  test("#given diagnostics mode and a git that keeps running #when half its budget passes #then a stall record with its pid, argv and process table is written before the budget and its volume evidence is requested", async () => {
    // #given
    const diagnostics = join(await scratch("git-stall-record-"), "diagnostics")
    const git = standIn("setInterval(() => {}, 1000)")
    const published: string[] = []
    const recorded = Promise.withResolvers<string | undefined>()
    const startedAt = Date.now()

    // #when
    armGitStallRecord(git, { [GIT_TIMEOUT_DIAGNOSTICS_ENV]: diagnostics }, ["add", "-A"], "repo-dir", 10_000, {
      snapshot: async (pid) => `table naming ${pid}`,
      publishVolume: async (path) => {
        published.push(path)
      },
      onRecorded: recorded.resolve,
    })
    const recordPath = await recorded.promise

    // #then
    const elapsedMs = Date.now() - startedAt
    expect(elapsedMs).toBeGreaterThanOrEqual(5_000)
    expect(elapsedMs).toBeLessThan(10_000)
    expect(recordPath).toMatch(new RegExp(`git-stall-${git.pid}-\\d+\\.json$`))
    expect(await readdir(diagnostics)).toEqual([basename(recordPath ?? "")])
    const record = JSON.parse(await readFile(recordPath ?? "", "utf8"))
    expect(record).toMatchObject({ pid: git.pid, cwd: "repo-dir", timeoutMs: 10_000, argv: ["add", "-A"] })
    expect(record.processes).toBe(`table naming ${git.pid}`)
    expect(record.runningForMs).toBeGreaterThanOrEqual(5_000)
    expect(published).toEqual([recordPath ?? ""])
  }, 30_000)

  test("#given diagnostics mode #when the git exits before half its budget #then no stall record is written", async () => {
    // #given
    const diagnostics = join(await scratch("git-stall-exited-"), "diagnostics")
    const git = standIn("setTimeout(() => {}, 200)")
    let calls = 0

    // #when
    armGitStallRecord(git, { [GIT_TIMEOUT_DIAGNOSTICS_ENV]: diagnostics }, ["status"], "repo-dir", 10_000, {
      snapshot: async () => {
        calls += 1
        return ""
      },
    })
    await sleep(5_500)

    // #then
    expect(git.exitCode).toBe(0)
    expect(calls).toBe(0)
    expect(existsSync(diagnostics)).toBe(false)
  }, 30_000)

  test("#given a budget below the stall minimum #when the git outlives half of it #then no stall record is written", async () => {
    // #given
    const diagnostics = join(await scratch("git-stall-short-"), "diagnostics")
    const git = standIn("setInterval(() => {}, 1000)")
    const budgetMs = GIT_STALL_MIN_BUDGET_MS / 5
    let calls = 0

    // #when
    armGitStallRecord(git, { [GIT_TIMEOUT_DIAGNOSTICS_ENV]: diagnostics }, ["add"], "repo-dir", budgetMs, {
      snapshot: async () => {
        calls += 1
        return ""
      },
    })
    await sleep(budgetMs)

    // #then
    expect(calls).toBe(0)
    expect(existsSync(diagnostics)).toBe(false)
  }, 30_000)

  test("#given diagnostics mode is off #when a git outlives half its budget #then nothing is recorded", async () => {
    // #given
    const git = standIn("setInterval(() => {}, 1000)")
    let calls = 0

    // #when
    armGitStallRecord(git, {}, ["add"], "repo-dir", 10_000, {
      snapshot: async () => {
        calls += 1
        return ""
      },
    })
    await sleep(5_500)

    // #then
    expect(calls).toBe(0)
  }, 30_000)

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
    await writeFile(hook, "#!/bin/sh\nsleep 12\n", "utf8")
    await chmod(hook, 0o755)

    // #when
    const result = await exec.run(
      ["-c", "user.name=stall", "-c", "user.email=stall@omo.local", "commit", "-q", "--allow-empty", "-m", "slow"],
      { cwd: repo, timeoutMs: 20_000, env },
    )

    // #then
    expect(result.code).toBe(0)
    const records = (await readdir(diagnostics)).filter((name) => /^git-stall-\d+-\d+\.json$/.test(name))
    expect(records).toHaveLength(1)
    const recordPath = join(diagnostics, records[0] ?? "")
    const record = JSON.parse(await readFile(recordPath, "utf8"))
    expect(record.argv).toContain("commit")
    expect(record.timeoutMs).toBe(20_000)
    expect(record.processes).toContain(String(record.pid))
    // The volume evidence is published beside the record on Windows only; wait for it so cleanup does not race it.
    if (process.platform === "win32")
      expect(await probeUntil(() => existsSync(volumeSnapshotEvidencePath(recordPath)), 20_000)).toBe(true)
  }, 60_000)
})
