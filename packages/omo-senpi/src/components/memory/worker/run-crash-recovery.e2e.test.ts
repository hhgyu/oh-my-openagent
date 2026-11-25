import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildIdentityPaths,
  readMemoryReceipts,
  receiptIdentity,
  type MemoryKillPoint,
} from "@oh-my-opencode/memory-core"
import {
  getPidLiveness,
  getProcessStartIdentity,
  startIdentitiesComparable,
} from "@oh-my-opencode/memory-core/process-identity"

import { holdProcess, terminateExactProcess } from "../../../../../utils/src/process-sweep/win32-process-handle"

// Every case runs a launcher, a supervisor, a bootstrap and a model child, then an out-of-process
// reconciliation. Synchronisation is on process exit events and durable files, never on time.
setDefaultTimeout(120_000)

const DRIVER = join(import.meta.dir, "__fixtures__", "crash-driver.ts")
const RUN_ID = "run-1"
// Reconciliation leaves a reservation alone for the first minute in case its launcher is still
// writing; the reconcile child starts past that window, as the next session start would.
const PAST_LAUNCH_WINDOW_MS = "61000"
const FINALIZATION_FIELDS = new Set([
  "finalizePhase",
  "validatedTipSha",
  "validatedChangedPaths",
  "integrationSha",
  "finalizeOutcome",
  "finalizeReason",
  "finalizeDetail",
  "finalizedAt",
  "cleanupIncomplete",
])
const EVIDENCE = [
  "prelaunch.json",
  "launch.json",
  "transcript-payload.json",
  "outcome.json",
  "stdout.log",
  "stderr.log",
  "child-stderr.log",
]

const roots: string[] = []
interface TrackedProcess {
  readonly pid: number
  readonly role: string
  readonly processStart: string | null
}
const pids: TrackedProcess[] = []

type ProcessVerdict =
  { readonly kind: "same" } | { readonly kind: "gone" } | { readonly kind: "unknown"; readonly reason: string }
type Survivor = TrackedProcess & Exclude<ProcessVerdict, { readonly kind: "gone" }>
type ProcessProbe = { readonly kind: "dead" } | { readonly kind: "live"; readonly start: string } | null

afterEach(async () => {
  const survivors = await findSurvivors(pids.splice(0))
  for (const survivor of survivors) {
    if (survivor.kind === "same") await terminateSurvivor(survivor)
  }
  expect(
    survivors.map((survivor) => {
      const { pid, role } = survivor
      return survivor.kind === "unknown" ? { pid, role, reason: survivor.reason } : { pid, role }
    }),
  ).toEqual([])
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })),
  )
})

async function findSurvivors(
  tracked: readonly TrackedProcess[],
  observeStart = observeProcessStart,
): Promise<Survivor[]> {
  const results = await Promise.all(
    tracked.map(async (item) => ({ ...item, ...(await classifyProcess(item, observeStart)) })),
  )
  return results.filter((result): result is Survivor => result.kind !== "gone")
}

async function classifyProcess(
  { pid, processStart }: TrackedProcess,
  observeStart = observeProcessStart,
): Promise<ProcessVerdict> {
  if (getPidLiveness(pid) === "dead") return { kind: "gone" }
  const current = await observeStart(pid)
  if (current?.kind === "dead") return { kind: "gone" }
  if (current === null && getPidLiveness(pid) === "dead") return { kind: "gone" }
  if (processStart === null) return { kind: "unknown", reason: "missing recorded start identity" }
  if (current === null) return { kind: "unknown", reason: "could not read current start identity" }

  if (processStart.startsWith("win32-creation-") || current.start.startsWith("win32-creation-")) {
    const recorded = windowsCreationTicks(processStart)
    const actual = windowsCreationTicks(current.start)
    if (recorded !== null && actual !== null) return { kind: recorded === actual ? "same" : "gone" }
  } else if (startIdentitiesComparable(processStart, current.start)) {
    return { kind: processStart === current.start ? "same" : "gone" }
  }
  return { kind: "unknown", reason: "incomparable start identities" }
}

