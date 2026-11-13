import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, realpathSync } from "node:fs"
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_RUNTIME_RETENTION,
  GitMemoryRepo,
  TranscriptJournal,
  buildIdentityPaths,
  createLockRecord,
  memoryMaintenanceLockPath,
  reflectionSchedulerLockPath,
  withLock,
} from "@oh-my-opencode/memory-core"

import { OmoMemorySettingsSchema } from "@oh-my-opencode/omo-config-core"

import { createMemoryBinding } from "./binding"
import { createMemoryIdentityContext } from "./context"
import { createMemoryMaintenance } from "./memory-maintenance"
import { rmEfaultTolerant } from "./teardown.test-support"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rmEfaultTolerant(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })),
  )
})

async function identityWithHistory(commits: number) {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), "omo-memory-maintenance-")))
  roots.push(root)
  const identity = "maintained-agent"
  const identityPaths = buildIdentityPaths(root, identity)
  const context = createMemoryIdentityContext({
    identity,
    identityPaths,
    binding: createMemoryBinding({ identity, repoPath: identityPaths.repo, boundAt: 1 }),
  })
  const repo = new GitMemoryRepo({ dir: identityPaths.repo, agentId: identity })
  await repo.init()
  for (let index = 0; index < commits; index += 1) {
    await writeFile(join(repo.dir, `note-${index}.md`), `note ${index}\n`)
    await repo.commitWrite([`note-${index}.md`], `note ${index}`, { agentId: identity, authorName: identity })
  }
  return { context, repo }
}

function recorder() {
  const info: string[] = []
  const infoData: { message: string; data?: Record<string, unknown> }[] = []
  const warn: string[] = []
  return {
    info,
    infoData,
    warn,
    logger: {
      info: (message: string, data?: Record<string, unknown>) => {
        info.push(message)
        infoData.push({ message, ...(data === undefined ? {} : { data }) })
      },
      warn: (message: string) => warn.push(message),
    },
  }
}

describe("runtime retention inside the maintenance pass (A23)", () => {
  const NOW = Date.parse("2026-11-05T00:00:00.000Z")
  const DAY = 24 * 60 * 60 * 1000

  async function identityWithOldRun() {
    const { context, repo } = await identityWithHistory(0)
    const runDir = join(context.identityPaths.reflection, "runs", "reflection-run-1")
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, "final.json"),
      JSON.stringify({
        runId: "reflection-run-1",
        outcome: "merged",
        finishedAt: new Date(NOW - 8 * DAY).toISOString(),
      }),
    )
    await utimes(join(runDir, "final.json"), new Date(NOW - 8 * DAY), new Date(NOW - 8 * DAY))
    await utimes(runDir, new Date(NOW - 8 * DAY), new Date(NOW - 8 * DAY))
    const newest = join(context.identityPaths.reflection, "runs", "reflection-run-2")
    await mkdir(newest, { recursive: true })
    await writeFile(
      join(newest, "final.json"),
      JSON.stringify({ runId: "reflection-run-2", outcome: "merged", finishedAt: new Date(NOW - DAY).toISOString() }),
    )
    return { context, repo, runDir }
  }

  test("#given a fresh retention stamp #when a pass is scheduled #then retention does not run", async () => {
    const { context, repo, runDir } = await identityWithOldRun()
    await repo.configSet("omo.retentionAt", String(NOW - 60_000))
    const log = recorder()
    const maintenance = createMemoryMaintenance({ logger: log.logger, delayMs: 0, now: () => NOW })

    maintenance.schedule(context)
    await maintenance.settled()

    expect(existsSync(runDir)).toBe(true)
    expect(log.info.filter((message) => message === "omo-senpi memory runtime retention")).toEqual([])
  })

  test("#given a stale stamp and two sessions scheduling at once #when their passes come due #then retention runs exactly once", async () => {
    const { context, runDir } = await identityWithOldRun()
    const first = recorder()
    const second = recorder()
    const a = createMemoryMaintenance({ logger: first.logger, delayMs: 0, now: () => NOW })
    const b = createMemoryMaintenance({ logger: second.logger, delayMs: 0, now: () => NOW })

    a.schedule(context)
    b.schedule(context)
    await Promise.all([a.settled(), b.settled()])

    expect(existsSync(runDir)).toBe(false)
    const runs = [...first.info, ...second.info].filter((message) => message === "omo-senpi memory runtime retention")
    expect(runs).toEqual(["omo-senpi memory runtime retention"])
    expect([...first.warn, ...second.warn]).toEqual([])
  }, 60_000)
})

