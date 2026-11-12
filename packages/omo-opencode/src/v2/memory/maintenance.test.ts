import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { GitMemoryRepo } from "@oh-my-opencode/memory-core"
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
afterEach(() => { for (const created of fixtures.splice(0)) created.cleanup() })

/** `<identity runtime>/maintenance.json` stamps under the memory home, wherever the identity landed. */
function maintenanceStamps(home: string): string[] {
  if (!existsSync(home)) return []
  return readdirSync(home, { recursive: true, encoding: "utf8" })
    .filter(path => path.replaceAll("\\", "/").endsWith("runtime/maintenance.json"))
    .map(path => join(home, path))
}

async function seededRoot(f: ReturnType<typeof createMemoryFixture>): Promise<void> {
  f.addSession("root")
  const first = await registerMemoryComponent(f.host, f.options({ maintenance: { delayMs: 60_000 } }))
  await f.runTool("memory", "root", {
    command: "create", reason: "add notes", file_path: "system/notes.md", description: "Working notes for this project", file_text: "zebra",
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
    const cleanup = await registerMemoryComponent(f.host, f.options({ maintenance: { delayMs: 0, minLooseObjects: 0, now: () => 1_800_000_000_000 } }))

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
    const first = await registerMemoryComponent(f.host, f.options({ maintenance: { delayMs: 0, minLooseObjects: 0, now: () => 1_800_000_000_000 } }))
    await f.context("root")
    await until(() => maintenanceStamps(f.env.OMO_MEMORY_HOME ?? "").length === 1, 30_000)
    await first()
    f.addSession("second")
    let entered = 0
    const second = await registerMemoryComponent(f.host, f.options({ maintenance: {
      delayMs: 0, minLooseObjects: 0, now: () => 1_800_000_000_000 + 60_000,
      createRepo: context => { entered++; return new GitMemoryRepo({ dir: context.identityPaths.repo, agentId: context.identity }) },
    } }))

    // when
    await f.context("second")
    await until(() => entered === 1, 30_000)
    await second()

    // then
    const [stamp] = maintenanceStamps(f.env.OMO_MEMORY_HOME ?? "")
    expect(JSON.parse(readFileSync(stamp ?? "", "utf8"))).toEqual({ version: 1, attemptedAt: 1_800_000_000_000 })
  })
})
