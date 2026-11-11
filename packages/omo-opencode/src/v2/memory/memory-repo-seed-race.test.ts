import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { createLockRecord, memoryWriterLockPath, withLock, type TranscriptEntry } from "@oh-my-opencode/memory-core"
import type { BoundMemorySession } from "./binding"
import { createFactsRunner, type FactsChildLaunch } from "./facts-runner"
import { createScriptedFactsPorts, until } from "./facts.test-support"
import { createManualTimers } from "./kibitzer/test-support"
import { createReflectionChildHosting } from "./reflection-child"
import { createReflectionRunner } from "./reflection-runner"
import { createBoundIdentity } from "./reflection.test-support"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const LOCK_WAIT_MS = 30_000
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function identity(): BoundMemorySession {
  const created = createBoundIdentity()
  cleanups.push(created.cleanup)
  return created.bound
}

/** Another writer holding the real `memory-write` lock on a brand-new identity (no `.git` yet), released by hand. */
async function holdWriterLock(bound: BoundMemorySession) {
  mkdirSync(bound.paths.locks, { recursive: true })
  let release = (): void => undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  let entered = (): void => undefined
  const holding = new Promise<void>(resolve => { entered = resolve })
  const held = withLock(memoryWriterLockPath(bound.paths.locks), await createLockRecord("test writer"), async () => {
    entered()
    await gate
  })
  await holding
  return { release, held }
}

function message(id: string): TranscriptEntry {
  return { kind: "user", text: `I always use tabs ${id}`, source_message_id: id, source_line_id: id, captured_at: new Date().toISOString() }
}

function factsRunner(bound: BoundMemorySession) {
  const launched: FactsChildLaunch[] = []
  let modelResolved = (): void => undefined
  const resolved = new Promise<void>(resolve => { modelResolved = resolve })
  const runner = createFactsRunner({
    identity: bound.identity, paths: bound.paths, owner: "test-owner", now: () => new Date(), logger: { warn: () => undefined },
    people: () => ({ enabled: false, maxEntries: 0, maxEntryChars: 0 }),
    // The model is resolved immediately before the run opens (and, on a new identity, seeds) the repo.
    resolveModel: async () => { modelResolved(); return { kind: "resolved", model: "test/model", fallbacks: [] } },
    launchChild: async input => { launched.push(input); return { status: "failed", detail: "test child" } },
    deadlineMs: 60_000, ownerAlive: () => false, lockWaitTimeoutMs: LOCK_WAIT_MS,
  })
  return { runner, launched, resolved }
}

function reflectionRunner(bound: BoundMemorySession) {
  const ports = createScriptedFactsPorts()
  const hosting = createReflectionChildHosting({ host: { session: {} }, createPort: request => ports.createPort(request), timers: createManualTimers(), warn: () => undefined })
  const reflection = createReflectionRunner({ launch: hosting.launch, warn: () => undefined, createRunId: () => "run-a", lockWaitTimeoutMs: LOCK_WAIT_MS })
  const run = () => reflection.runReflection(bound, { parentSessionId: "ses_root", request: { trigger: "manual", conversationIds: [], snapshots: [] } })
  return { ports, run }
}

function rootCommits(bound: BoundMemorySession): string[] {
  return execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: bound.paths.repo, encoding: "utf8" }).split("\n").filter(Boolean)
}

describe("seeding a brand-new memory identity from concurrent facts and reflection runs", () => {
  test("#given a brand-new identity whose memory-write lock is held #when a facts run and a reflection start together #then neither seeds until the lock frees, one seed commit lands, and both launch their child", async () => {
    // given
    const bound = identity()
    const writer = await holdWriterLock(bound)
    const facts = factsRunner(bound)
    await facts.runner.queue.enqueue({ identity: bound.identity, sessionId: "ses_root", conversationId: "ses_root", entries: [message("m1")] })
    const reflection = reflectionRunner(bound)

    // when
    const factsLaunch = facts.runner.launchPending({ parentSessionId: "ses_root" })
    const reflecting = reflection.run()
    await facts.resolved
    // Before the fix the facts run ran `git init` right here, without the lock, racing the locked seeder on index.lock.
    await until(() => existsSync(join(bound.paths.repo, ".git")), 1_500).catch(() => undefined)
    const seededWhileLocked = existsSync(join(bound.paths.repo, ".git"))
    writer.release()
    await writer.held
    const child = await Promise.race([reflection.ports.started(1), reflecting.then(() => undefined)])
    child?.finish()
    const report = await reflecting
    const factsResult = await factsLaunch

    // then
    expect(seededWhileLocked).toBe(false)
    expect(rootCommits(bound)).toHaveLength(1)
    expect(facts.launched).toHaveLength(1)
    expect(factsResult).toMatchObject({ status: "failed" })
    expect(child).toBeDefined()
    expect(report.status === "finished" ? report.runs[0] : undefined).toMatchObject({ runId: "run-a", outcome: "no_changes" })
  })
})