async function observeProcessStart(pid: number): Promise<ProcessProbe> {
  if (process.platform !== "win32") {
    const start = await getProcessStartIdentity(pid)
    return start === null ? null : { kind: "live", start }
  }
  // Read both creation and exit times from a handle to the same Windows process.
  const processHandle = await holdProcess(pid)
  if (processHandle === null) return null
  try {
    return processHandle.exitTicks() === null
      ? { kind: "live", start: `win32-creation-filetime:${processHandle.creationTicks}` }
      : { kind: "dead" }
  } finally {
    processHandle.release()
  }
}

function windowsCreationTicks(identity: string): bigint | null {
  const filetime = /^win32-creation-filetime:(\d+)$/.exec(identity)?.[1]
  if (filetime !== undefined) return BigInt(filetime)
  // The PowerShell fallback writes UTC DateTime.ToString("o") with seven fractional digits.
  const date = /^win32-creation-date:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{7})(?:Z|\+00:00)$/.exec(identity)
  const [, seconds, fraction] = date ?? []
  if (seconds === undefined || fraction === undefined) return null
  const wholeSecondsMs = Date.parse(`${seconds}Z`)
  return Number.isFinite(wholeSecondsMs)
    ? BigInt(wholeSecondsMs) * 10_000n + BigInt(fraction) + 116_444_736_000_000_000n
    : null
}

async function terminateSurvivor(survivor: TrackedProcess & { readonly kind: "same" }): Promise<void> {
  if (process.platform === "win32") {
    // Re-check creation time on the handle used to terminate; a bare PID could be reused after the probe.
    const creation = windowsCreationTicks(survivor.processStart ?? "")
    if (creation !== null) await terminateExactProcess(survivor.pid, creation, 0n)
  } else if ((await classifyProcess(survivor)).kind === "same") {
    try {
      process.kill(survivor.pid, "SIGKILL")
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error
    }
  }
}

test("survivor detection distinguishes matching, reused, and unverifiable process identities", async () => {
  // given
  const child = Bun.spawn([process.execPath, "-e", "process.stdin.resume()"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  })
  try {
    const start = await getProcessStartIdentity(child.pid)
    if (start === null) throw new Error("could not read the live test child's start identity")
    const original = { pid: child.pid, role: "identity fixture", processStart: start }
    const reused = { ...original, processStart: `${start}0` }
    const missing = { ...original, processStart: null }
    const incomparable = { ...original, processStart: "unknown-scheme:1" }

    // when / then
    expect(await findSurvivors([original, reused])).toEqual([{ ...original, kind: "same" }])
    expect({
      missing: await findSurvivors([missing]),
      unreadable: await findSurvivors([original], async () => null),
      incomparable: await findSurvivors([incomparable]),
    }).toMatchObject({
      missing: [{ pid: child.pid, kind: "unknown", reason: "missing recorded start identity" }],
      unreadable: [{ pid: child.pid, kind: "unknown", reason: "could not read current start identity" }],
      incomparable: [{ pid: child.pid, kind: "unknown", reason: "incomparable start identities" }],
    })
    const windowsDate = { ...original, processStart: "win32-creation-date:1970-01-01T00:00:00.1234567Z" }
    expect(
      await findSurvivors([windowsDate], async () => ({
        kind: "live",
        start: "win32-creation-filetime:116444736001234567",
      })),
    ).toEqual([{ ...windowsDate, kind: "same" }])
  } finally {
    child.stdin.end()
    await child.exited
  }
})

interface Hermetic {
  readonly root: string
  readonly env: Readonly<Record<string, string>>
  readonly paths: ReturnType<typeof buildIdentityPaths>
}

async function hermetic(): Promise<Hermetic> {
  const root = await mkdtemp(join(tmpdir(), "memory-crash-recovery-"))
  roots.push(root)
  const home = join(root, "home")
  const temp = join(root, "tmp")
  await mkdir(home, { recursive: true })
  await mkdir(temp, { recursive: true })
  const gitconfig = join(root, "gitconfig")
  await writeFile(gitconfig, "[user]\n\tname = Crash Recovery\n\temail = crash@example.invalid\n")
  const env: Record<string, string> = {}
  for (const name of ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "COMSPEC", "PATHEXT", "WINDIR", "LANG"]) {
    const inherited = process.env[name]
    if (inherited !== undefined) env[name] = inherited
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitconfig,
  })
  return { root, env, paths: buildIdentityPaths(root, "agent-test") }
}

