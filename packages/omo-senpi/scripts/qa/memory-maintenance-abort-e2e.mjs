#!/usr/bin/env bun
// Live proof that a memory repo maintenance pass stopped by session shutdown leaves nothing behind, against
// the REAL senpi binary running the built plugin and a mock provider on 127.0.0.1 (no network, no keys).
//
//   1. A seed RPC session writes one memory note, so the identity owns a durable git repo.
//   2. The repo gets `--loose-objects` (default 40000) loose blobs, far past the 2000 the pass packs at, so
//      `git maintenance run --task=loose-objects` and its pack-objects take seconds.
//   3. A second RPC session binds, which schedules the pass after the scheduler's own 30 s delay. The lane
//      waits until a `git maintenance` or `pack-objects` process is running under that session, records it,
//      and shuts the session down while it still runs: shutdown disposes the scheduler, which aborts git.
//   4. After senpi has exited, every git process recorded under it must be gone, and the sandbox must be
//      removable at once (no retry): a surviving git descendant fails this with EBUSY/EPERM on Windows.
//   5. The real ~/.senpi/agent and ~/.omo/agent digests must match before and after, and the real memory
//      home must never gain this lane's identity. (~/.omo/memory itself is recorded, not compared: a host
//      running live omo sessions keeps writing its own identities there.)
//
// Run: `bun packages/omo-senpi/scripts/qa/memory-maintenance-abort-e2e.mjs --evidence-dir <dir>
//       [--loose-objects <n>] [--senpi-cli <cli.js>]`. Exit 0 only when every check passes.
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join, relative } from "node:path"
import { deflateSync } from "node:zlib"

import {
  assertSandboxEnv,
  createRouter,
  DEFAULT_PLUGIN_ROOT,
  DEFAULT_SENPI_CLI,
  getState,
  identityDirs,
  isAlive,
  launchRpc,
  prepareSandbox,
  prompt,
  resolveCommand,
  sandboxEnv,
  teardown,
  waitForExit,
  writeEvidence,
} from "./kibitzer-sidecar-support.mjs"
import { startMockCompletionsServer } from "./mock-completions-server.mjs"
import { withTelemetryOptOut } from "./telemetry-opt-out-env.mjs"

const IDENTITY = "maintenance-abort-qa"
const PASS_START_DEADLINE_MS = 120_000
const POLL_MS = 250
// How long the lane watches for senpi's own exit after its input ends; the run records the real duration.
const NATURAL_EXIT_WINDOW_MS = 60_000
const checks = []

