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
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
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
      { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
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

function descendants(rootPid, table = processTable()) {
  const found = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const parent = queue.shift()
    for (const row of table)
      if (row.ppid === parent && !found.some((seen) => seen.pid === row.pid)) {
        found.push(row)
        queue.push(row.pid)
      }
  }
  return found
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

async function waitForMaintenanceGit(session) {
  const deadline = Date.now() + PASS_START_DEADLINE_MS
  for (;;) {
    const table = processTable()
    const tree = descendants(session.pid, table)
    if (tree.some(isMaintenanceGit)) return tree
    if (session.child.exitCode !== null) throw new Error("senpi exited before the maintenance pass started")
    if (Date.now() > deadline)
      throw new Error(`no maintenance git under senpi within ${PASS_START_DEADLINE_MS}ms; tree=${JSON.stringify(tree)}`)
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  mkdirSync(options.evidenceDir, { recursive: true })
  const facts = { platform: process.platform, looseObjects: options.looseObjects }
  const homesBefore = Object.fromEntries(REAL_AGENT_HOMES.map((home) => [home, digest(home)]))
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
    const treeAtPass = await waitForMaintenanceGit(session)
    const gitAtPass = treeAtPass.filter(isGit)
    facts.passStartedAfterMs = Date.now() - started
    facts.treeAtPass = treeAtPass
    record(
      "maintenance git running under the live session",
      gitAtPass.some(isMaintenanceGit),
      gitAtPass.map((row) => `${row.pid} ${row.command.slice(0, 120)}`).join(" | "),
    )
    const aliveAtShutdown = gitAtPass.filter((row) => isAlive(row.pid))
    facts.gitAliveAtShutdown = aliveAtShutdown.map((row) => row.pid)
    record(
      "the pass is still running when shutdown starts",
      aliveAtShutdown.length > 0,
      `alive=${facts.gitAliveAtShutdown.join(",")}`,
    )

    // Shutdown exactly as a host closing the RPC channel does: input ends, senpi runs its own shutdown.
    const shutdownStarted = Date.now()
    session.child.stdin.end()
    const exitedOnItsOwn = await waitForExit(session.child, NATURAL_EXIT_WINDOW_MS)
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
    const survivors = gitAtPass.filter((row) => isAlive(row.pid))
    facts.gitSurvivorsAfterExit = survivors
    const strays = processTable().filter((row) => row.command.includes(repo) || row.command.includes(sandbox.root))
    facts.processesNamingTheSandboxAfterExit = strays
    record(
      "no git process from the pass survives senpi's exit",
      survivors.length === 0,
      survivors.length === 0 ? `checked ${gitAtPass.length} pids` : JSON.stringify(survivors),
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
    for (const row of facts.gitSurvivorsAfterExit ?? []) {
      if (!isAlive(row.pid)) continue
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
      for (const row of processTable().filter((entry) => entry.command.includes(sandbox.root))) {
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
    const homesAfter = Object.fromEntries(REAL_AGENT_HOMES.map((home) => [home, digest(home)]))
    const memoryAfter = { digest: digest(REAL_MEMORY_HOME), laneIdentities: laneIdentitiesIn(REAL_MEMORY_HOME) }
    facts.realHomes = { before: homesBefore, after: homesAfter }
    facts.realMemoryHome = { path: REAL_MEMORY_HOME, before: memoryBefore, after: memoryAfter }
    record(
      "real ~/.senpi/agent and ~/.omo/agent unchanged",
      REAL_AGENT_HOMES.every((home) => homesBefore[home] === homesAfter[home]),
      JSON.stringify(homesAfter),
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