describe("retention stamp and resume (A33 maintenance half)", () => {
  const NOW = Date.parse("2026-11-05T00:00:00.000Z")
  const DAY = 24 * 60 * 60 * 1000

  test("#given a cursor file and a fresh omo.maintenanceAt #when maintenance is scheduled #then retention still runs, finishes, stamps omo.retentionAt and deletes the cursor; a later pass within 12 h writes nothing", async () => {
    const { context, repo } = await identityWithHistory(0)
    const runs = join(context.identityPaths.reflection, "runs")
    for (const runId of ["reflection-run-1", "reflection-run-2"]) {
      await mkdir(join(runs, runId), { recursive: true })
      await writeFile(
        join(runs, runId, "final.json"),
        JSON.stringify({ runId, outcome: "merged", finishedAt: new Date(NOW - 8 * DAY).toISOString() }),
      )
      await utimes(join(runs, runId, "final.json"), new Date(NOW - 8 * DAY), new Date(NOW - 8 * DAY))
      await utimes(join(runs, runId), new Date(NOW - 8 * DAY), new Date(NOW - 8 * DAY))
    }
    await mkdir(join(runs, "reflection-run-3"), { recursive: true })
    await writeFile(
      join(runs, "reflection-run-3", "final.json"),
      JSON.stringify({ runId: "reflection-run-3", outcome: "merged", finishedAt: new Date(NOW - DAY).toISOString() }),
    )
    await repo.configSet("omo.maintenanceAt", String(NOW - 60_000))
    await writeFile(
      join(context.identityPaths.runtime, "retention.json"),
      JSON.stringify({ version: 1, cursor: { store: "runs", lastName: "reflection-run-1" } }),
    )

    const first = createMemoryMaintenance({ delayMs: 0, now: () => NOW })
    first.schedule(context)
    await first.settled()

    expect(existsSync(join(runs, "reflection-run-1"))).toBe(true)
    expect(existsSync(join(runs, "reflection-run-2"))).toBe(false)
    expect(existsSync(join(context.identityPaths.runtime, "retention.json"))).toBe(false)
    expect(await repo.configGet("omo.retentionAt")).toBe(String(NOW))
    expect(await repo.configGet("omo.maintenanceAt")).toBe(String(NOW - 60_000))

    const runtimeMtime = (await stat(context.identityPaths.runtime)).mtimeMs
    const reflectionMtime = (await stat(context.identityPaths.reflection)).mtimeMs
    const later = createMemoryMaintenance({ delayMs: 0, now: () => NOW + 60 * 60 * 1000 })
    later.schedule(context)
    await later.settled()
    expect(existsSync(join(runs, "reflection-run-1"))).toBe(true)
    expect((await stat(context.identityPaths.runtime)).mtimeMs).toBe(runtimeMtime)
    expect((await stat(context.identityPaths.reflection)).mtimeMs).toBe(reflectionMtime)
  }, 60_000)
})

