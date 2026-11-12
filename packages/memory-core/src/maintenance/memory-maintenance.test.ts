import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import {
  GitMemoryRepo,
  buildIdentityPaths,
  createLockRecord,
  createReflectionWorktree,
  discardReflectionWorktree,
  memoryMaintenanceLockPath,
  validateCompletion,
  withLock,
} from "../index"

import { createMemoryMaintenance } from "./memory-maintenance"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })))
})

async function identityWithHistory(commits: number) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omo-memory-maintenance-")))
  roots.push(root)
  const identity = "maintained-agent"
  const identityPaths = buildIdentityPaths(root, identity)
  const context = { identity: identity, identityPaths }
  const repo = new GitMemoryRepo({ dir: identityPaths.repo, agentId: identity })
  await repo.init()
  for (let index = 0; index < commits; index += 1) {
    await writeFile(join(repo.dir, `note-${index}.md`), `note ${index}\n`)
    await repo.commitWrite([`note-${index}.md`], `note ${index}`, { agentId: identity, authorName: identity })
  }
  return { context, repo }
}

function looseObjects(dir: string): number {
  const output = execFileSync("git", ["count-objects", "-v"], { cwd: dir, encoding: "utf8" })
  return Number(/^count: (\d+)$/m.exec(output)?.[1] ?? Number.NaN)
}

function recorder() {
  const info: string[] = []
  const warn: string[] = []
  return { info, warn, logger: { info: (message: string) => info.push(message), warn: (message: string) => warn.push(message) } }
}

