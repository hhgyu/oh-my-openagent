import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { dirname, join } from "node:path"
import { GitMemoryRepo, initMemoryWithSeeds, type ReflectionLauncherIdentity } from "@oh-my-opencode/memory-core"
import { openChildJournal } from "../host/child-journal"
import type { SessionBackendApi } from "../host/session-backend"
import { withJoinedSessionCancellation } from "../host/session-cancellation"
import { createSessionScopes, type SessionLease } from "../host/session-state"
import { createMemoryChildPort, type MemoryChildPort } from "./memory-child-port"
import { REFLECTION_AGENT_ID, REFLECTION_PERMISSIONS } from "./reflection-agent"
import { REFLECTION_BACKEND_ID, REFLECTION_CHILD_PREFIX, reflectionChildJournalPath } from "./reflection-child"
import { createReflectionRecovery } from "./reflection-recovery"
import { createRunWorktree, reflectionRunDir, reflectionStore } from "./reflection-run-store"
import { REFLECTION_TOOL_NAMES } from "./reflection-tools"
import { createBoundIdentity } from "./reflection.test-support"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const cleanups: (() => void)[] = []
const ports: MemoryChildPort[] = []
afterEach(async () => {
  // The dead owner's port is closed last; its cleanup fails once custody moved, which is the point.
  await Promise.allSettled(ports.splice(0).map((port) => port.close()))
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const DEAD_PID = 999_999
const APP = { name: "opencode", version: "2.2.6", channel: "stable" } as never
const deadLauncher = async (): Promise<ReflectionLauncherIdentity> => ({
  pid: DEAD_PID,
  hostname: hostname(),
  processStart: null,
})
const AFTER_LAUNCH_WINDOW_MS = 2 * 60_000
const probe = (launcher: "alive" | "dead", offsetMs = AFTER_LAUNCH_WINDOW_MS) => ({
  getPidLiveness: (pid: number) => (pid === DEAD_PID ? launcher : ("alive" as const)),
  now: () => Date.now() + offsetMs,
})

/** A run whose in-process launcher "died" after creating its worktree: reservation held, prelaunch + worktree on disk. */
async function strandedRun() {
  const identity = createBoundIdentity()
  cleanups.push(identity.cleanup)
  const { bound } = identity
  const repo = new GitMemoryRepo({ dir: bound.paths.repo, agentId: bound.identity })
  await initMemoryWithSeeds(repo, { authorName: bound.identity })
  const store = reflectionStore(bound, { createRunId: () => "run-dead", launcherIdentity: deadLauncher })
  await store.tryReserve({ trigger: "manual", conversationIds: [], snapshots: [] })
  const worktree = await createRunWorktree(bound, repo, "run-dead")
  return { bound, worktree, store }
}

type Ref = { id: SessionLease["sessionID"]; parentID?: SessionLease["sessionID"]; location: { directory: string } }

function fakeSessions(directory: string) {
  const sessions = new Map<string, Ref>([["root", { id: "root" as Ref["id"], location: { directory } }]])
  const api: SessionBackendApi = {
    async create(input) {
      const value: Ref = { id: input.id as Ref["id"], parentID: input.parentID as Ref["id"], location: { directory } }
      sessions.set(value.id, value)
      return value
    },
    async get({ sessionID }) {
      const value = sessions.get(sessionID)
      if (value === undefined) throw new Error("not found")
      return value
    },
    async list() {
      return { data: [...sessions.values()], cursor: {} }
    },
    async prompt(input) {
      return { id: String(input.id), sessionID: input.sessionID as Ref["id"] }
    },
    async synthetic(input) {
      return { id: String(input.id), sessionID: input.sessionID as Ref["id"] }
    },
    async interrupt() {
      return { interrupted: true }
    },
    async wait() {},
    async remove({ sessionID }) {
      sessions.delete(sessionID)
    },
    async context() {
      return [] as never
    },
    instructions: {
      entry: {
        async list() {
          return []
        },
        async put() {},
        async remove() {},
      },
    },
  }
  // Controlled fake contract only: these methods accept the test-owned request signals.
  withJoinedSessionCancellation(api, "controlled-test")
  return { api, sessions }
}

describe("reflection recovery at bind", () => {
  test("#given a reservation whose in-process launcher died #when the session binds #then its worktree is discarded, the run abandoned and the reservation released", async () => {
    // given
    const { bound, worktree, store } = await strandedRun()
    const warnings: string[] = []
    const recovery = createReflectionRecovery({
      host: { session: {} },
      warn: (message) => {
        warnings.push(message)
      },
      probe: probe("dead"),
    })

    // when
    const report = await recovery.onBound(bound)

    // then
    expect(report).toEqual({ lock: "released" })
    expect(existsSync(worktree.dir)).toBe(false)
    expect(
      execFileSync("git", ["branch", "--list", worktree.branch], { cwd: bound.paths.repo, encoding: "utf8" }).trim(),
    ).toBe("")
    expect((await store.readState()).active).toBeUndefined()
    expect(existsSync(join(reflectionRunDir(bound, "run-dead"), "abandoned.json"))).toBe(true)
    expect(warnings).toEqual([])
  })

  test("#given a reservation whose launcher is alive #when the session binds #then nothing is touched", async () => {
    // given
    const { bound, worktree, store } = await strandedRun()
    const recovery = createReflectionRecovery({ host: { session: {} }, warn: () => undefined, probe: probe("alive") })

    // when
    const report = await recovery.onBound(bound)

    // then
    expect(report).toEqual({ lock: "live" })
    expect(existsSync(worktree.dir)).toBe(true)
    expect((await store.readState()).active?.runId).toBe("run-dead")
  })

  test("#given a dead launcher whose reservation is inside the launch window #when the session binds #then the young launch is left alone and the first settled turn after the window reclaims it", async () => {
    // given
    const { bound, worktree, store } = await strandedRun()
    let offsetMs = 0
    const recovery = createReflectionRecovery({
      host: { session: {} },
      warn: () => undefined,
      probe: { ...probe("dead"), now: () => Date.now() + offsetMs },
    })

    // when
    const atBind = await recovery.onBound(bound)
    const keptActive = (await store.readState()).active?.runId
    offsetMs = AFTER_LAUNCH_WINDOW_MS
    const atTurn = await recovery.onTurnSettled(bound)

    // then
    expect(atBind).toEqual({ lock: "reported" })
    expect(keptActive).toBe("run-dead")
    expect(atTurn).toEqual({ lock: "released" })
    expect(existsSync(worktree.dir)).toBe(false)
    expect((await store.readState()).active).toBeUndefined()
    expect(existsSync(join(reflectionRunDir(bound, "run-dead"), "abandoned.json"))).toBe(true)
  })

  test("#given a launcher that was alive at bind and died afterwards #when the next turn settles #then the stale lock is reclaimed", async () => {
    // given
    const { bound, store } = await strandedRun()
    let launcher: "alive" | "dead" = "alive"
    const recovery = createReflectionRecovery({
      host: { session: {} },
      warn: () => undefined,
      probe: { ...probe("alive"), getPidLiveness: (pid: number) => (pid === DEAD_PID ? launcher : "alive") },
    })
    const atBind = await recovery.onBound(bound)

    // when
    const whileAlive = await recovery.onTurnSettled(bound)
    launcher = "dead"
    const afterDeath = await recovery.onTurnSettled(bound)

    // then
    expect(atBind).toEqual({ lock: "live" })
    expect(whileAlive).toEqual({ lock: "live" })
    expect(afterDeath).toEqual({ lock: "released" })
    expect((await store.readState()).active).toBeUndefined()
  })

  test("#given a dead launcher's run that already recorded its terminal state #when the session binds #then only the reservation is released", async () => {
    // given
    const { bound, store } = await strandedRun()
    writeFileSync(
      join(reflectionRunDir(bound, "run-dead"), "final.json"),
      `${JSON.stringify({ version: 1, runId: "run-dead", outcome: "failed", finishedAt: new Date().toISOString() })}\n`,
    )
    const recovery = createReflectionRecovery({ host: { session: {} }, warn: () => undefined, probe: probe("dead") })

    // when
    const report = await recovery.onBound(bound)

    // then
    expect(report).toEqual({ lock: "released" })
    expect((await store.readState()).active).toBeUndefined()
    expect(existsSync(join(reflectionRunDir(bound, "run-dead"), "abandoned.json"))).toBe(false)
  })

  test("#given an old torn active.lock #when the session binds #then the reaper moves it aside", async () => {
    // given
    const identity = createBoundIdentity()
    cleanups.push(identity.cleanup)
    const { bound } = identity
    mkdirSync(bound.paths.reflection, { recursive: true })
    writeFileSync(join(bound.paths.reflection, "active.lock"), '{"runId":"reflection-run-4","launch')
    const recovery = createReflectionRecovery({
      host: { session: {} },
      warn: () => undefined,
      probe: probe("dead", 2 * 60 * 60_000),
    })

    // when
    const report = await recovery.onBound(bound)

    // then
    expect(report).toEqual({ lock: "released" })
    expect(existsSync(join(bound.paths.reflection, "active.lock"))).toBe(false)
  })

  test("#given a dead launcher's Senpi-ledger run #when two turns settle #then it is reported once and left to Senpi", async () => {
    // given
    const { bound, store } = await strandedRun()
    writeFileSync(join(reflectionRunDir(bound, "run-dead"), "ledger.json"), "{}\n")
    const warnings: string[] = []
    const recovery = createReflectionRecovery({
      host: { session: {} },
      warn: (message) => {
        warnings.push(message)
      },
      probe: probe("dead"),
    })

    // when
    const reports = [await recovery.onTurnSettled(bound), await recovery.onTurnSettled(bound)]

    // then
    expect(reports).toEqual([{ lock: "reported" }, { lock: "reported" }])
    expect((await store.readState()).active?.runId).toBe("run-dead")
    expect(warnings.filter((message) => message.startsWith("memory reflection is held by run run-dead"))).toHaveLength(
      1,
    )
  })

  test("#given a dead launcher's run that has a Senpi ledger #when the session binds #then it is reported and left to Senpi's reconciliation", async () => {
    // given
    const { bound, worktree, store } = await strandedRun()
    writeFileSync(join(reflectionRunDir(bound, "run-dead"), "ledger.json"), "{}\n")
    const warnings: string[] = []
    const recovery = createReflectionRecovery({
      host: { session: {} },
      warn: (message) => {
        warnings.push(message)
      },
      probe: probe("dead"),
    })

    // when
    const report = await recovery.onBound(bound)

    // then
    expect(report).toEqual({ lock: "reported" })
    expect(existsSync(worktree.dir)).toBe(true)
    expect((await store.readState()).active?.runId).toBe("run-dead")
    expect(warnings.some((message) => message.startsWith("memory reflection is held by run run-dead"))).toBe(true)
  })

  test("#given a dead host's reflection child row #when the session binds #then the host child is removed and its custody row CLOSED", async () => {
    // given
    const identity = createBoundIdentity()
    cleanups.push(identity.cleanup)
    const journalPath = reflectionChildJournalPath(identity.bound)
    mkdirSync(dirname(journalPath), { recursive: true })
    const { api, sessions } = fakeSessions(identity.root)
    const port = createMemoryChildPort({
      host: { app: APP, session: api },
      directory: identity.root,
      parentSessionId: "root",
      journalPath,
      backendID: REFLECTION_BACKEND_ID,
      prefix: REFLECTION_CHILD_PREFIX,
      label: "Reflection",
      agent: REFLECTION_AGENT_ID,
      permissions: REFLECTION_PERMISSIONS.map((rule) => ({ ...rule })),
      toolNames: [...REFLECTION_TOOL_NAMES],
      scopes: createSessionScopes(),
      onIssued: () => undefined,
      onRetired: () => undefined,
    })
    ports.push(port)
    const child = await port.start({ generation: 1, prompt: "reflect" })
    const recovery = createReflectionRecovery({
      host: { app: APP, session: api },
      warn: () => undefined,
      probeOwner: async () => "dead",
    })

    // when
    await recovery.onBound(identity.bound)

    // then
    expect(sessions.has(child.sessionID)).toBe(false)
    const journal = await openChildJournal({ path: journalPath })
    try {
      expect((await journal.list()).find((record) => record.locator.sessionID === child.sessionID)?.phase).toBe(
        "closed",
      )
    } finally {
      journal.close()
    }
  })
})
