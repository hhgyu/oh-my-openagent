#!/usr/bin/env bun
// Live proof of the fresh-device sync edge (parity P-22): a real RPC senpi binds a memory whose repo
// does not exist yet, the first memory write creates it, and the settle after that write makes the
// shared runner start sync in the SAME session. Only the HTTP model is scripted. The device is signed
// out on purpose (the service origin is a dead loopback port, so no keyring entry can match and no
// request leaves the machine): the start attempt after the settle ends in the typed idle line, which
// is the observable that the runner was started again.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { credentialDigest } from "./drive.mjs"
import { changedSnapshotPaths, snapshotProtectedState, protectedSnapshotsUntouched } from "./isolation-state.mjs"
import { startMockCompletionsServer } from "./mock-completions-server.mjs"
import {
  DEFAULT_PLUGIN_ROOT, DEFAULT_SENPI_CLI, REPO_ROOT, prepareSandbox, sandboxEnv, assertSandboxEnv,
  resolveCommand, launchRpc, getState, prompt, teardown, createRouter, createCleanup,
  installInterruptCleanup, removeSandbox, writeEvidence, isAlive,
} from "./kibitzer-sidecar-support.mjs"

const WAITING = "sync waiting: the memory repository does not exist yet"
const IDLE = "sync idle: no device session"
const DEAD_SERVICE = "http://127.0.0.1:9"
const SETTLE_GRACE_MS = 5_000

