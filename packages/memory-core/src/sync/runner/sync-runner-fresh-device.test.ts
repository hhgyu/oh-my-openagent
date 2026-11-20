import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildIdentityPaths, type MemoryIdentityPaths } from "../../identity/layout"
import type { DeviceSync, EngineStatus, SyncSession } from "../engine"

import { createSyncRunner, type SyncRunnerTimers, type SyncSessionResolver } from "./sync-runner"
import { SyncSessionDeferredError } from "./sync-session-deferred"

// The scenario of fork fix 070661d345, on upstream's runner (launchStart retries a deferred pass): a fresh device binds
// before its first memory write creates the repository, sync waits, the first write creates it, and sync then starts
// without a new bind. Later acquires and releases must not leave the repository held off.

const RETRY_MS = 1_000
const PASS_DEADLINE_MS = 10_000_000
const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function freshDevice(): Promise<MemoryIdentityPaths> {
  const root = await mkdtemp(join(tmpdir(), "omo-sync-fresh-"))
  dirs.push(root)
  return buildIdentityPaths(root, "agent")
}

async function firstWrite(paths: MemoryIdentityPaths): Promise<void> {
  await mkdir(join(paths.repo, ".git", "logs"), { recursive: true })
}

const noRuntime = () => Promise.reject(new Error("the engine sidecar is not loaded in this test"))

function harness(repoReady: (repo: string) => boolean) {
  const opened: string[] = []
  const closed: string[] = []
  const lines: string[] = []
  const retries: (() => void)[] = []
  let resolves = 0
  const timers: SyncRunnerTimers = {
    setTimeout: (run, ms) => {
      if (ms < PASS_DEADLINE_MS) retries.push(run)
      return { unref: () => undefined } as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: () => undefined,
  }
  const resolveSession: SyncSessionResolver = async (request) => {
    resolves += 1
    if (!repoReady(request.paths.repo))
      throw new SyncSessionDeferredError(
        "the memory repository is not created yet; sync starts after the first memory write.",
        undefined,
      )
    return {} as SyncSession
  }
  const runner = createSyncRunner({
    loadRuntime: noRuntime,
    logger: {
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(`warn ${m}`),
      error: (m: string) => lines.push(`error ${m}`),
    },
    resolveSession,
    open: async (o): Promise<DeviceSync> => {
      opened.push(o.repoDir)
      return {
        engine: { start: () => undefined } as unknown as DeviceSync["engine"],
        status: async (): Promise<EngineStatus> => ({ kind: "never_synced" }),
        notifyLocalCommit: () => undefined,
        close: async () => {
          closed.push(o.repoDir)
        },
      }
    },
    watchHead: () => () => undefined,
    deferredRetryMs: RETRY_MS,
    startPassDeadlineMs: PASS_DEADLINE_MS,
    timers,
  })
  const fireRetry = async () => {
    const run = retries.shift()
    if (run === undefined) throw new Error("no retry was scheduled")
    run()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return { runner, opened, closed, lines, resolves: () => resolves, retries: () => retries.length, fireRetry }
}

describe("#given a fresh device whose memory repository does not exist at bind", () => {
  test("#when the first memory write creates it #then the retry starts one engine without a new bind", async () => {
    const paths = await freshDevice()
    const repoExists = new Set<string>()
    const h = harness((repo) => repoExists.has(repo))

    await h.runner.acquire("agent", paths, { enabled: true })
    expect(h.opened).toEqual([])
    expect(h.lines.some((line) => line.includes("memory sync is waiting"))).toBe(true)
    expect(h.retries()).toBe(1)

    await firstWrite(paths)
    repoExists.add(paths.repo)
    await h.fireRetry()

    expect(h.opened).toEqual([paths.repo])
    expect(await h.runner.status(paths.repo)).toEqual({ kind: "never_synced" })
    expect(h.lines.some((line) => line.includes("memory sync started"))).toBe(true)

    await h.runner.release(paths.repo)
    expect(h.closed).toEqual([paths.repo])
  })

  test("#when the retry runs before the repository exists #then sync keeps waiting and another retry is scheduled", async () => {
    const paths = await freshDevice()
    const h = harness(() => false)

    await h.runner.acquire("agent", paths, { enabled: true })
    await h.fireRetry()

    expect(h.opened).toEqual([])
    expect(h.retries()).toBe(1)
    await h.runner.release(paths.repo)
  })

  test("#when two sessions hold the repo across the first write #then the engine closes only with the last release", async () => {
    const paths = await freshDevice()
    const repoExists = new Set<string>()
    const h = harness((repo) => repoExists.has(repo))

    await h.runner.acquire("agent", paths, { enabled: true })
    await h.runner.acquire("agent", paths, { enabled: true })
    await firstWrite(paths)
    repoExists.add(paths.repo)
    await h.fireRetry()
    expect(h.opened).toEqual([paths.repo])

    await h.runner.release(paths.repo)
    expect(h.closed).toEqual([])
    await h.runner.release(paths.repo)
    expect(h.closed).toEqual([paths.repo])
  })

  test("#when a session binds after the first write #then it joins the running engine and none is held off", async () => {
    const paths = await freshDevice()
    const repoExists = new Set<string>()
    const h = harness((repo) => repoExists.has(repo))

    await h.runner.acquire("agent", paths, { enabled: true })
    await firstWrite(paths)
    repoExists.add(paths.repo)
    await h.fireRetry()
    await h.runner.acquire("agent", paths, { enabled: true })

    expect(h.opened).toEqual([paths.repo])
    expect(await h.runner.status(paths.repo)).toEqual({ kind: "never_synced" })
    await h.runner.release(paths.repo)
    await h.runner.release(paths.repo)
    expect(h.closed).toEqual([paths.repo])
  })
})