describe("a cap that cannot measure inside the budget is throttled to the interval (#12538 review r5 L1)", () => {
  const NOW = Date.parse("2026-11-05T00:00:00.000Z")
  const HOUR = 60 * 60 * 1000
  const resume = { store: "cap", tier: "folded-run", clock: 0, lastName: "reflection-run-0" }
  // A pass budget of 0 ms: the stores are empty, so the store walk finishes, and the cap's size walk
  // always overruns what is left, so the cap can never measure runtime/.
  const zeroBudget = {
    resolveRetention: () => ({ ...DEFAULT_RUNTIME_RETENTION, passBudgetMs: 0 }),
    resolveMaxBytes: () => 1,
  }

  test("#given a stored cap resume point and a size walk that always overruns #when the pass runs #then it stamps omo.retentionAt and the next bind inside the interval does not run retention", async () => {
    const { context, repo } = await identityWithHistory(0)
    const cursorFile = join(context.identityPaths.runtime, "retention.json")
    await mkdir(context.identityPaths.runtime, { recursive: true })
    await writeFile(cursorFile, JSON.stringify({ version: 1, cap: resume }))

    const first = recorder()
    const stalled = createMemoryMaintenance({ logger: first.logger, delayMs: 0, now: () => NOW, ...zeroBudget })
    stalled.schedule(context)
    await stalled.settled()

    expect(first.info).toContain("omo-senpi memory runtime retention")
    expect(await repo.configGet("omo.retentionAt")).toBe(String(NOW))
    const kept = await readFile(cursorFile, "utf8")
    expect((JSON.parse(kept) as { cap?: unknown }).cap).toEqual(resume)

    const second = recorder()
    const later = createMemoryMaintenance({ logger: second.logger, delayMs: 0, now: () => NOW + HOUR, ...zeroBudget })
    later.schedule(context)
    await later.settled()

    expect(second.info.filter((message) => message === "omo-senpi memory runtime retention")).toEqual([])
    expect(await repo.configGet("omo.retentionAt")).toBe(String(NOW))
    expect(await readFile(cursorFile, "utf8")).toBe(kept)
  }, 60_000)

  test("#given a fresh omo.retentionAt and a cap resume point left by a pass that made progress #when the next bind runs #then retention resumes the cap and completes", async () => {
    const { context, repo } = await identityWithHistory(0)
    const cursorFile = join(context.identityPaths.runtime, "retention.json")
    await mkdir(context.identityPaths.runtime, { recursive: true })
    await writeFile(cursorFile, JSON.stringify({ version: 1, cap: resume }))
    await repo.configSet("omo.retentionAt", String(NOW - HOUR))

    const maintenance = createMemoryMaintenance({ delayMs: 0, now: () => NOW, resolveMaxBytes: () => 1 })
    maintenance.schedule(context)
    await maintenance.settled()

    expect(existsSync(cursorFile)).toBe(false)
    expect(await repo.configGet("omo.retentionAt")).toBe(String(NOW))
  }, 60_000)
})