describe("createMemoryMaintenance", () => {
  test("#given a reflection snapshot #when real maintenance runs #then Git administration stays unchanged", async () => {
    const { context, repo } = await identityWithHistory(1)
    const worktree = await createReflectionWorktree(repo, "maintenance-race", context.identityPaths.worktrees)
    const attemptedAt = 1_800_000_000_000
    const log = recorder()
    const maintenance = createMemoryMaintenance({
      createRepo: () => repo,
      logger: log.logger,
      delayMs: 0,
      now: () => attemptedAt,
      minLooseObjects: Number.MAX_SAFE_INTEGER,
    })
    const unchanged = { status: "no_changes", tipSha: worktree.baseSha, changedPaths: [] } as const
    try {
      expect(await validateCompletion(worktree, worktree.baseSha)).toEqual(unchanged)

      maintenance.schedule(context)
      await maintenance.settled()

      expect({
        validation: await validateCompletion(worktree, worktree.baseSha),
        commonConfigUnchanged: await readFile(worktree.commonConfigPath, "utf8") === worktree.commonConfigSnapshot,
        gitPointerUnchanged: await readFile(worktree.gitFilePath, "utf8") === worktree.gitFileSnapshot,
        legacyStamp: await repo.configGet("omo.maintenanceAt"),
        warnings: log.warn,
      }).toEqual({
        validation: unchanged,
        commonConfigUnchanged: true,
        gitPointerUnchanged: true,
        legacyStamp: null,
        warnings: [],
      })
      expect(JSON.parse(await readFile(join(context.identityPaths.runtime, "maintenance.json"), "utf8")))
        .toEqual({ version: 1, attemptedAt })
    } finally {
      maintenance.dispose()
      await maintenance.settled()
      await discardReflectionWorktree(repo, worktree.dir, worktree.branch)
    }
  }, 30_000)

  test("#given a memory repo full of loose objects #when a session binds and the delay passes #then the objects are packed and every commit stays readable", async () => {
    // given
    const { context, repo } = await identityWithHistory(20)
    const before = looseObjects(repo.dir)
    const log = recorder()
    const maintenance = createMemoryMaintenance({ logger: log.logger, delayMs: 0, minLooseObjects: 10 })

    // when
    maintenance.schedule(context)
    await maintenance.settled()

    // then
    expect(before).toBeGreaterThanOrEqual(60)
    expect(looseObjects(repo.dir)).toBeLessThan(before)
    expect(log.info).toEqual(["memory repo packed"])
    expect(log.warn).toEqual([])
    expect((await repo.log()).length).toBe(21)
  }, 60_000)

  test("#given maintenance is running #when another session commits at the same time #then that commit succeeds and survives the pack", async () => {
    // given
    const { context, repo } = await identityWithHistory(20)
    const maintenance = createMemoryMaintenance({ delayMs: 0, minLooseObjects: 10 })

    // when
    maintenance.schedule(context)
    await writeFile(join(repo.dir, "concurrent.md"), "written during maintenance\n")
    const concurrent = repo.commitWrite(["concurrent.md"], "concurrent note", { agentId: context.identity, authorName: context.identity })
    await Promise.all([concurrent, maintenance.settled()])

    // then
    const subjects = (await repo.log()).map((commit) => commit.subject)
    expect(subjects).toContain("concurrent note")
    expect(execFileSync("git", ["fsck", "--connectivity-only"], { cwd: repo.dir, encoding: "utf8" })).not.toContain("missing")
  }, 60_000)

  test("#given a pass ran recently for this identity #when a second process schedules one #then it does not run again within the interval", async () => {
    // given
    const { context, repo } = await identityWithHistory(20)
    const first = createMemoryMaintenance({ delayMs: 0, minLooseObjects: 10 })
    first.schedule(context)
    await first.settled()
    for (let index = 20; index < 40; index += 1) {
      await writeFile(join(repo.dir, `note-${index}.md`), `note ${index}\n`)
      await repo.commitWrite([`note-${index}.md`], `note ${index}`, { agentId: context.identity, authorName: context.identity })
    }
    const looseAfterNewCommits = looseObjects(repo.dir)
    const childScript = join(context.identityPaths.runtime, "maintenance-child.ts")
    await writeFile(childScript, `
const core = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)})
const { createMemoryMaintenance } = await import(${JSON.stringify(new URL("./memory-maintenance.ts", import.meta.url).href)})
const identity = ${JSON.stringify(context.identity)}
const identityPaths = core.buildIdentityPaths(${JSON.stringify(dirname(dirname(context.identityPaths.root)))}, identity)
const context = { identity, identityPaths }
const info: string[] = [], warn: string[] = []
const maintenance = createMemoryMaintenance({ delayMs: 0, minLooseObjects: 10,
  logger: { info: (message: string) => info.push(message), warn: (message: string) => warn.push(message) } })
maintenance.schedule(context)
await maintenance.settled()
maintenance.dispose()
console.log(JSON.stringify({ pid: process.pid, info, warn }))
`, "utf8")

    // when: a distinct OS process observes the first pass's persistent stamp.
    const second = JSON.parse(execFileSync(process.execPath, [childScript], {
      cwd: context.identityPaths.runtime, env: process.env, encoding: "utf8", timeout: 30_000, windowsHide: true,
    })) as { pid: number; info: string[]; warn: string[] }

    // then
    expect(second.pid).not.toBe(process.pid)
    expect(second.info).toEqual([])
    expect(second.warn).toEqual([])
    expect(looseObjects(repo.dir)).toBe(looseAfterNewCommits)
    expect(await repo.configGet("omo.maintenanceAt")).toBeNull()
  }, 60_000)

  const now = 1_800_000_000_000
  const interval = 12 * 60 * 60 * 1000
  const stampCases: ReadonlyArray<{ name: string; legacy?: string; runtime?: unknown; runs: boolean }> = [
    { name: "recent legacy only", legacy: String(now - 1), runs: false },
    { name: "expired legacy only", legacy: String(now - interval - 1), runs: true },
    { name: "newer runtime", legacy: String(now - interval - 1), runtime: { version: 1, attemptedAt: now - 1 }, runs: false },
    { name: "newer legacy", legacy: String(now - 1), runtime: { version: 1, attemptedAt: now - interval - 1 }, runs: false },
    { name: "both expired", legacy: String(now - interval - 2), runtime: { version: 1, attemptedAt: now - interval - 1 }, runs: true },
    { name: "malformed runtime with recent legacy", legacy: String(now - 1), runtime: "{", runs: false },
    { name: "malformed runtime and legacy", legacy: "invalid", runtime: "{", runs: true },
    { name: "unsupported runtime version", runtime: { version: 2, attemptedAt: now - 1 }, runs: true },
    { name: "nonnumeric runtime time", runtime: { version: 1, attemptedAt: String(now - 1) }, runs: true },
  ]
  for (const item of stampCases) {
    test(`#given ${item.name} #when maintenance runs #then the latest finite stamp controls without changing Git config`, async () => {
      const { context, repo } = await identityWithHistory(0)
      if (item.legacy !== undefined) await repo.configSet("omo.maintenanceAt", item.legacy)
      const stampPath = join(context.identityPaths.runtime, "maintenance.json")
      const originalStamp = item.runtime === undefined ? undefined
        : typeof item.runtime === "string" ? item.runtime : JSON.stringify(item.runtime)
      if (originalStamp !== undefined) {
        await mkdir(context.identityPaths.runtime, { recursive: true })
        await writeFile(stampPath, originalStamp, "utf8")
      }
      const configBefore = await readFile(join(repo.dir, ".git", "config"), "utf8")
      const log = recorder()
      const maintenance = createMemoryMaintenance({
        logger: log.logger, delayMs: 0, now: () => now, minLooseObjects: Number.MAX_SAFE_INTEGER,
      })
      maintenance.schedule(context)
      await maintenance.settled()
      expect(await readFile(join(repo.dir, ".git", "config"), "utf8")).toBe(configBefore)
      expect(await repo.configGet("omo.maintenanceAt")).toBe(item.legacy ?? null)
      expect(log.warn).toEqual([])
      if (item.runs) {
        expect(JSON.parse(await readFile(stampPath, "utf8"))).toEqual({ version: 1, attemptedAt: now })
      } else if (originalStamp !== undefined) {
        expect(await readFile(stampPath, "utf8")).toBe(originalStamp)
      } else expect(existsSync(stampPath)).toBe(false)
    }, 30_000)
  }

  test("#given a runtime stamp read error #when maintenance runs #then it warns without packing or writing Git config", async () => {
    const { context, repo } = await identityWithHistory(0)
    await mkdir(join(context.identityPaths.runtime, "maintenance.json"), { recursive: true })
    const before = await readFile(join(repo.dir, ".git", "config"), "utf8")
    const log = recorder()
    const maintenance = createMemoryMaintenance({ logger: log.logger, delayMs: 0, minLooseObjects: 0 })
    maintenance.schedule(context)
    await maintenance.settled()
    expect(log.warn).toEqual(["memory repo maintenance failed"])
    expect(log.info).toEqual([])
    expect(await readFile(join(repo.dir, ".git", "config"), "utf8")).toBe(before)
  }, 30_000)

  test("#given packing fails #when a pass already published its attempt #then the runtime stamp still throttles the next pass", async () => {
    const { context, repo } = await identityWithHistory(0)
    const failingRepo = new class extends GitMemoryRepo {
      override async maintain(): Promise<never> { throw new Error("controlled packing failure") }
    }({ dir: repo.dir, agentId: context.identity })
    const log = recorder()
    const first = createMemoryMaintenance({ createRepo: () => failingRepo, logger: log.logger, delayMs: 0, now: () => now })
    first.schedule(context)
    await first.settled()
    expect(log.warn).toEqual(["memory repo maintenance failed"])
    expect(JSON.parse(await readFile(join(context.identityPaths.runtime, "maintenance.json"), "utf8")))
      .toEqual({ version: 1, attemptedAt: now })
    const secondLog = recorder()
    const second = createMemoryMaintenance({ createRepo: () => failingRepo, logger: secondLog.logger, delayMs: 0, now: () => now + 1 })
    second.schedule(context)
    await second.settled()
    expect(secondLog.warn).toEqual([])
    expect(await repo.configGet("omo.maintenanceAt")).toBeNull()
  }, 30_000)

  for (const target of ["config", "legacy stamp", "git pointer"] as const) {
    test(`#given ${target} tampering #when actual completion validates #then Git administration changes are still refused`, async () => {
      const { context, repo } = await identityWithHistory(0)
      const worktree = await createReflectionWorktree(repo, "tampered-admin", context.identityPaths.worktrees)
      try {
        if (target === "git pointer") await writeFile(worktree.gitFilePath, `${worktree.gitFileSnapshot}# tampered\n`, "utf8")
        else await repo.configSet(target === "legacy stamp" ? "omo.maintenanceAt" : "core.hooksPath", "tampered")
        expect(await validateCompletion(worktree, worktree.baseSha))
          .toEqual({ status: "failed", detail: "Git administration files were modified" })
      } finally {
        await writeFile(worktree.gitFilePath, worktree.gitFileSnapshot, "utf8")
        if (worktree.commonConfigSnapshot !== null) await writeFile(worktree.commonConfigPath, worktree.commonConfigSnapshot, "utf8")
        await discardReflectionWorktree(repo, worktree.dir, worktree.branch)
      }
    }, 30_000)
  }

  test("#given an identity whose repo does not exist yet #when maintenance is scheduled #then it does nothing and logs no failure", async () => {
    // given
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omo-memory-maintenance-")))
    roots.push(root)
    const identityPaths = buildIdentityPaths(root, "transient-agent")
    const context = { identity: "transient-agent", identityPaths }
    const log = recorder()
    const maintenance = createMemoryMaintenance({ logger: log.logger, delayMs: 0, minLooseObjects: 1 })

    // when
    maintenance.schedule(context)
    await maintenance.settled()

    // then
    expect(log.warn).toEqual([])
    expect(log.info).toEqual([])
  }, 30_000)

  test("#given ten sessions bind to the same identity at once #when their passes come due #then exactly one pack runs", async () => {
    // given
    const { context, repo } = await identityWithHistory(20)
    const log = recorder()
    const runners = Array.from({ length: 10 }, () => createMemoryMaintenance({ logger: log.logger, delayMs: 0, minLooseObjects: 10 }))

    // when
    for (const runner of runners) runner.schedule(context)
    await Promise.all(runners.map((runner) => runner.settled()))

    // then
    expect(log.info).toEqual(["memory repo packed"])
    expect(log.warn).toEqual([])
    expect(looseObjects(repo.dir)).toBe(0)
  }, 60_000)

  test("#given another process holds the maintenance lock #when this session's pass comes due #then it skips without packing or warning", async () => {
    // given
    const { context, repo } = await identityWithHistory(20)
    const before = looseObjects(repo.dir)
    const log = recorder()
    const maintenance = createMemoryMaintenance({ logger: log.logger, delayMs: 0, minLooseObjects: 10 })
    const holder = await createLockRecord("memory-maintenance", { runId: "other-process" })

    // when
    await withLock(memoryMaintenanceLockPath(context.identityPaths.locks), holder, async () => {
      maintenance.schedule(context)
      await maintenance.settled()
    })

    // then
    expect(looseObjects(repo.dir)).toBe(before)
    expect(log.info).toEqual([])
    expect(log.warn).toEqual([])
  }, 60_000)

  test("#given a pass is scheduled #when the session exits first #then nothing runs and nothing is logged", async () => {
    // given
    const { context, repo } = await identityWithHistory(20)
    const before = looseObjects(repo.dir)
    const log = recorder()
    const maintenance = createMemoryMaintenance({ logger: log.logger, delayMs: 60_000, minLooseObjects: 10 })
    maintenance.schedule(context)

    // when
    maintenance.dispose()
    await maintenance.settled()

    // then
    expect(looseObjects(repo.dir)).toBe(before)
    expect(log.info).toEqual([])
    expect(log.warn).toEqual([])
    expect(existsSync(join(context.identityPaths.runtime, "maintenance.json"))).toBe(false)
  }, 60_000)

  test("#given a loose object no commit references yet (a writer mid-commit) #when a pass packs the repo #then that object is kept", async () => {
    // given
    const { context, repo } = await identityWithHistory(20)
    const pending = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo.dir, input: "staged by a writer\n", encoding: "utf8" }).trim()
    const maintenance = createMemoryMaintenance({ delayMs: 0, minLooseObjects: 10 })

    // when
    maintenance.schedule(context)
    await maintenance.settled()

    // then
    expect(execFileSync("git", ["cat-file", "-p", pending], { cwd: repo.dir, encoding: "utf8" })).toBe("staged by a writer\n")
  }, 60_000)

  test("#given a shared host where one session exits before its pass #when another session binds later #then that session's pass runs", async () => {
    // given
    const { context, repo } = await identityWithHistory(20)
    const log = recorder()
    const host = createMemoryMaintenance({ logger: log.logger, delayMs: 0, minLooseObjects: 10 })
    host.schedule(context)
    host.dispose()
    await host.settled()
    expect(log.info).toEqual([])

    // when
    host.schedule(context)
    await host.settled()

    // then
    expect(log.info).toEqual(["memory repo packed"])
    expect(looseObjects(repo.dir)).toBe(0)
  }, 60_000)

  test("#given empty transcript journals left by older builds #when maintenance runs #then the idle ones are removed and counted, a live session's is kept (#9737)", async () => {
    // given
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omo-memory-maintenance-")))
    roots.push(root)
    const identityPaths = buildIdentityPaths(root, "transient-agent")
    const context = { identity: "transient-agent", identityPaths }
    const old = new Date(Date.now() - 60 * 60 * 1000)
    for (const sessionId of ["stale-control", "live-control"]) {
      const dir = join(identityPaths.transcripts, sessionId)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "transcript.jsonl"), "")
      await writeFile(join(dir, "state.json"), JSON.stringify({ schema_version: "v3_assistant_steps", total_completed_steps: 0 }))
      for (const file of ["transcript.jsonl", "state.json"]) await utimes(join(dir, file), old, old)
      await utimes(dir, old, old)
    }
    const log = recorder()
    const maintenance = createMemoryMaintenance({
      logger: log.logger,
      delayMs: 0,
      isLiveSession: (sessionId) => sessionId === "live-control",
    })

    // when
    maintenance.schedule(context)
    await maintenance.settled()

    // then
    expect(existsSync(join(identityPaths.transcripts, "stale-control"))).toBe(false)
    expect(existsSync(join(identityPaths.transcripts, "live-control"))).toBe(true)
    expect(log.info).toEqual(["memory removed empty transcript journals"])
    expect(log.warn).toEqual([])
  }, 30_000)

  test("#given a control session that exits right after it binds #when maintenance is disposed before the repack delay #then the empty journal sweep still runs (#9737)", async () => {
    // given
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omo-memory-maintenance-")))
    roots.push(root)
    const identityPaths = buildIdentityPaths(root, "transient-agent")
    const context = { identity: "transient-agent", identityPaths }
    const old = new Date(Date.now() - 60 * 60 * 1000)
    const dir = join(identityPaths.transcripts, "health-check")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "transcript.jsonl"), "")
    await utimes(join(dir, "transcript.jsonl"), old, old)
    await utimes(dir, old, old)
    const maintenance = createMemoryMaintenance({ delayMs: 60_000 })

    // when
    maintenance.schedule(context)
    maintenance.dispose()
    await maintenance.settled()

    // then
    expect(existsSync(dir)).toBe(false)
  }, 30_000)

  test("#given the sweep ran for an identity #when a later session in the same process schedules maintenance #then it does not sweep again (#9737)", async () => {
    // given
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omo-memory-maintenance-")))
    roots.push(root)
    const identityPaths = buildIdentityPaths(root, "transient-agent")
    const context = { identity: "transient-agent", identityPaths }
    const log = recorder()
    const maintenance = createMemoryMaintenance({ logger: log.logger, delayMs: 60_000 })
    maintenance.schedule(context)
    maintenance.dispose()
    await maintenance.settled()
    const old = new Date(Date.now() - 60 * 60 * 1000)
    const dir = join(identityPaths.transcripts, "later-empty")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "transcript.jsonl"), "")
    await utimes(join(dir, "transcript.jsonl"), old, old)
    await utimes(dir, old, old)

    // when
    maintenance.schedule(context)
    maintenance.dispose()
    await maintenance.settled()

    // then
    expect(existsSync(dir)).toBe(true)
  }, 30_000)
})