function optionsFrom(argv) {
  const options = { label: "change", keep: false, pluginRoot: DEFAULT_PLUGIN_ROOT, senpiCli: DEFAULT_SENPI_CLI, expect: "resume" }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--keep-sandbox") { options.keep = true; continue }
    const field = { "--evidence-dir": "evidenceDir", "--plugin-root": "pluginRoot", "--senpi-cli": "senpiCli", "--label": "label", "--expect": "expect" }[arg]
    if (field === undefined || argv[index + 1] === undefined) throw new Error(`Invalid argument: ${arg}`)
    options[field] = argv[++index]
  }
  assert(["resume", "no-resume"].includes(options.expect), "--expect must be resume|no-resume")
  if (options.evidenceDir === undefined) {
    const result = spawnSync(process.execPath, [join(REPO_ROOT, ".agents/skills/senpi-qa/scripts/resolve-evidence-dir.mjs"), "--repo-root", REPO_ROOT, "--slug", "20261112-sync-fresh-device-resume"], { encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    options.evidenceDir = result.stdout.trim()
  }
  return options
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")
const runnerLines = (stderr) => stderr.split(/\r?\n/).filter((line) => line.includes(WAITING) || line.includes(IDLE) || line.includes("memory sync"))

export async function runFreshDeviceSyncE2e(options) {
  const cleanup = createCleanup()
  installInterruptCleanup(() => [cleanup])
  const protectedRoots = [join(homedir(), ".senpi", "agent"), join(homedir(), ".omo", "agent")]
  const before = protectedRoots.map((root) => credentialDigest(root))
  const protectedBefore = protectedRoots.map((root) => snapshotProtectedState(root))
  const router = createRouter()
  const server = startMockCompletionsServer({ steps: router.steps })
  cleanup.add("scripted HTTP provider", () => { server.close(); return "listener closed" })
  const report = { schemaVersion: 1, label: options.label, expect: options.expect, checks: [], cleanup: cleanup.receipts }
  const check = (name, ok, detail) => { report.checks.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` :: ${JSON.stringify(detail)}`}`) }
  let session
  try {
    const sandbox = prepareSandbox(options.pluginRoot, await server.ready)
    cleanup.add("sandbox", () => removeSandbox(sandbox, options.keep))
    writeFileSync(join(sandbox.cwd, ".omo", "omo.json"), `${JSON.stringify({
      categories: { quick: { description: "QA mock quick category", model: "omo-mock/mock-1" } },
      memory: { enabled: true, agent: "sync-fresh-qa", recall: { enabled: false }, facts: { enabled: false }, dream: { enabled: false },
        reflection: { trigger: { step_count: 0, on_compaction: false } } },
    }, null, 2)}\n`)
    const env = { ...sandboxEnv(sandbox), OMO_DEBUG: "1", OMO_SERVICE_API_URL: DEAD_SERVICE }
    assertSandboxEnv(sandbox, env)
    const command = resolveCommand(options)
    // The identity directory carries a hash suffix (`sync-fresh-qa-<hash>`), so the repo is found by scan.
    const agentsDir = join(sandbox.memoryHome, "agents")
    const identityRepos = () => existsSync(agentsDir)
      ? readdirSync(agentsDir).filter((name) => name.startsWith("sync-fresh-qa")).map((name) => join(agentsDir, name, "repo"))
      : []
    const seededRepos = () => identityRepos().filter((repo) => existsSync(join(repo, ".git")))
    report.isolation = { root: sandbox.root, agentDir: sandbox.agentDir, memoryHome: sandbox.memoryHome, serviceOrigin: DEAD_SERVICE }
    report.runtime = { command: command.display, pluginRoot: options.pluginRoot, bundleSha256: sha256(join(options.pluginRoot, "extensions", "omo.js")) }

    session = launchRpc(command, sandbox, env)
    cleanup.add(`RPC pid ${session.pid}`, async () => { const receipt = await teardown(session); assert.equal(isAlive(session.pid), false); return receipt })
    await getState(session)
    check("no seeded memory repository at bind", seededRepos().length === 0, identityRepos())
    const atBind = runnerLines(session.stderr())

    router.setParentSteps([
      { type: "tool_call", name: "memory", arguments: { command: "create", file_path: "reference/seed.md", description: "Synthetic seed", file_text: "Fresh-device sync QA seed.", reason: "seed fresh-device sync QA" } },
      { type: "text", text: "Seeded." },
    ])
    await prompt(session, "Remember the fresh-device sync QA seed using memory.")
    check("first memory write created the repo", seededRepos().length === 1, seededRepos())
    // The resume is fire-and-forget after agent_settled; wait for its line on stderr, or, for the
    // base build, hold the bounded window that proves no second start attempt comes.
    await new Promise((resolve) => {
      const done = () => { clearTimeout(timer); session.child.stderr.off("data", onData); resolve() }
      const onData = () => { if (runnerLines(session.stderr()).length > atBind.length) done() }
      const timer = setTimeout(done, SETTLE_GRACE_MS)
      session.child.stderr.on("data", onData)
      onData()
    })
    const afterTurn = runnerLines(session.stderr()).slice(atBind.length)
    report.runnerLines = { atBind, afterTurn }

    if (options.expect === "resume") {
      check("bind waits for the repository", atBind.some((line) => line.includes(WAITING)), atBind)
      check("bind does not resolve a session", !atBind.some((line) => line.includes(IDLE)), atBind)
      check("settle after the write starts the runner again", afterTurn.some((line) => line.includes(IDLE)), afterTurn)
    } else {
      check("bind resolves at once (base)", atBind.some((line) => line.includes(IDLE)), atBind)
      check("no start attempt after the settle (base)", afterTurn.length === 0, afterTurn)
    }
    check("no sync error logged", !runnerLines(session.stderr()).some((line) => /failed to start|resume failed/.test(line)), runnerLines(session.stderr()))
  } catch (error) {
    check("driver", false, String(error?.stack ?? error))
  } finally {
    await cleanup.run()
    const after = protectedRoots.map((root) => credentialDigest(root))
    check("real ~/.senpi/agent and ~/.omo/agent credentials untouched", JSON.stringify(after) === JSON.stringify(before))
    const protectedAfter = protectedRoots.map((root) => snapshotProtectedState(root))
    const complete = [...protectedBefore, ...protectedAfter].every((snapshot) => snapshot.complete)
    const changed = protectedRoots.map((root, index) => ({ root, changed: changedSnapshotPaths(protectedBefore[index].snapshot, protectedAfter[index].snapshot) }))
    // Windows cannot open protected files without following links, so its snapshots are never complete:
    // the check then stands on the observed changes and says so, instead of claiming certification.
    check(complete ? "real protected state untouched (certified)" : "real protected state: no observed change (snapshot incomplete on this platform)",
      complete ? protectedSnapshotsUntouched(protectedBefore[0], protectedAfter[0]) && protectedSnapshotsUntouched(protectedBefore[1], protectedAfter[1]) : changed.every((entry) => entry.changed.length === 0),
      { changed, errors: protectedAfter.flatMap((snapshot) => snapshot.errors.map((error) => error.code)).filter((code, index, all) => all.indexOf(code) === index) })
    report.result = report.checks.every((entry) => entry.ok) ? "PASS" : "FAIL"
    writeEvidence(options.evidenceDir, `live-${options.label}.json`, report)
    console.log(JSON.stringify({ result: report.result, label: options.label, evidence: join(options.evidenceDir, `live-${options.label}.json`) }))
  }
  return report
}

if (import.meta.main) {
  const report = await runFreshDeviceSyncE2e(optionsFrom(process.argv.slice(2)))
  process.exit(report.result === "PASS" ? 0 : 1)
}