describe("host sweep driver 2 (6b, A34 in-session half)", () => {
  const NOW = Date.parse("2026-11-05T00:00:00.000Z")
  const DAY = 24 * 60 * 60 * 1000

  async function foreignWithOldRun(memoryRoot: string): Promise<string> {
    const runs = join(memoryRoot, "agents", "foreign-agent", "runtime", "reflection", "runs")
    for (const [runId, age] of [
      ["reflection-run-1", 8],
      ["reflection-run-9", 1],
    ] as const) {
      await mkdir(join(runs, runId), { recursive: true })
      await writeFile(
        join(runs, runId, "final.json"),
        JSON.stringify({ runId, outcome: "merged", finishedAt: new Date(NOW - age * DAY).toISOString() }),
      )
      await utimes(join(runs, runId, "final.json"), new Date(NOW - age * DAY), new Date(NOW - age * DAY))
      await utimes(join(runs, runId), new Date(NOW - age * DAY), new Date(NOW - age * DAY))
    }
    return join(runs, "reflection-run-1")
  }

  test("#given a foreign repo-less identity with a folded run past retention #when a bound session's pass runs with driver 2 on #then the foreign run is pruned and the host round completes", async () => {
    const { context } = await identityWithHistory(0)
    const memoryRoot = join(context.identityPaths.root, "..", "..")
    const foreignRun = await foreignWithOldRun(memoryRoot)
    const maintenance = createMemoryMaintenance({ delayMs: 0, now: () => NOW, hostSweep: () => ({}) })

    maintenance.schedule(context)
    await maintenance.settled()

    expect(existsSync(foreignRun)).toBe(false)
    expect(existsSync(join(memoryRoot, "runtime-sweep.json"))).toBe(true)
  }, 60_000)

  test("#given a bound identity whose live session has a fully reflected journal past retention #when the pass runs with driver 2 on #then the host sweep does not revisit the bound identity and the journal stays (REVIEW-5 M2)", async () => {
    const { context } = await identityWithHistory(0)
    const journalDir = join(context.identityPaths.transcripts, "live-session")
    const journal = new TranscriptJournal({ journalDir, now: () => new Date(NOW - 20 * DAY) })
    await journal.reconcile([
      { kind: "user", messageId: "u1", text: "first" },
      { kind: "assistant", messageId: "a1", textBlocks: ["first answer"] },
    ])
    const snapshot = await journal.captureReflectionSnapshot()
    if (snapshot === null) throw new Error("expected a snapshot")
    await journal.finalizeReflection(snapshot, true)
    for (const name of ["state.json", "transcript.jsonl"])
      await utimes(join(journalDir, name), new Date(NOW - 20 * DAY), new Date(NOW - 20 * DAY))
    await utimes(journalDir, new Date(NOW - 20 * DAY), new Date(NOW - 20 * DAY))
    const maintenance = createMemoryMaintenance({
      delayMs: 0,
      now: () => NOW,
      isLiveSession: (id) => id === "live-session",
      hostSweep: () => ({}),
    })

    maintenance.schedule(context)
    await maintenance.settled()

    expect(existsSync(join(journalDir, "transcript.jsonl"))).toBe(true)
  }, 60_000)

  test("#given driver 2 disabled (CI, task child) #when the pass runs #then foreign identities are untouched", async () => {
    const { context } = await identityWithHistory(0)
    const memoryRoot = join(context.identityPaths.root, "..", "..")
    const foreignRun = await foreignWithOldRun(memoryRoot)
    const maintenance = createMemoryMaintenance({ delayMs: 0, now: () => NOW })

    maintenance.schedule(context)
    await maintenance.settled()

    expect(existsSync(foreignRun)).toBe(true)
    expect(existsSync(join(memoryRoot, "runtime-sweep.json"))).toBe(false)
  }, 60_000)
})

