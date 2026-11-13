import { execFileSync } from "node:child_process"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { MEMORY_BINDING_KEY, MEMORY_PART_MARKER, PROJECTION_PIN_KEY, registerMemoryComponent } from "./index"
import { createMemoryFixture, partsWith } from "./test-support"

const fixtures: ReturnType<typeof createMemoryFixture>[] = []
function fixture(settings: Record<string, unknown> = {}) {
  const created = createMemoryFixture(settings)
  fixtures.push(created)
  return created
}
afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup()
})

const create = (file: string, description: string, body: string) => ({
  command: "create",
  reason: `add ${file}`,
  file_path: file,
  description,
  file_text: body,
})

describe("registerMemoryComponent", () => {
  test("#given memory.enabled false or the omo-memory-enabled option false #then nothing is registered", async () => {
    // given
    const disabledByConfig = fixture({ enabled: false })
    const disabledByOption = fixture()
    // when
    const first = await registerMemoryComponent(disabledByConfig.host, disabledByConfig.options())
    const second = await registerMemoryComponent(
      { ...disabledByOption.host, options: { "omo-memory-enabled": false } },
      disabledByOption.options(),
    )
    // then
    expect([
      disabledByConfig.hooks.size,
      disabledByConfig.tools.size,
      disabledByConfig.commands.size,
      disabledByOption.hooks.size,
      disabledByOption.tools.size,
      disabledByOption.commands.size,
    ]).toEqual([0, 0, 0, 0, 0, 0])
    await first()
    await second()
  })

  test("#given a root session without a memory repo #when a user turn is accepted #then only runtime bookkeeping is created and nothing is projected", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    const cleanup = await registerMemoryComponent(f.host, f.options())
    // when
    await f.prompt("root", "remember my coffee order")
    const system = await f.context("root")
    // then
    expect(system).toEqual([])
    const binding = f.sessions.get("root")?.metadata?.[MEMORY_BINDING_KEY] as { identity: string }
    const identity = join(f.env.OMO_MEMORY_HOME ?? "", "agents", binding.identity)
    expect(existsSync(join(identity, "runtime", "accepted-turns"))).toBe(true)
    expect(existsSync(join(identity, "repo"))).toBe(false)
    await cleanup()
  })

  test("#given a subagent child session #when it calls the memory tool #then the call is refused and no storage is created", async () => {
    // given
    const f = fixture()
    f.addSession("child", { parentID: "root" })
    const cleanup = await registerMemoryComponent(f.host, f.options())
    // when
    const refused = f.runTool("memory", "child", create("system/notes.md", "Working notes for this project", "zebra"))
    // then
    await expect(refused).rejects.toBeInstanceOf(ToolError)
    expect(existsSync(f.env.OMO_MEMORY_HOME ?? "")).toBe(false)
    expect(await f.context("child")).toEqual([])
    await cleanup()
  })

  test("#given two user prompts in a root session #when it writes memory #then the commit carries that session and turn", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    const cleanup = await registerMemoryComponent(f.host, f.options())
    await f.prompt("root", "first request")
    await f.prompt("root", "second request")
    // when
    await f.runTool("memory", "root", create("system/notes.md", "Working notes for this project", "turn trailer"))
    // then
    const metadata = f.sessions.get("root")?.metadata ?? {}
    const repo = join(
      f.env.OMO_MEMORY_HOME ?? "",
      "agents",
      String((metadata[MEMORY_BINDING_KEY] as { identity: string }).identity),
      "repo",
    )
    const message = execFileSync("git", ["-C", repo, "log", "-1", "--format=%B"], { encoding: "utf8" })
    expect(message).toContain("Omo-Session: root")
    expect(message).toContain("Omo-Turn: 2")
    await cleanup()
  })

  test("#given accepted turns before a generation handover #when the next generation saves #then provenance and the save threshold retain those turns", async () => {
    // given
    const f = fixture({ nudge: { enabled: true, every_user_turns: 3 } })
    f.addSession("reload")
    const first = await registerMemoryComponent(f.host, f.options())
    await f.prompt("reload", "first")
    await f.prompt("reload", "second")
    expect(partsWith(await f.context("reload"), "omo.memory.save-nudge")).toHaveLength(0)
    await first()
    // when
    const second = await registerMemoryComponent(f.host, f.options())
    await f.prompt("reload", "third")
    const nudged = await f.context("reload")
    await f.runTool("memory", "reload", create("reference/reload.md", "Reload provenance", "saved after reload"))
    const metadata = f.sessions.get("reload")?.metadata ?? {}
    const repo = join(
      f.env.OMO_MEMORY_HOME ?? "",
      "agents",
      String((metadata[MEMORY_BINDING_KEY] as { identity: string }).identity),
      "repo",
    )
    // then
    expect(partsWith(nudged, "omo.memory.save-nudge")).toHaveLength(1)
    expect(execFileSync("git", ["-C", repo, "log", "-1", "--format=%B"], { encoding: "utf8" })).toContain("Omo-Turn: 3")
    expect(partsWith(await f.context("reload"), "omo.memory.save-nudge")).toHaveLength(0)
    await second()
  })

  test("#given a prompt hook invocation without acceptance #when a later accepted turn saves #then the rejected prompt is not counted", async () => {
    const f = fixture()
    f.addSession("accepted-only")
    const cleanup = await registerMemoryComponent(f.host, f.options())
    const prompt = f.hooks.get("session:prompt")
    if (prompt === undefined) throw new Error("Missing prompt hook")
    await Reflect.apply(prompt, undefined, [
      { sessionID: "accepted-only", messageID: "not-enqueued", prompt: { text: "rejected" } },
    ])
    await f.prompt("accepted-only", "accepted")
    await f.runTool(
      "memory",
      "accepted-only",
      create("reference/accepted.md", "Accepted turn provenance", "one accepted turn"),
    )
    const binding = f.sessions.get("accepted-only")?.metadata?.[MEMORY_BINDING_KEY] as { identity: string }
    const repo = join(f.env.OMO_MEMORY_HOME ?? "", "agents", binding.identity, "repo")
    expect(execFileSync("git", ["-C", repo, "log", "-1", "--format=%B"], { encoding: "utf8" })).toContain("Omo-Turn: 1")
    await cleanup()
  })

  test.each([false, true])(
    "#given acceptance is in flight with another session blocking the stream %s #when its session is deleted #then eviction waits for persistence and a later bind reloads the durable counter",
    async (backlog) => {
      const f = fixture()
      f.addSession("deleted")
      f.addSession("blocked")
      const cleanup = await registerMemoryComponent(f.host, f.options())
      const entered = Promise.withResolvers<undefined>()
      const held = Promise.withResolvers<undefined>()
      const original = f.host.session.get.bind(f.host.session)
      const read = spyOn(f.host.session, "get").mockImplementation(async (input) => {
        entered.resolve(undefined)
        await held.promise
        return original(input)
      })
      try {
        const initial = f.prompt(backlog ? "blocked" : "deleted", "accepted before deletion")
        await entered.promise
        const pending = backlog ? f.emitEvent("session.inbox.enqueued", "deleted") : initial
        const deletion = f.emitEvent("session.deleted", "deleted")
        held.resolve(undefined)
        await Promise.all([initial, pending, deletion])
        const binding = f.sessions.get("deleted")?.metadata?.[MEMORY_BINDING_KEY] as { identity: string }
        const root = join(f.env.OMO_MEMORY_HOME ?? "", "agents", binding.identity)
        const directory = join(root, "runtime", "accepted-turns")
        const name = readdirSync(directory).find(
          (file) =>
            file.endsWith(".json") &&
            (JSON.parse(readFileSync(join(directory, file), "utf8")) as { sessionID: string }).sessionID === "deleted",
        )
        if (name === undefined) throw new Error("Missing durable accepted-turn record")
        const file = join(directory, name)
        const persisted = JSON.parse(readFileSync(file, "utf8")) as { turns: number }
        expect(persisted.turns).toBe(1)
        writeFileSync(file, JSON.stringify({ ...persisted, turns: 7 }))
        await f.runTool(
          "memory",
          "deleted",
          create("reference/resumed.md", "Resumed counter", "durable data survives deletion"),
        )
        expect(
          execFileSync("git", ["-C", join(root, "repo"), "log", "-1", "--format=%B"], { encoding: "utf8" }),
        ).toContain("Omo-Turn: 7")
      } finally {
        held.resolve(undefined)
        read.mockRestore()
        await cleanup()
      }
    },
  )

  test("#given a root session #when it writes memory #then the seeded repo is created and one pinned block is projected per request", async () => {
    // given
    const f = fixture()
    f.addSession("root", { metadata: { "user.key": "kept" } })
    const cleanup = await registerMemoryComponent(f.host, f.options())
    // when
    const result = await f.runTool(
      "memory",
      "root",
      create("system/notes.md", "Working notes for this project", "token zebra-4711"),
    )
    const first = await f.context("root")
    const again = await f.context("root", first)
    // then
    expect(typeof result.metadata?.commit).toBe("string")
    const metadata = f.sessions.get("root")?.metadata ?? {}
    const repo = join(
      f.env.OMO_MEMORY_HOME ?? "",
      "agents",
      String((metadata[MEMORY_BINDING_KEY] as { identity: string }).identity),
      "repo",
    )
    expect(existsSync(join(repo, "system", "persona.md"))).toBe(true)
    expect(readFileSync(join(repo, "system", "notes.md"), "utf8")).toContain("zebra-4711")
    expect(partsWith(again, MEMORY_PART_MARKER)).toHaveLength(1)
    expect(partsWith(first, MEMORY_PART_MARKER)[0]?.text).toContain("zebra-4711")
    expect(metadata["user.key"]).toBe("kept")
    expect(metadata[PROJECTION_PIN_KEY]).toMatchObject({ version: 1, sessionId: "root" })
    await cleanup()
  })

  test("#given a pinned projection #when memory changes #then the block keeps the pin until a compaction repins it", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    const cleanup = await registerMemoryComponent(f.host, f.options())
    await f.runTool("memory", "root", create("system/notes.md", "Working notes for this project", "token alpha-1"))
    const pinned = partsWith(await f.context("root"), MEMORY_PART_MARKER)[0]?.text
    // when
    await f.runTool("memory_apply_patch", "root", {
      reason: "add beta",
      input:
        "*** Begin Patch\n*** Add File: system/later.md\n+---\n+description: Notes added after the pin\n+---\n+token beta-2\n*** End Patch",
    })
    const stillPinned = partsWith(await f.context("root"), MEMORY_PART_MARKER)[0]?.text
    await f.compaction("root")
    const repinned = partsWith(await f.context("root"), MEMORY_PART_MARKER)[0]?.text
    // then
    expect(stillPinned).toBe(pinned)
    expect(pinned).not.toContain("beta-2")
    expect(repinned).toContain("beta-2")
    await cleanup()
  })

  test("#given cleanup ran #then every hook, the tool and command transforms and the output, status and sync RPCs are disposed", async () => {
    // given
    const f = fixture()
    const cleanup = await registerMemoryComponent(f.host, f.options())
    const registered = [...f.rpcs.keys()].sort()
    // when
    await cleanup()
    await cleanup()
    // then
    expect(registered).toEqual(["omo-memory", "omo.memory", "omo.memory.sync"])
    expect([f.hooks.size, f.tools.size, f.commands.size, f.rpcs.size, f.disposals()]).toEqual([0, 0, 0, 0, 10])
  })
})
