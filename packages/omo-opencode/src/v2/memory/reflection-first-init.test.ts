import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createLockRecord, GitMemoryRepo, initMemoryWithSeeds, memoryWriterLockPath, withLock } from "@oh-my-opencode/memory-core"
import type { BoundMemorySession } from "./binding"
import { createScriptedFactsPorts } from "./facts.test-support"
import { createManualTimers } from "./kibitzer/test-support"
import { createReflectionChildHosting } from "./reflection-child"
import { openMemoryRepo, reflectionRunDir, type WriterLock } from "./reflection-run-store"
import { createReflectionRunner } from "./reflection-runner"
import { createBoundIdentity } from "./reflection.test-support"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function identity(): BoundMemorySession {
  const created = createBoundIdentity()
  cleanups.push(created.cleanup)
  return created.bound
}

/** The first step of `GitMemoryRepo.init`: `.git` exists, no commit yet. */
function initWithoutCommit(bound: BoundMemorySession): void {
  mkdirSync(bound.paths.repo, { recursive: true })
  execFileSync("git", ["init", "--template="], { cwd: bound.paths.repo })
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: bound.paths.repo })
}

function repoOf(bound: BoundMemorySession): GitMemoryRepo {
  return new GitMemoryRepo({ dir: bound.paths.repo, agentId: bound.identity })
}

/** A seeder holding the real `memory-write` lock between `git init` and its seed commit, released by hand. */
async function holdSeedingLock(bound: BoundMemorySession) {
  mkdirSync(bound.paths.locks, { recursive: true })
  let release = (): void => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered = (): void => undefined
  const holding = new Promise<void>(resolve => { entered = resolve })
  const seeding = withLock(memoryWriterLockPath(bound.paths.locks), await createLockRecord("test seeder"), async () => {
    initWithoutCommit(bound)
    entered()
    await gate
    await initMemoryWithSeeds(repoOf(bound), { authorName: bound.identity })
  })
  await holding
  return { release, seeding }
}

function runner(bound: BoundMemorySession, lockWaitTimeoutMs: number) {
  const ports = createScriptedFactsPorts()
  const hosting = createReflectionChildHosting({ host: { session: {} }, createPort: request => ports.createPort(request), timers: createManualTimers(), warn: () => undefined })
  const reflection = createReflectionRunner({ launch: hosting.launch, warn: () => undefined, createRunId: () => "run-a", lockWaitTimeoutMs })
  const run = () => reflection.runReflection(bound, { parentSessionId: "ses_root", request: { trigger: "manual", conversationIds: [], snapshots: [] } })
  return { ports, run }
}

const finalRecord = (bound: BoundMemorySession): Record<string, unknown> => JSON.parse(readFileSync(join(reflectionRunDir(bound, "run-a"), "final.json"), "utf8"))

describe("reflection on a memory identity whose repo is being created", () => {
  test("#given a repo with .git but no commit #when the run store opens it #then it takes the writer lock and returns a repo with a HEAD", async () => {
    // given
    const bound = identity()
    initWithoutCommit(bound)
    let locked = 0
    const lock: WriterLock = async operation => { locked += 1; return operation() }
    // when
    const repo = await openMemoryRepo(bound, lock)
    // then
    expect(locked).toBe(1)
    expect(await repo.head()).not.toBeNull()
  })

  test("#given a repo that already has a HEAD #when the run store opens it #then the writer lock is not taken", async () => {
    // given
    const bound = identity()
    await initMemoryWithSeeds(repoOf(bound), { authorName: bound.identity })
    let locked = 0
    const lock: WriterLock = async operation => { locked += 1; return operation() }
    // when
    await openMemoryRepo(bound, lock)
    // then
    expect(locked).toBe(0)
  })

  test("#given a seeder holding the memory-write lock with .git present and no commit #when a reflection starts and the seeder then commits #then the run waits for the seed commit and launches its child", async () => {
    // given
    const bound = identity()
    const seeder = await holdSeedingLock(bound)
    const { ports, run } = runner(bound, 30_000)
    // when
    const running = run()
    // Before the fix the run settles spawn_failed without the lock; after it, the run cannot pass the lock.
    await Promise.race([running, new Promise(resolve => setTimeout(resolve, 1_500))])
    seeder.release()
    await seeder.seeding
    const child = await Promise.race([ports.started(1), running.then(() => undefined)])
    child?.finish()
    const report = await running
    // then
    expect(child).toBeDefined()
    expect(report.status === "finished" ? report.runs[0] : undefined).toMatchObject({ runId: "run-a", outcome: "no_changes" })
  })

  test("#given a seeder that holds the memory-write lock past the run's wait #when a reflection starts #then it settles spawn_failed and final.json records the cause", async () => {
    // given
    const bound = identity()
    const seeder = await holdSeedingLock(bound)
    const { ports, run } = runner(bound, 50)
    // when
    const report = await run()
    seeder.release()
    await seeder.seeding
    // then
    const result = report.status === "finished" ? report.runs[0] : undefined
    expect(result).toMatchObject({ outcome: "failed", reason: "spawn_failed" })
    expect(ports.children).toHaveLength(0)
    const final = finalRecord(bound)
    expect(final).toMatchObject({ runId: "run-a", outcome: "failed", reason: "spawn_failed" })
    expect(typeof final.detail).toBe("string")
    expect(final.detail).toBe(result?.detail)
  })
})