describe("runtime size cap inside the maintenance pass (B08)", () => {
  const NOW = Date.parse("2026-11-05T00:00:00.000Z")
  const DAY = 24 * 60 * 60 * 1000

  async function identityWithYoungRuns() {
    const { context } = await identityWithHistory(0)
    const runDirs: string[] = []
    for (const [index, days] of [
      [3, 3],
      [4, 2],
      [5, 1],
    ] as const) {
      const runDir = join(context.identityPaths.reflection, "runs", `reflection-run-${index}`)
      await mkdir(runDir, { recursive: true })
      await writeFile(
        join(runDir, "final.json"),
        JSON.stringify({
          runId: `reflection-run-${index}`,
          outcome: "merged",
          finishedAt: new Date(NOW - days * DAY).toISOString(),
        }),
      )
      await writeFile(join(runDir, "child-1.log"), Buffer.alloc(64 * 1024, 1))
      runDirs.push(runDir)
    }
    return { context, runDirs }
  }

  test("#given an identity over its cap #when the pass runs #then the cap evicts the oldest folded runs and logs the figures", async () => {
    const { context, runDirs } = await identityWithYoungRuns()
    const log = recorder()
    const maintenance = createMemoryMaintenance({
      logger: log.logger,
      delayMs: 0,
      now: () => NOW,
      resolveMaxBytes: () => 1,
    })

    maintenance.schedule(context)
    await maintenance.settled()

    expect(runDirs.map((dir) => existsSync(dir))).toEqual([false, false, true])
    const line = log.infoData.find((entry) => entry.message === "omo-senpi memory runtime retention")
    expect(line?.data?.evicted).toBe(2)
    expect(line?.data?.capBytes).toBe(1)
    expect(log.warn).toEqual(["omo-senpi memory runtime cap exceeded, nothing evictable"])
  }, 60_000)

  test("#given memory settings whose agents.<id>.runtime.max_bytes caps this identity #when the pass runs #then the sidecar resolves that cap and evicts", async () => {
    const { context, runDirs } = await identityWithYoungRuns()
    const log = recorder()
    const settings = OmoMemorySettingsSchema.parse({ agents: { [context.identity]: { runtime: { max_bytes: 1 } } } })
    const maintenance = createMemoryMaintenance({
      logger: log.logger,
      delayMs: 0,
      now: () => NOW,
      memorySettings: () => settings,
    })

    maintenance.schedule(context)
    await maintenance.settled()

    expect(runDirs.map((dir) => existsSync(dir))).toEqual([false, false, true])
    expect(log.infoData.find((entry) => entry.message === "omo-senpi memory runtime retention")?.data?.capBytes).toBe(1)
    expect(log.warn).toEqual(["omo-senpi memory runtime cap exceeded, nothing evictable"])
  }, 60_000)

  test("#given memory settings that cap only another identity #when the pass runs #then this identity keeps the global cap and nothing is evicted", async () => {
    const { context, runDirs } = await identityWithYoungRuns()
    const log = recorder()
    const settings = OmoMemorySettingsSchema.parse({ agents: { "other-agent": { runtime: { max_bytes: 1 } } } })
    const maintenance = createMemoryMaintenance({
      logger: log.logger,
      delayMs: 0,
      now: () => NOW,
      memorySettings: () => settings,
    })

    maintenance.schedule(context)
    await maintenance.settled()

    expect(runDirs.map((dir) => existsSync(dir))).toEqual([true, true, true])
    expect(log.warn).toEqual([])
  }, 60_000)

  test("#given the reflection-scheduler lock is busy so the journal tiers are skipped #when the over-cap pass runs #then it does not log nothing-evictable (#12538 review L4)", async () => {
    const { context, runDirs } = await identityWithYoungRuns()
    const log = recorder()
    const maintenance = createMemoryMaintenance({
      logger: log.logger,
      delayMs: 0,
      now: () => NOW,
      resolveMaxBytes: () => 1,
    })
    const holder = await createLockRecord("reflection-scheduler", { runId: "other-process" })
    await mkdir(context.identityPaths.locks, { recursive: true })

    await withLock(
      reflectionSchedulerLockPath(context.identityPaths.locks),
      holder,
      async () => {
        maintenance.schedule(context)
        await maintenance.settled()
      },
      { waitTimeoutMs: 0 },
    )

    expect(runDirs.map((dir) => existsSync(dir))).toEqual([false, false, true])
    expect(log.warn).not.toContain("omo-senpi memory runtime cap exceeded, nothing evictable")
    expect(log.warn).toEqual(["omo-senpi memory runtime cap exceeded, eviction continues next pass"])
  }, 60_000)

  test("#given another process holds the maintenance lock #when the pass comes due #then the cap skips without waiting or evicting", async () => {
    const { context, runDirs } = await identityWithYoungRuns()
    const log = recorder()
    const maintenance = createMemoryMaintenance({
      logger: log.logger,
      delayMs: 0,
      now: () => NOW,
      resolveMaxBytes: () => 1,
    })
    const holder = await createLockRecord("memory-maintenance", { runId: "other-process" })

    await withLock(
      memoryMaintenanceLockPath(context.identityPaths.locks),
      holder,
      async () => {
        maintenance.schedule(context)
        await maintenance.settled()
      },
      { waitTimeoutMs: 0 },
    )

    expect(runDirs.every((dir) => existsSync(dir))).toBe(true)
    expect(log.info).toEqual([])
    expect(log.warn).toEqual([])
  }, 60_000)
})
