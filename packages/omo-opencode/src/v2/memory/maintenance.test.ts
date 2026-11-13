import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { GitMemoryRepo, TranscriptJournal } from "@oh-my-opencode/memory-core"
import { registerMemoryComponent } from "./index"
import { until } from "./facts.test-support"
import { createMemoryFixture } from "./test-support"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const fixtures: ReturnType<typeof createMemoryFixture>[] = []
function fixture() {
  const created = createMemoryFixture()
  fixtures.push(created)
  return created
}
afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup()
})

/** `<identity runtime>/maintenance.json` stamps under the memory home, wherever the identity landed. */
function maintenanceStamps(home: string): string[] {
  if (!existsSync(home)) return []
  return readdirSync(home, { recursive: true, encoding: "utf8" })
    .filter((path) => path.replaceAll("\\", "/").endsWith("runtime/maintenance.json"))
    .map((path) => join(home, path))
}

async function seededRoot(f: ReturnType<typeof createMemoryFixture>): Promise<void> {
  f.addSession("root")
  const first = await registerMemoryComponent(
    f.host,
    f.options({ maintenance: { delayMs: 60_000, transientSweepDeferMs: 600_000 } }),
  )
  await f.runTool("memory", "root", {
    command: "create",
    reason: "add notes",
    file_path: "system/notes.md",
    description: "Working notes for this project",
    file_text: "zebra",
  })
  await first()
}

describe("memory repo maintenance lifecycle (S7b)", () => {
  test("#given a pass still waiting on its delay #when the component closes #then the timer is cancelled and no pass runs", async () => {
    // given
    const f = fixture()

    // when
    const started = Date.now()
    await seededRoot(f)

    // then
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(maintenanceStamps(f.env.OMO_MEMORY_HOME ?? "")).toEqual([])
  })

  test("#given a seeded identity #when a root session binds with no delay #then one pass runs under the lock and stamps the identity runtime", async () => {
    // given
    const f = fixture()
    await seededRoot(f)
    const cleanup = await registerMemoryComponent(
      f.host,
      f.options({ maintenance: { delayMs: 0, minLooseObjects: 0, now: () => 1_800_000_000_000 } }),
    )

    // when
    await f.context("root")
    await until(() => maintenanceStamps(f.env.OMO_MEMORY_HOME ?? "").length === 1, 30_000)
    await cleanup()

    // then
    const [stamp] = maintenanceStamps(f.env.OMO_MEMORY_HOME ?? "")
    expect(JSON.parse(readFileSync(stamp ?? "", "utf8"))).toEqual({ version: 1, attemptedAt: 1_800_000_000_000 })
  })

  test("#given a stamp from the last 12 hours #when another root session binds #then no second pass rewrites it", async () => {
    // given
    const f = fixture()
    await seededRoot(f)
    const first = await registerMemoryComponent(
      f.host,
      f.options({ maintenance: { delayMs: 0, minLooseObjects: 0, now: () => 1_800_000_000_000 } }),
    )
    await f.context("root")
    await until(() => maintenanceStamps(f.env.OMO_MEMORY_HOME ?? "").length === 1, 30_000)
    await first()
    f.addSession("second")
    let entered = 0
    const second = await registerMemoryComponent(
      f.host,
      f.options({
        maintenance: {
          delayMs: 0,
          minLooseObjects: 0,
          now: () => 1_800_000_000_000 + 60_000,
          createRepo: (context) => {
            entered++
            return new GitMemoryRepo({ dir: context.identityPaths.repo, agentId: context.identity })
          },
        },
      }),
    )

    // when
    await f.context("second")
    await until(() => entered === 1, 30_000)
    await second()

    // then
    const [stamp] = maintenanceStamps(f.env.OMO_MEMORY_HOME ?? "")
    expect(JSON.parse(readFileSync(stamp ?? "", "utf8"))).toEqual({ version: 1, attemptedAt: 1_800_000_000_000 })
  })
})

const DAY = 24 * 60 * 60 * 1000

/** The one durable identity root (`<memory home>/agents/<id>`, owning a `repo/`). */
function identityRoot(home: string): string {
  const agents = join(home, "agents")
  const [id] = readdirSync(agents).filter((name) => existsSync(join(agents, name, "repo")))
  if (id === undefined) throw new Error("no durable identity")
  return join(agents, id)
}

function age(path: string, ms: number): void {
  const at = new Date(Date.now() - ms)
  utimesSync(path, at, at)
}

function foldedRun(runs: string, runId: string, days: number): string {
  const dir = join(runs, runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "final.json"),
    JSON.stringify({ runId, outcome: "merged", finishedAt: new Date(Date.now() - days * DAY).toISOString() }),
  )
  age(join(dir, "final.json"), days * DAY)
  age(dir, days * DAY)
  return dir
}