function record(name, ok, detail) {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` :: ${detail}`}`)
  return ok
}

function parseArgs(argv) {
  const options = { looseObjects: 40_000, senpiCli: DEFAULT_SENPI_CLI }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const value = argv[index + 1]
    if (arg === "--evidence-dir" && value !== undefined) options.evidenceDir = argv[++index]
    else if (arg === "--loose-objects" && value !== undefined) options.looseObjects = Number(argv[++index])
    else if (arg === "--senpi-cli" && value !== undefined) options.senpiCli = argv[++index]
    else throw new Error(`Invalid argument: ${arg}`)
  }
  if (options.evidenceDir === undefined) throw new Error("--evidence-dir is required")
  if (!Number.isInteger(options.looseObjects) || options.looseObjects < 2_001)
    throw new Error("--loose-objects must be an integer above the 2000 the pass packs at")
  return options
}

// Volatile files a run may legitimately rewrite in a real agent dir it never touches (same list as memory-e2e).
const VOLATILE = new Set([
  "sessions",
  "senpi-debug.log",
  "mcp-cache.json",
  "mcp-auth",
  "settings.json",
  "telemetry.log",
  "goals",
])

function digest(root) {
  if (!existsSync(root)) return "absent"
  const hash = createHash("sha256")
  const walk = (dir) => {
    for (const name of readdirSync(dir).toSorted()) {
      if (VOLATILE.has(name)) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else hash.update(name).update(readFileSync(full))
    }
  }
  walk(root)
  return hash.digest("hex")
}

/** `relative path -> { sha256, endpoint? }` for every non-volatile file under `root`. */
function manifest(root) {
  const files = new Map()
  if (!existsSync(root)) return files
  const walk = (dir) => {
    for (const name of readdirSync(dir).toSorted()) {
      if (VOLATILE.has(name)) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      const bytes = readFileSync(full)
      const rel = relative(root, full).replaceAll("\\", "/")
      files.set(rel, { sha256: createHash("sha256").update(bytes).digest("hex"), endpoint: endpointOwner(rel, bytes) })
    }
  }
  walk(root)
  return files
}

// An OpenCode 2 server registers itself at `gateway/opencode-v2-endpoints/<instance>.json` with its own pid
// and the directory it serves. Only the owner fields are kept; the registration's secret never is.
function endpointOwner(rel, bytes) {
  if (!/^gateway\/opencode-v2-endpoints\/[^/]+\.json$/.test(rel)) return undefined
  try {
    const parsed = JSON.parse(bytes.toString("utf8"))
    return typeof parsed.pid === "number" && typeof parsed.directory === "string"
      ? { pid: parsed.pid, directory: parsed.directory }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Real agent-home paths that changed during the run, each attributed. A change is the host's own when it is an
 * OpenCode 2 endpoint registration whose owner pid is not in the lane's process tree and whose directory is
 * outside the sandbox (this lane starts no OpenCode server). Anything else is unattributed and fails isolation.
 */
function attributeChanges(before, after, lanePids, sandboxRoot) {
  const changes = []
  for (const rel of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(rel)
    const now = after.get(rel)
    if (was?.sha256 === now?.sha256) continue
    const owner = now?.endpoint ?? was?.endpoint
    const hostOwned = owner !== undefined && !lanePids.has(owner.pid) && !owner.directory.startsWith(sandboxRoot)
    changes.push({
      path: rel,
      change: was === undefined ? "added" : now === undefined ? "removed" : "modified",
      owner,
      attribution: hostOwned ? "host OpenCode 2 endpoint outside the lane" : "UNATTRIBUTED",
    })
  }
  return changes
}

const REAL_AGENT_HOMES = [join(homedir(), ".senpi", "agent"), join(homedir(), ".omo", "agent")]
const REAL_MEMORY_HOME = join(homedir(), ".omo", "memory")

function laneIdentitiesIn(memoryHome) {
  const agents = join(memoryHome, "agents")
  return existsSync(agents) ? readdirSync(agents).filter((name) => name.startsWith(IDENTITY)) : []
}

/** Every process on the host: `{ pid, ppid, command }`. */
function processTable() {
  if (process.platform === "win32") {
    return execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }',
      ],
      { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: withTelemetryOptOut(process.env) },
    )
      .split(/\r?\n/)
      .map((line) => line.split("\t"))
      .filter((cols) => cols.length >= 3)
      .map(([pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command: command ?? "" }))
  }
  return execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((match) => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }))
}

const isMaintenanceGit = (row) => /maintenance run|pack-objects|prune-packed/.test(row.command)
const isGit = (row) => /(?:^|[\\/\s"])git(?:\.exe)?(?:["\s]|$)/i.test(row.command)

/** Writes `count` unique loose blobs straight into the repository's object store. */
function seedLooseObjects(repo, count) {
  const objects = join(repo, ".git", "objects")
  for (let index = 0; index < count; index++) {
    const body = Buffer.from(`maintenance-abort-qa loose object ${index} ${"x".repeat(index % 113)}\n`)
    const raw = Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])
    const id = createHash("sha1").update(raw).digest("hex")
    const dir = join(objects, id.slice(0, 2))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, id.slice(2)), deflateSync(raw))
  }
  return looseCount(repo)
}

function looseCount(repo) {
  const counted = execFileSync("git", ["count-objects", "-v"], { cwd: repo, encoding: "utf8" })
  return Number(/^count: (\d+)$/m.exec(counted)?.[1] ?? 0)
}

function debugLogLines(sandbox, pattern) {
  const file = join(sandbox.agentDir, "senpi-debug.log")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => pattern.test(line))
    .slice(-40)
}

function writeConfig(sandbox) {
  writeFileSync(
    join(sandbox.cwd, ".omo", "omo.json"),
    `${JSON.stringify(
      {
        memory: {
          enabled: true,
          agent: IDENTITY,
          recall: { enabled: false },
          facts: { enabled: false },
          dream: { enabled: false },
          reflection: { trigger: { step_count: 0, on_compaction: false } },
        },
      },
      null,
      2,
    )}\n`,
  )
}

/**
 * Every process ever seen below senpi, tracked by parent pid. Each sample walks the tree from senpi AND from
 * every pid already known, so a child whose parent has died is still followed: Windows keeps the dead
 * parent's pid in its children's ParentProcessId. On Linux an orphan is reparented, so a sample there also
 * takes any process whose cwd lies in the sandbox. A pid counts as a survivor only while it is alive with
 * the same command line it was first seen with (no pid reuse).
 */
function createTreeTracker(rootPid, sandboxRoot) {
  const started = Date.now()
  const known = new Map()
  const samples = []
  const inSandboxByCwd = () => {
    if (process.platform !== "linux") return new Set()
    const pids = new Set()
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue
      try {
        if (readlinkSync(`/proc/${name}/cwd`).startsWith(sandboxRoot)) pids.add(Number(name))
      } catch {
        // gone, or another user's process
      }
    }
    return pids
  }
  const sample = (phase) => {
    const table = processTable()
    const tree = new Set([rootPid, ...known.keys(), ...inSandboxByCwd()])
    for (let grew = true; grew;) {
      grew = false
      for (const row of table)
        if (tree.has(row.ppid) && !tree.has(row.pid)) {
          tree.add(row.pid)
          grew = true
        }
    }
    const atMs = Date.now() - started
    const live = []
    for (const row of table) {
      if (row.pid === rootPid || row.pid === process.pid || !tree.has(row.pid)) continue
      const seen = known.get(row.pid)
      if (seen === undefined) known.set(row.pid, { ...row, firstSeenMs: atMs, firstSeenPhase: phase, lastSeenMs: atMs })
      else if (seen.command === row.command) seen.lastSeenMs = atMs
      else continue
      live.push(row.pid)
    }
    samples.push({ atMs, phase, live })
    return table
  }
  const survivors = (table) =>
    [...known.values()].filter((entry) => table.some((row) => row.pid === entry.pid && row.command === entry.command))
  // A process alive in a sample while its parent, also tracked, is already gone from that sample: what a
  // stop that ends only git's launcher leaves behind (the real git and pack-objects running on).
  const orphans = () =>
    samples.flatMap((entry) =>
      entry.live
        .map((pid) => known.get(pid))
        .filter((row) => known.has(row.ppid) && !entry.live.includes(row.ppid))
        .map((row) => ({ atMs: entry.atMs, phase: entry.phase, pid: row.pid, ppid: row.ppid, command: row.command })),
    )
  return { sample, survivors, orphans, known: () => [...known.values()], samples }
}

async function waitForMaintenanceGit(session, tracker) {
  const deadline = Date.now() + PASS_START_DEADLINE_MS
  for (;;) {
    tracker.sample("before-pass")
    const running = tracker.known().filter((entry) => isMaintenanceGit(entry))
    if (running.length > 0) return running
    if (session.child.exitCode !== null) throw new Error("senpi exited before the maintenance pass started")
    if (Date.now() > deadline)
      throw new Error(
        `no maintenance git under senpi within ${PASS_START_DEADLINE_MS}ms; seen=${JSON.stringify(tracker.known())}`,
      )
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  mkdirSync(options.evidenceDir, { recursive: true })
  const facts = { platform: process.platform, looseObjects: options.looseObjects }
  const homesBefore = Object.fromEntries(REAL_AGENT_HOMES.map((home) => [home, manifest(home)]))
  const memoryBefore = { digest: digest(REAL_MEMORY_HOME), laneIdentities: laneIdentitiesIn(REAL_MEMORY_HOME) }
  const router = createRouter()
  const server = startMockCompletionsServer({ steps: router.steps, classifyRequest: router.classify })
  let sandbox
  const live = []
  try {
    const command = resolveCommand({ senpiCli: options.senpiCli })
    facts.command = command.display
    facts.pluginRoot = DEFAULT_PLUGIN_ROOT
    const baseUrl = await server.ready
    sandbox = prepareSandbox(DEFAULT_PLUGIN_ROOT, baseUrl)
    facts.sandboxRoot = sandbox.root
    writeConfig(sandbox)
    const env = sandboxEnv(sandbox)
    assertSandboxEnv(sandbox, env)

    router.setParentSteps([
      {
        type: "tool_call",
        name: "memory",
        arguments: {
          command: "create",
          file_path: "system/notes.md",
          description: "Maintenance abort QA notes",
          file_text: "the maintenance abort lane seeded this note",
          reason: "seed the identity repo for the maintenance abort lane",
        },
      },
      { type: "text", text: "memory seeded" },
    ])
    const seed = launchRpc(command, sandbox, env)
    live.push(seed)
    await getState(seed)
    await prompt(seed, "Write down a note for later.")
    facts.seedTeardown = await teardown(seed)
    const identities = identityDirs(sandbox.memoryHome).filter((dir) => existsSync(join(dir, "repo", ".git")))
    facts.identities = identities
    if (!record("identity repo seeded", identities.length === 1, JSON.stringify(identities))) return facts
    const repo = join(identities[0], "repo")
    const stampBefore = existsSync(join(identities[0], "runtime", "maintenance.json"))
    record("no maintenance stamp before the pass", !stampBefore)

    const loose = seedLooseObjects(repo, options.looseObjects)
    facts.looseObjectsCounted = loose
    record("loose objects seeded past the packing threshold", loose >= options.looseObjects, `count=${loose}`)

    router.setParentSteps([{ type: "text", text: "idle" }])
    const session = launchRpc(command, sandbox, env)
    live.push(session)
    const state = await getState(session)
    facts.sessionId = state.sessionId
    facts.senpiPid = session.pid
    const started = Date.now()
    const tracker = createTreeTracker(session.pid, sandbox.root)
    facts.processTree = { samples: tracker.samples }
    const maintenanceAtPass = await waitForMaintenanceGit(session, tracker)
    facts.passStartedAfterMs = Date.now() - started
    record(
      "maintenance git running under the live session",
      maintenanceAtPass.length > 0,
      maintenanceAtPass.map((row) => `${row.pid} ${row.command.slice(0, 120)}`).join(" | "),
    )
    // One more walk right before shutdown, so a pack worker git has just started is in the tree too.
    const aliveAtShutdown = tracker.survivors(tracker.sample("at-shutdown")).filter(isGit)
    facts.gitAliveAtShutdown = aliveAtShutdown.map((row) => `${row.pid} ${row.command.slice(0, 120)}`)
    record(
      "the pass is still running when shutdown starts",
      aliveAtShutdown.some(isMaintenanceGit),
      facts.gitAliveAtShutdown.join(" | "),
    )

    // Shutdown exactly as a host closing the RPC channel does: input ends, senpi runs its own shutdown.
    // The tree keeps being sampled until senpi has exited, so anything git starts during the stop is tracked.
    const shutdownStarted = Date.now()
    session.child.stdin.end()
    const exited = waitForExit(session.child, NATURAL_EXIT_WINDOW_MS)
    let exitedOnItsOwn
    exited.then((value) => {
      exitedOnItsOwn = value
    })
    while (exitedOnItsOwn === undefined) {
      tracker.sample("during-shutdown")
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    facts.shutdownMs = Date.now() - shutdownStarted
    facts.sessionExit = exitedOnItsOwn
      ? { code: session.child.exitCode, signal: session.child.signalCode }
      : "did not exit"
    facts.sessionStderrTail = session.stderr().slice(-2000)
    facts.debugLogMemoryLines = debugLogLines(sandbox, /maintenance|shutdown|memory/i)
    record(
      "senpi exited on its own shutdown after its input ended",
      exitedOnItsOwn,
      `after ${facts.shutdownMs}ms exit=${JSON.stringify(facts.sessionExit)}`,
    )
    // Two walks after exit: anything still alive below any pid ever seen, orphans included.
    tracker.sample("after-exit")
    const afterExit = tracker.sample("after-exit-confirm")
    const everSeen = tracker.known()
    const survivors = tracker.survivors(afterExit)
    facts.processTree.everSeen = everSeen
    facts.processTree.gitEverSeen = everSeen.filter(isGit)
    facts.processTree.survivorsAfterExit = survivors
    facts.gitSurvivorsAfterExit = survivors.filter(isGit)
    const strays = afterExit.filter((row) => row.command.includes(repo) || row.command.includes(sandbox.root))
    facts.processesNamingTheSandboxAfterExit = strays
    record(
      "every git process seen in senpi's tree (pack-objects included) is gone after its exit",
      facts.gitSurvivorsAfterExit.length === 0,
      facts.gitSurvivorsAfterExit.length === 0
        ? `tracked ${facts.processTree.gitEverSeen.length} git pids over ${tracker.samples.length} tree samples: ${facts.processTree.gitEverSeen.map((row) => `${row.pid} ${row.command.slice(0, 60)}`).join(" | ")}`
        : JSON.stringify(facts.gitSurvivorsAfterExit),
    )
    const orphanedGit = tracker.orphans().filter(isGit)
    facts.processTree.orphanedGit = orphanedGit
    record(
      "no git process ever outlived its parent in senpi's tree (the stop ended git's whole tree at once)",
      orphanedGit.length === 0,
      orphanedGit.length === 0
        ? `checked ${tracker.samples.length} samples`
        : orphanedGit
            .map((row) => `+${row.atMs}ms ${row.phase} ${row.pid}<-${row.ppid} ${row.command.slice(0, 60)}`)
            .join(" | "),
    )
    record(
      "no process of senpi's tree survives its exit",
      survivors.length === 0,
      survivors.length === 0 ? `tracked ${everSeen.length} pids` : JSON.stringify(survivors),
    )
    record("no process names the sandbox after exit", strays.length === 0, JSON.stringify(strays))
    const looseAfter = looseCount(repo)
    facts.looseObjectsAfterExit = looseAfter
    record(
      "the pass was stopped, not finished (loose objects still unpacked)",
      looseAfter >= 2_000,
      `count before=${loose} after=${looseAfter}`,
    )
    try {
      rmSync(sandbox.root, { recursive: true, force: true })
      record("sandbox removed at once, no retry", !existsSync(sandbox.root), sandbox.root)
    } catch (error) {
      record("sandbox removed at once, no retry", false, error instanceof Error ? error.message : String(error))
    }
    return facts
  } catch (error) {
    record("uncaught", false, error instanceof Error ? (error.stack ?? error.message) : String(error))
    return facts
  } finally {
    for (const session of live) facts[`cleanup-${session.pid}`] = await teardown(session)
    server.close()
    for (const row of facts.processTree?.survivorsAfterExit ?? []) {
      if (!(row.pid > 0) || !isAlive(row.pid)) continue
      try {
        if (process.platform === "win32")
          execFileSync("taskkill", ["/PID", String(row.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
        else process.kill(row.pid, "SIGKILL")
        facts[`cleanup-survivor-${row.pid}`] = "ended"
      } catch (error) {
        facts[`cleanup-survivor-${row.pid}`] = error instanceof Error ? error.message : String(error)
      }
    }
    if (sandbox !== undefined && existsSync(sandbox.root)) {
      // Cleanup after a failed run only: the verdict above was already recorded.
      for (const row of processTable().filter((entry) => entry.pid > 0 && entry.command.includes(sandbox.root))) {
        facts[`cleanup-stray-${row.pid}`] = row.command
        try {
          if (process.platform === "win32")
            execFileSync("taskkill", ["/PID", String(row.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
          else process.kill(row.pid, "SIGKILL")
        } catch (error) {
          facts[`cleanup-stray-${row.pid}-error`] = error instanceof Error ? error.message : String(error)
        }
      }
      try {
        rmSync(sandbox.root, { recursive: true, force: true })
      } catch (error) {
        facts.cleanupSandboxError = error instanceof Error ? error.message : String(error)
      }
    }
    const lanePids = new Set([
      ...live.map((session) => session.pid),
      ...(facts.processTree?.everSeen ?? []).map((row) => row.pid),
    ])
    const homesAfter = Object.fromEntries(REAL_AGENT_HOMES.map((home) => [home, manifest(home)]))
    const memoryAfter = { digest: digest(REAL_MEMORY_HOME), laneIdentities: laneIdentitiesIn(REAL_MEMORY_HOME) }
    const changes = Object.fromEntries(
      REAL_AGENT_HOMES.map((home) => [
        home,
        attributeChanges(homesBefore[home], homesAfter[home], lanePids, sandbox?.root ?? "\0"),
      ]),
    )
    const unattributed = Object.values(changes)
      .flat()
      .filter((change) => change.attribution === "UNATTRIBUTED")
    facts.realHomes = { changedPaths: changes, lanePids: [...lanePids] }
    facts.realMemoryHome = { path: REAL_MEMORY_HOME, before: memoryBefore, after: memoryAfter }
    record(
      "real ~/.senpi/agent and ~/.omo/agent: no change attributable to the lane",
      unattributed.length === 0,
      `changed=${Object.values(changes).flat().length} unattributed=${JSON.stringify(unattributed)}`,
    )
    record(
      "the real memory home never gained this lane's identity",
      memoryAfter.laneIdentities.length === 0,
      `${REAL_MEMORY_HOME}: ${JSON.stringify(memoryAfter.laneIdentities)}`,
    )
    facts.sandboxLeft = sandbox !== undefined && existsSync(sandbox.root)
    facts.checks = checks
    facts.ok = checks.every((check) => check.ok)
    const file = writeEvidence(options.evidenceDir, `memory-maintenance-abort-${process.platform}.json`, facts)
    console.log(
      JSON.stringify({ ok: facts.ok, evidence: file, failures: checks.filter((check) => !check.ok) }, null, 2),
    )
    process.exitCode = facts.ok ? 0 : 1
  }
}

await main()
