import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildIdentityPaths } from "@oh-my-opencode/memory-core"
import { OmoMemorySettingsSchema } from "@oh-my-opencode/omo-config-core"
import type { BoundMemorySession } from "../binding"
import { registerMemoryComponent } from "../index"
import { createMemoryFixture, recordingSync, type MemoryFixture, type SyncRecord } from "../test-support"
import { createMemorySyncRuntime } from "./runtime"
import type { MemorySyncSeams, SyncHost } from "./ports"
import { MEMORY_SYNC_RPC_ID } from "./rpc"

const fixtures: MemoryFixture[] = []
const roots: string[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(settings: Record<string, unknown> = {}): MemoryFixture {
  const created = createMemoryFixture(settings)
  fixtures.push(created)
  return created
}

const emptyRecord = (): SyncRecord => ({ loads: 0, acquired: [], released: [], disposed: 0 })

function memoryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omo-v2-sync-runtime-"))
  roots.push(root)
  return root
}

function runtimeWith(root: string, seams: MemorySyncSeams, warn: (message: string) => void = () => undefined) {
  return createMemorySyncRuntime({ env: {}, memoryRoot: root, logger: { warn }, onRepoChanged: () => undefined, seams })
}

function bound(root: string, identity: string, settings: Record<string, unknown> = {}): BoundMemorySession {
  return {
    sessionID: identity, identity, directory: root, metadata: {},
    settings: OmoMemorySettingsSchema.parse(settings), paths: buildIdentityPaths(root, identity),
  }
}

/** What a first memory write leaves behind: the repository's git config. */
function seed(session: BoundMemorySession): void {
  mkdirSync(join(session.paths.repo, ".git"), { recursive: true })
  writeFileSync(join(session.paths.repo, ".git", "config"), "")
}

async function bind(f: MemoryFixture, sessionID: string): Promise<void> {
  // A prompt is the cheapest public edge that binds: the recall collector resolves the session.
  await f.prompt(sessionID, "hello")
  await f.context(sessionID)
}

const write = (f: MemoryFixture, sessionID: string) =>
  f.runTool("memory", sessionID, { command: "create", reason: "r", file_path: `system/${sessionID}.md`, description: "Notes", file_text: "x" })

describe("V2 memory sync lifecycle", () => {
  test("#given a fresh device whose memory repos do not exist yet #when sessions bind, then write and settle #then each distinct repo is acquired only after its first write, and released at close", async () => {
    // given
    const f = fixture()
    f.addSession("a")
    f.addSession("b")
    f.addSession("c", { directory: join(f.root, "other-project") })
    const cleanup = await registerMemoryComponent(f.host, f.options())
    for (const id of ["a", "b", "c"]) await bind(f, id)
    await Bun.sleep(20)
    const beforeWrite = [...f.sync.acquired]

    // when
    for (const id of ["a", "b", "c"]) {
      await write(f, id)
      await f.idle(id)
    }
    await Bun.sleep(20)
    const acquired = [...f.sync.acquired]
    await cleanup()

    // then
    expect(beforeWrite).toEqual([])
    expect(acquired).toHaveLength(2)
    expect(new Set(acquired).size).toBe(2)
    expect([...f.sync.released].sort()).toEqual([...acquired].sort())
    expect(f.sync.disposed).toBe(1)
  })

  test("#given memory.sync.enabled is false #when a session binds and writes #then the sync host is never loaded by the session", async () => {
    // given
    const f = fixture({ sync: { enabled: false } })
    f.addSession("a")
    const cleanup = await registerMemoryComponent(f.host, f.options())

    // when
    await bind(f, "a")
    await write(f, "a")
    await f.idle("a")
    await cleanup()

    // then
    expect(f.sync.loads).toBe(0)
    expect(f.sync.acquired).toEqual([])
  })

  test("#given memory.sync.enabled is false #when an omo.memory.sync verb is called #then it is still served, as on Native", async () => {
    // given
    const f = fixture({ sync: { enabled: false } })
    const cleanup = await registerMemoryComponent(f.host, f.options())
    const status = f.rpcs.get(MEMORY_SYNC_RPC_ID)?.handlers["status"]
    if (status === undefined) throw new Error("omo.memory.sync was not registered")

    // when
    await Reflect.apply(status, undefined, [{}, { signal: new AbortController().signal }])
    await cleanup()

    // then
    expect(f.sync.loads).toBe(1)
    expect(f.sync.acquired).toEqual([])
  })

  test("#given the bound identity's agents override disables sync #when it binds on a seeded repo #then nothing is acquired", async () => {
    // given
    const root = memoryRoot()
    const record = emptyRecord()
    const runtime = runtimeWith(root, recordingSync(record))
    const session = bound(root, "me", { sync: { enabled: true }, agents: { me: { sync: { enabled: false } } } })
    seed(session)

    // when
    runtime.onBound(session)
    await runtime.settled()
    await runtime.close()

    // then
    expect(record.loads).toBe(0)
  })

  test("#given the first acquire throws #when the next settle edge arrives #then the failed attempt released its slot and the retry acquires", async () => {
    // given
    const root = memoryRoot()
    const record = emptyRecord()
    let failures = 1
    const host: SyncHost = {
      acquire: async (_identity, paths) => {
        if (failures-- > 0) throw new Error("space resolution failed")
        record.acquired.push(paths.repo)
      },
      release: async repo => { record.released.push(repo) },
      rpcSync: async () => undefined,
      call: async () => ({ kind: "unavailable" }),
      dispose: async () => undefined,
    }
    const warnings: string[] = []
    const runtime = runtimeWith(root, { loadHost: async () => ({ createSyncHost: () => host }) }, message => { warnings.push(message) })
    const session = bound(root, "one")
    seed(session)

    // when
    runtime.onBound(session)
    await runtime.settled()
    await Bun.sleep(5)
    runtime.onSettled()
    await runtime.settled()
    await runtime.close()

    // then
    expect(warnings).toHaveLength(1)
    expect(record.acquired).toEqual([session.paths.repo])
    // One release balances the failed start, one is the close.
    expect(record.released).toEqual([session.paths.repo, session.paths.repo])
  })

  test("#given the sync host fails to load once #when the next settle edge arrives #then the load is retried and the repo is acquired", async () => {
    // given
    const root = memoryRoot()
    const record = emptyRecord()
    const working = recordingSync(record)
    let failures = 1
    const seams: MemorySyncSeams = {
      loadHost: async () => {
        if (failures-- > 0) throw new Error("chunk missing")
        const load = working.loadHost
        if (load === undefined) throw new Error("no loader")
        return load()
      },
    }
    const runtime = runtimeWith(root, seams)
    const session = bound(root, "one")
    seed(session)

    // when
    runtime.onBound(session)
    await runtime.settled()
    await Bun.sleep(5)
    runtime.onSettled()
    await runtime.settled()
    await runtime.close()

    // then
    expect(record.acquired).toEqual([session.paths.repo])
    expect(record.released).toEqual([session.paths.repo])
  })

  test("#given no repo was ever acquired #when the sync status is read #then the host is not loaded", async () => {
    // given
    const root = memoryRoot()
    const record = emptyRecord()
    const runtime = runtimeWith(root, recordingSync(record))

    // when
    const status = await runtime.status(bound(root, "one").paths.repo)
    await runtime.close()

    // then
    expect(status).toBeUndefined()
    expect(record.loads).toBe(0)
  })
})