async function reflectedJournal(transcripts: string, sessionID: string): Promise<string> {
  const dir = join(transcripts, sessionID)
  const journal = new TranscriptJournal({ journalDir: dir, now: () => new Date(Date.now() - 20 * DAY) })
  await journal.reconcile([
    { kind: "user", messageId: `${sessionID}-u1`, text: "first" },
    { kind: "assistant", messageId: `${sessionID}-a1`, textBlocks: ["first answer"] },
  ])
  const snapshot = await journal.captureReflectionSnapshot()
  if (snapshot === null) throw new Error("expected a snapshot")
  await journal.finalizeReflection(snapshot, true)
  for (const name of ["state.json", "transcript.jsonl"]) age(join(dir, name), 20 * DAY)
  age(dir, 20 * DAY)
  return dir
}

/** A pid that is provably gone: a child that was started and killed. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" })
  const pid = child.pid
  if (pid === undefined) throw new Error("child did not start")
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  child.kill("SIGKILL")
  await exited
  return pid
}

/** `<memory home>/transient-runs/<token>` left by a crashed one-shot run: dead owner pid, idle for two days. */
async function crashedTransientRun(home: string, name: string): Promise<string> {
  const run = join(home, "transient-runs", `${(Date.now() - 2 * DAY).toString(36)}-${await deadPid()}-${name}`)
  const transcripts = join(run, "agents", "one-shot", "runtime", "transcripts")
  mkdirSync(transcripts, { recursive: true })
  for (const path of [transcripts, join(transcripts, ".."), join(run, "agents", "one-shot"), join(run, "agents"), run])
    age(path, 2 * DAY)
  return run
}

describe("runtime retention, size cap and transient sweep in V2 maintenance (followups 1, 6)", () => {
  test("#given memory.runtime.max_bytes 1, a folded run past its window and a live session journal #when a root session binds #then one runtime retention line is logged, the old run is removed, omo.retentionAt is stamped and the live journal stays", async () => {
    // given
    const f = createMemoryFixture({ runtime: { max_bytes: 1 } })
    fixtures.push(f)
    const home = f.env.OMO_MEMORY_HOME ?? ""
    await seededRoot(f)
    const root = identityRoot(home)
    const runs = join(root, "runtime", "reflection", "runs")
    const oldRun = foldedRun(runs, "reflection-run-1", 8)
    foldedRun(runs, "reflection-run-2", 1)
    const live = await reflectedJournal(join(root, "runtime", "transcripts"), "root")
    const gone = await reflectedJournal(join(root, "runtime", "transcripts"), "gone")
    const info: { message: string; details?: Record<string, unknown> }[] = []
    const cleanup = await registerMemoryComponent(
      f.host,
      f.options({
        logger: {
          warn: () => undefined,
          info: (message, details) => info.push({ message, ...(details === undefined ? {} : { details }) }),
        },
        maintenance: { delayMs: 0 },
      }),
    )
    const repo = new GitMemoryRepo({ dir: join(root, "repo"), agentId: "fixture" })

    // when
    await f.context("root")
    await until(async () => (await repo.configGet("omo.retentionAt")) !== null, 30_000)
    await cleanup()

    // then
    const lines = info.filter((entry) => entry.message === "memory runtime retention")
    expect(lines).toHaveLength(1)
    expect(lines[0]?.details?.capBytes).toBe(1)
    expect(existsSync(oldRun)).toBe(false)
    expect(Number(await repo.configGet("omo.retentionAt"))).toBeGreaterThan(Date.now() - 60 * 60 * 1000)
    expect(existsSync(join(live, "transcript.jsonl"))).toBe(true)
    expect(existsSync(join(gone, "transcript.jsonl"))).toBe(false)
  })

  test("#given a crashed transient run under the memory root #when a root session binds #then it is reclaimed after the bind, and a second bind the same day schedules no sweep", async () => {
    // given
    const f = fixture()
    const home = f.env.OMO_MEMORY_HOME ?? ""
    await seededRoot(f)
    const crashed = await crashedTransientRun(home, "first")
    const first = await registerMemoryComponent(f.host, f.options({ maintenance: { delayMs: 60_000 } }))

    // when
    await f.context("root")
    const presentAtBind = existsSync(crashed)
    await until(() => !existsSync(crashed), 30_000)
    await first()
    const again = await crashedTransientRun(home, "again")
    f.addSession("second")
    const second = await registerMemoryComponent(
      f.host,
      f.options({ maintenance: { delayMs: 0, transientSweepDeferMs: 0 } }),
    )
    const repo = new GitMemoryRepo({ dir: join(identityRoot(home), "repo"), agentId: "fixture" })
    await f.context("second")
    await until(async () => (await repo.configGet("omo.retentionAt")) !== null, 30_000)
    await second()

    // then
    expect(presentAtBind).toBe(true)
    expect(existsSync(crashed)).toBe(false)
    expect(existsSync(again)).toBe(true)
  })
})