interface Exit {
  readonly pid: number
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
}

async function drive(item: Hermetic, args: readonly string[], killPoint?: MemoryKillPoint): Promise<Exit> {
  const env: Record<string, string> = { ...item.env }
  if (killPoint !== undefined) env.OMO_MEMORY_KILL_POINT = killPoint
  const child = spawn(process.execPath, [DRIVER, "--root", item.root, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const pid = child.pid
  if (pid === undefined) throw new Error("driver did not start")
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const completion = new Promise<Exit>((resolve, reject) => {
    const bound = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`driver ${args.join(" ")} did not exit\n${stdout}\n${stderr}`))
    }, 100_000)
    child.on("error", reject)
    child.on("close", (code, signal) => {
      clearTimeout(bound)
      resolve({ pid, code, signal, stdout, stderr })
    })
  })
  const record = getProcessStartIdentity(pid).then((processStart) => {
    pids.push({ pid, role: `driver ${args.join(" ")}`, processStart })
  })
  const [exit] = await Promise.all([completion, record])
  return exit
}

function expectKilled(exit: Exit): void {
  // A driver that finishes instead of dying never reached its kill point; its report says which path it took.
  if (exit.code === 0 && exit.signal === null)
    throw new Error(`the driver exited 0 instead of being killed\n${exit.stdout}\n${exit.stderr.slice(-4000)}`)
  if (process.platform === "win32") {
    expect(exit.signal).toBeNull()
    expect(exit.code).not.toBe(0)
  } else {
    expect({ signal: exit.signal, stderr: exit.stderr }).toMatchObject({ signal: "SIGKILL" })
  }
}

function expectSupervisorKilled(exit: Exit): void {
  expect(exit.stdout).toMatch(
    process.platform === "win32"
      ? /supervisor-exit: memory run supervisor exited with [1-9]/
      : /supervisor-exit: memory run supervisor exited with SIGKILL/,
  )
}

async function reconcile(item: Hermetic, extra: readonly string[] = []): Promise<Exit> {
  const exit = await drive(item, ["--reconcile", "--now-offset-ms", PAST_LAUNCH_WINDOW_MS, ...extra])
  expect({ code: exit.code, stderr: exit.stderr }).toMatchObject({ code: 0 })
  return exit
}

function runDir(item: Hermetic): string {
  return join(item.paths.reflection, "runs", RUN_ID)
}

async function snapshotRun(item: Hermetic): Promise<Map<string, string>> {
  const dir = runDir(item)
  if (!existsSync(dir)) return new Map()
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
  return new Map(await Promise.all(names.map(async (name) => [name, await readFile(join(dir, name), "utf8")] as const)))
}

/** In write order: the reader returns the newest receipt first. */
async function terminalEvents(item: Hermetic): Promise<string[]> {
  const { receipts } = await readMemoryReceipts(item.paths.runtime, {})
  return [...receipts]
    .reverse()
    .filter((receipt) => receipt.kind !== "facts" && receipt.runId === RUN_ID && receipt.event !== "launched")
    .map((receipt) => receipt.event)
}

function omoRunCommits(item: Hermetic): number {
  const log = execFileSync("git", ["-C", item.paths.repo, "log", "--format=%B", "HEAD"], {
    env: item.env,
    encoding: "utf8",
  })
  return log.split("\n").filter((line) => line.trim() === `Omo-Run: ${RUN_ID}`).length
}

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
}

async function recordProcesses(item: Hermetic): Promise<void> {
  const ledgerPath = join(runDir(item), "ledger.json")
  if (!existsSync(ledgerPath)) return
  const ledger = await json(ledgerPath)
  if (typeof ledger.pid === "number") {
    pids.push({
      pid: ledger.pid,
      role: "ledger supervisor",
      processStart: typeof ledger.processStart === "string" ? ledger.processStart : null,
    })
  }
  if (typeof ledger.childPid === "number") {
    pids.push({
      pid: ledger.childPid,
      role: "ledger child",
      processStart: typeof ledger.childProcessStart === "string" ? ledger.childProcessStart : null,
    })
  }
}

