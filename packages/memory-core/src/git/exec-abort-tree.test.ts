import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, rmSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GitAbortedError } from "./errors"
import { createNodeGitExec } from "./exec"

// On Windows `git` resolves to the Git for Windows launcher, which starts the real git as its own child.
// Stopping only the launcher left the real git and everything it started running in the repository after
// the call had settled, so a caller removing the repository on abort got EBUSY.
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })),
  )
})

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "git-exec-abort-tree-"))
  tempDirs.push(dir)
  const init = await createNodeGitExec().run(["init", "-q"], { cwd: dir, timeoutMs: 30_000 })
  expect(init.code).toBe(0)
  return dir
}

async function waitFor(condition: () => boolean, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe("git child abort", () => {
  test("#given a git whose own child still works in the repository #when the call is aborted #then it settles only after nothing holds the repository", async () => {
    // given
    const dir = await initRepo()
    const controller = new AbortController()
    const run = createNodeGitExec().run(
      ["-c", "alias.omo-hold=!echo started > started.txt; exec sleep 60", "omo-hold"],
      {
        cwd: dir,
        timeoutMs: 120_000,
        signal: controller.signal,
      },
    )
    const settled = run.then(
      () => undefined,
      (error: unknown) => error,
    )
    await waitFor(() => existsSync(join(dir, "started.txt")), 30_000)

    // when
    controller.abort()
    const error = await settled

    // then
    expect(error).toBeInstanceOf(GitAbortedError)
    expect(() => rmSync(dir, { recursive: true, force: true })).not.toThrow()
  })
})
