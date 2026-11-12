import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildIdentityPaths, type MemoryIdentityPaths } from "../../identity/layout"
import type { DeviceSync, EngineStatus, SyncSession } from "../engine"

import { SYNC_WAITING_FOR_REPOSITORY, createSyncRunner, type SyncSessionResolver } from "./sync-runner"

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function freshDevice(): Promise<MemoryIdentityPaths> {
  const root = await mkdtemp(join(tmpdir(), "omo-sync-fresh-"))
  dirs.push(root)
  return buildIdentityPaths(root, "agent")
}

async function seed(paths: MemoryIdentityPaths): Promise<void> {
  await mkdir(join(paths.repo, ".git", "logs"), { recursive: true })
}

const noRuntime = () => Promise.reject(new Error("the engine sidecar is not loaded in this test"))

function harness(resolveSession: SyncSessionResolver = async () => ({}) as SyncSession) {
  const opened: string[] = []
  const closed: string[] = []
  const lines: string[] = []
  let resolves = 0
  const runner = createSyncRunner({
    loadRuntime: noRuntime,
    logger: { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(`warn ${m}`), error: (m: string) => lines.push(`error ${m}`) },
    resolveSession: (request) => {
      resolves += 1
      return resolveSession(request)
    },
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
  })
  return { runner, opened, closed, lines, resolves: () => resolves }
}

describe("#given a fresh device whose memory repository does not exist at bind", () => {
  test("#when the first memory write seeds it and resume runs #then one engine starts in the same session", async () => {
    const paths = await freshDevice()
    const h = harness()

    await h.runner.acquire("agent", paths, { enabled: true })
    expect([h.resolves(), h.opened, h.lines]).toEqual([0, [], [SYNC_WAITING_FOR_REPOSITORY]])

    await seed(paths)
    await h.runner.resume(paths.repo)
    expect(h.opened).toEqual([paths.repo])
    expect(await h.runner.status(paths.repo)).toEqual({ kind: "never_synced" })

    await h.runner.resume(paths.repo)
    expect(h.opened).toEqual([paths.repo])

    await h.runner.release(paths.repo)
    expect(h.closed).toEqual([paths.repo])
  })

  test("#when resume runs before the repository exists #then nothing is resolved or opened", async () => {
    const paths = await freshDevice()
    const h = harness()

    await h.runner.acquire("agent", paths, { enabled: true })
    await h.runner.resume(paths.repo)

    expect([h.resolves(), h.opened]).toEqual([0, []])
    await h.runner.release(paths.repo)
  })

  test("#when two sessions hold the repo across the resume #then the engine closes only with the last release", async () => {
    const paths = await freshDevice()
    const h = harness()

    await h.runner.acquire("agent", paths, { enabled: true })
    await h.runner.acquire("agent", paths, { enabled: true })
    await seed(paths)
    await h.runner.resume(paths.repo)
    expect(h.opened).toEqual([paths.repo])

    await h.runner.release(paths.repo)
    expect(h.closed).toEqual([])
    await h.runner.release(paths.repo)
    expect(h.closed).toEqual([paths.repo])
  })
})

describe("#given a start that threw", () => {
  test("#when resume runs #then it does not retry, and #when another session binds #then that bind retries", async () => {
    const paths = await freshDevice()
    await seed(paths)
    let fail = true
    const h = harness(async () => {
      if (fail) throw new Error("transient")
      return {} as SyncSession
    })

    await h.runner.acquire("agent", paths, { enabled: true })
    expect(h.lines).toEqual(["error memory sync failed to start"])
    fail = false
    await h.runner.resume(paths.repo)
    expect([h.resolves(), h.opened]).toEqual([1, []])

    await h.runner.acquire("agent", paths, { enabled: true })
    expect([h.resolves(), h.opened]).toEqual([2, [paths.repo]])

    await h.runner.release(paths.repo)
    expect(h.closed).toEqual([])
    await h.runner.release(paths.repo)
    expect(h.closed).toEqual([paths.repo])
  })
})

describe("#given a device with no session to sync with", () => {
  test("#when another session binds #then the idle start is kept, not retried", async () => {
    const paths = await freshDevice()
    await seed(paths)
    const h = harness(async () => null)

    await h.runner.acquire("agent", paths, { enabled: true })
    await h.runner.acquire("agent", paths, { enabled: true })
    await h.runner.resume(paths.repo)

    expect(h.resolves()).toBe(1)
    await h.runner.release(paths.repo)
    await h.runner.release(paths.repo)
  })
})