async function expectEvidencePreserved(item: Hermetic, before: Map<string, string>): Promise<void> {
  const after = await snapshotRun(item)
  for (const name of EVIDENCE) {
    if (!before.has(name)) continue
    expect({ name, content: after.get(name) }).toEqual({ name, content: before.get(name) })
  }
  const ledgerBefore = before.get("ledger.json")
  const ledgerAfter = after.get("ledger.json")
  if (ledgerBefore === undefined) return
  if (ledgerAfter === undefined) throw new Error("ledger.json disappeared")
  const identity = (text: string) =>
    Object.fromEntries(
      Object.entries(JSON.parse(text) as Record<string, unknown>).filter(([key]) => !FINALIZATION_FIELDS.has(key)),
    )
  expect(identity(ledgerAfter)).toEqual(identity(ledgerBefore))
}

interface Row {
  readonly name: string
  readonly point: MemoryKillPoint
  readonly child?: "commit" | "noop" | "commit-fail" | "commit-hang" | "commit-late-ok"
  readonly deadlineMs?: number
  readonly killSelf?: boolean
  readonly killed: "launcher" | "supervisor" | "supervisor-and-launcher"
  readonly terminal:
    | { readonly file: "abandoned.json"; readonly reason: string }
    | { readonly file: "final.json"; readonly outcome: string; readonly reason?: string }
  readonly events: readonly string[]
  readonly commits: 0 | 1
}

const ROWS: readonly Row[] = [
  {
    name: "after-reserve",
    point: "after-reserve",
    killed: "launcher",
    terminal: { file: "abandoned.json", reason: "launch_interrupted" },
    events: ["abandoned"],
    commits: 0,
  },
  {
    name: "after-prelaunch",
    point: "after-prelaunch",
    killed: "launcher",
    terminal: { file: "abandoned.json", reason: "launch_interrupted" },
    events: ["abandoned"],
    commits: 0,
  },
  {
    name: "after-worktree",
    point: "after-worktree",
    killed: "launcher",
    terminal: { file: "abandoned.json", reason: "launch_interrupted" },
    events: ["abandoned"],
    commits: 0,
  },
  {
    name: "after-child-exit with the launcher alive",
    point: "after-child-exit",
    killed: "supervisor",
    terminal: { file: "final.json", outcome: "merged" },
    events: ["recovered", "merged"],
    commits: 1,
  },
  {
    name: "after-child-exit with the launcher dead too",
    point: "after-child-exit",
    killSelf: true,
    killed: "supervisor-and-launcher",
    terminal: { file: "final.json", outcome: "merged" },
    events: ["recovered", "merged"],
    commits: 1,
  },
  {
    name: "after-validate",
    point: "after-validate",
    killed: "launcher",
    terminal: { file: "final.json", outcome: "merged" },
    events: ["recovered", "merged"],
    commits: 1,
  },
  {
    name: "after-merge",
    point: "after-merge",
    killed: "launcher",
    terminal: { file: "final.json", outcome: "merged" },
    events: ["recovered", "merged"],
    commits: 1,
  },
  {
    name: "before-receipt",
    point: "before-receipt",
    killed: "launcher",
    terminal: { file: "final.json", outcome: "merged" },
    events: ["merged"],
    commits: 1,
  },
  {
    name: "after-child-exit control: the child committed nothing",
    point: "after-child-exit",
    child: "noop",
    killed: "supervisor",
    terminal: { file: "final.json", outcome: "failed", reason: "supervisor_failed" },
    events: ["failed"],
    commits: 0,
  },
  {
    name: "after-child-exit: the child committed then exited 1",
    point: "after-child-exit",
    child: "commit-fail",
    killed: "supervisor",
    terminal: { file: "final.json", outcome: "failed", reason: "supervisor_failed" },
    events: ["failed"],
    commits: 0,
  },
  {
    name: "after-child-exit: the child committed then ran past its deadline",
    point: "after-child-exit",
    child: "commit-hang",
    deadlineMs: 4_000,
    killed: "supervisor",
    terminal: { file: "final.json", outcome: "failed", reason: "supervisor_failed" },
    events: ["failed"],
    commits: 0,
  },
  {
    name: "after-child-exit: the child committed and exited 0 only after its deadline",
    point: "after-child-exit",
    child: "commit-late-ok",
    deadlineMs: 4_000,
    killed: "supervisor",
    terminal: { file: "final.json", outcome: "failed", reason: "supervisor_failed" },
    events: ["failed"],
    commits: 0,
  },
]

describe("memory run crash recovery at every kill point", () => {
  for (const row of ROWS) {
    test(`#given a run killed at ${row.name} #when reconciled in a fresh process #then it settles once with its evidence intact`, async () => {
      // given
      const item = await hermetic()
      const run = await drive(
        item,
        [
          "--run",
          ...(row.child === undefined ? [] : ["--child", row.child]),
          ...(row.deadlineMs === undefined ? [] : ["--deadline-ms", String(row.deadlineMs)]),
          ...(row.killSelf === true ? ["--kill-self-after-supervisor-exit"] : []),
        ],
        row.point,
      )
      await recordProcesses(item)
      if (row.killed === "supervisor") {
        expectSupervisorKilled(run)
        expect({ code: run.code, stderr: run.stderr }).toMatchObject({ code: 0 })
      } else {
        expectKilled(run)
        if (row.killed === "supervisor-and-launcher") expectSupervisorKilled(run)
      }
      const reservation = existsSync(join(item.paths.reflection, "active.lock"))
        ? await json(join(item.paths.reflection, "active.lock"))
        : undefined
      const before = await snapshotRun(item)

      // when
      await reconcile(item)

      // then
      const terminal = await json(join(runDir(item), row.terminal.file))
      if (row.terminal.file === "abandoned.json") {
        expect(terminal).toMatchObject({
          version: 1,
          runId: RUN_ID,
          reason: row.terminal.reason,
          kind: "reflection",
          trigger: "step-count",
          generation: reservation?.reservedAt,
        })
        expect(existsSync(join(runDir(item), "ledger.json"))).toBe(false)
      } else {
        expect(terminal).toMatchObject({
          outcome: row.terminal.outcome,
          ...(row.terminal.reason === undefined ? {} : { reason: row.terminal.reason }),
        })
      }
      expect(await terminalEvents(item)).toEqual([...row.events])
      expect(omoRunCommits(item)).toBe(row.commits)
      expect(existsSync(join(item.paths.reflection, "active.lock"))).toBe(false)
      await expectEvidencePreserved(item, before)
    })
  }

  for (const [label, point, dream] of [
    ["a reflection run killed after-reserve", "after-reserve", false],
    ["a dream run killed after-prelaunch", "after-prelaunch", true],
  ] as const) {
    test(`#given ${label} whose abandoned receipt write is lost #when reconciled again #then exactly one receipt carries the sentinel's identity`, async () => {
      // given
      const item = await hermetic()
      expectKilled(await drive(item, ["--run", ...(dream ? ["--dream"] : [])], point))
      const lost = await reconcile(item, ["--fail-receipt", "abandoned"])
      const sentinel = await json(join(runDir(item), "abandoned.json"))
      const afterLoss = await terminalEvents(item)

      // when
      await reconcile(item)

      // then
      expect(lost.stdout).toContain("injected receipt loss for abandoned")
      expect(afterLoss).toEqual([])
      expect(sentinel).toMatchObject(
        dream ? { kind: "dream", trigger: "dream", origin: "idle" } : { kind: "reflection", trigger: "step-count" },
      )
      const { receipts } = await readMemoryReceipts(item.paths.runtime, {})
      const written = receipts.filter(
        (receipt) => receipt.kind !== "facts" && receipt.runId === RUN_ID && receipt.event === "abandoned",
      )
      expect(written).toHaveLength(1)
      const [receipt] = written
      if (receipt === undefined || receipt.kind === "facts") throw new Error("expected one run receipt")
      expect(receipt.kind).toBe(dream ? "dream" : "reflection")
      expect(
        receiptIdentity({
          kind: receipt.kind,
          runId: receipt.runId,
          event: receipt.event,
          generation: receipt.generation,
        }),
      ).toBe(
        receiptIdentity({
          kind: dream ? "dream" : "reflection",
          runId: RUN_ID,
          event: "abandoned",
          generation: String(sentinel.generation),
        }),
      )
    })
  }
})
