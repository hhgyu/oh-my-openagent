import { afterEach, describe, expect, test } from "bun:test"
import { CORE_MEMORY_COMMANDS, REMEMBER_INSTRUCTION } from "@oh-my-opencode/memory-core/commands"
import {
  MEMORY_COMMAND_NAMES,
  MEMORY_COMMAND_OUTPUT_ID_PREFIX,
  MEMORY_COMMAND_OUTPUT_KEY,
  registerMemoryComponent,
} from "./index"
import { createMemoryFixture } from "./test-support"

const fixtures: ReturnType<typeof createMemoryFixture>[] = []
function fixture(settings: Record<string, unknown> = {}) {
  const created = createMemoryFixture(settings)
  fixtures.push(created)
  return created
}
afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup()
})

describe("memory commands", () => {
  test("#given the memory component #when it registers #then every host-neutral command is added under its OpenCode name and description", async () => {
    // given
    const f = fixture()
    // when
    const cleanup = await registerMemoryComponent(f.host, f.options())
    // then
    const core = Object.entries(CORE_MEMORY_COMMANDS).map(([name, entry]) => [
      MEMORY_COMMAND_NAMES[name as keyof typeof MEMORY_COMMAND_NAMES],
      entry.description,
    ])
    const registered = [...f.commands.values()].map((definition) => [definition.name, definition.description])
    expect(registered.slice(0, core.length)).toEqual(core)
    expect([...f.commands.keys()]).toEqual([
      "omo:memory",
      "omo:memfs",
      "omo:remember",
      "omo:init",
      "omo:recompile",
      "omo:memory-repository",
      "omo:search",
      "omo:facts",
      "omo:agreements",
      "omo:doctor",
      "omo:sleeptime",
      "omo:people",
      "omo:palace",
    ])
    await cleanup()
  })

  test("#given a bound root session #when /memfs init and /memory run #then each output is displayed now through the omo-memory event", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    f.addSession("other")
    const cleanup = await registerMemoryComponent(f.host, f.options())
    // when
    await f.runCommand("omo:memfs", "root", "init")
    await f.runCommand("omo:memory", "root")
    // then
    expect(f.events.map((event) => [event.rpcID, event.name])).toEqual([
      ["omo-memory", "command.output"],
      ["omo-memory", "command.output"],
    ])
    expect(f.events[0]?.data).toMatchObject({ sessionID: "root", command: "omo:memfs", level: "info" })
    expect(f.events[1]?.data).toMatchObject({ sessionID: "root", command: "omo:memory", level: "info" })
    expect(JSON.stringify(f.events[1]?.data)).toContain("# Memory: ")
    await cleanup()
  })

  test("#given a bound root session #when /memory runs #then the record is a non-resuming synthetic under a strippable output ID", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    const cleanup = await registerMemoryComponent(f.host, f.options())
    await f.runCommand("omo:memfs", "root", "init")
    // when
    await f.runCommand("omo:memory", "root")
    // then
    expect(
      f.synthetics.map((post) => [
        post.sessionID,
        post.resume,
        post.metadata?.[MEMORY_COMMAND_OUTPUT_KEY],
        post.metadata?.level,
      ]),
    ).toEqual([
      ["root", false, "omo:memfs", "info"],
      ["root", false, "omo:memory", "info"],
    ])
    for (const post of f.synthetics) expect(post.id ?? "").toStartWith(MEMORY_COMMAND_OUTPUT_ID_PREFIX)
    expect(new Set(f.synthetics.map((post) => post.id)).size).toBe(2)
    expect(f.synthetics[1]?.text).toStartWith("# Memory: ")
    await cleanup()
  })

  test("#given queued output records in a model request #when the context and compaction hooks run #then only the records are removed", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    const cleanup = await registerMemoryComponent(f.host, f.options())
    const request = () => [
      { id: "msg_user_1" },
      { id: `${MEMORY_COMMAND_OUTPUT_ID_PREFIX}a` },
      {},
      { id: `${MEMORY_COMMAND_OUTPUT_ID_PREFIX}b` },
      { id: "msg_assistant_2" },
    ]
    const compacted = request()
    // when
    const sent = await f.requestMessages("root", request())
    await f.compaction("root", compacted)
    // then
    expect(sent).toEqual([{ id: "msg_user_1" }, {}, { id: "msg_assistant_2" }])
    expect(compacted).toEqual([{ id: "msg_user_1" }, {}, { id: "msg_assistant_2" }])
    await cleanup()
  })

  test("#given a subagent child session #when /memory runs #then the unbound refusal is posted to the child as an error", async () => {
    // given
    const f = fixture()
    f.addSession("child", { parentID: "root" })
    const cleanup = await registerMemoryComponent(f.host, f.options())
    // when
    await f.runCommand("omo:memory", "child")
    // then
    expect(f.synthetics).toHaveLength(1)
    expect(f.synthetics[0]).toMatchObject({
      sessionID: "child",
      resume: false,
      metadata: { [MEMORY_COMMAND_OUTPUT_KEY]: "omo:memory", level: "error" },
    })
    expect(f.synthetics[0]?.text).toContain("memory is not bound to this session")
    await cleanup()
  })

  test("#given a bound session without a memory repository #when /omo:memory runs #then the commands its output names are the V2 commands", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    const cleanup = await registerMemoryComponent(f.host, f.options())
    // when
    await f.runCommand("omo:memory", "root")
    // then
    const shown = String(f.events[0]?.data && (f.events[0].data as { text?: unknown }).text)
    const recorded = f.synthetics[0]?.text ?? ""
    expect(shown).toBe(recorded)
    expect(recorded).toContain("/omo:memfs init")
    expect(recorded).toContain("/omo:init")
    expect(recorded).not.toMatch(/(^|[\s(`])\/(memfs|init|memory)\b/)
    await cleanup()
  })

  test("#given a bound root session #when /remember runs #then one resuming memory turn is admitted and no read-only ack is posted", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    const cleanup = await registerMemoryComponent(f.host, f.options())
    // when
    await f.runCommand("omo:remember", "root", "I prefer tabs")
    // then
    expect(f.synthetics).toHaveLength(1)
    expect(f.synthetics[0]).toMatchObject({
      sessionID: "root",
      resume: true,
      delivery: "steer",
      text: `${REMEMBER_INSTRUCTION}\n\nI prefer tabs`,
    })
    expect(f.synthetics[0]?.id).toBeUndefined()
    expect(f.events).toEqual([])
    await cleanup()
  })

  test("#given the memory turn admission fails #when /remember runs #then the failure is posted as an error and nothing throws into the host", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    f.syntheticFailure = (input) => (input.resume === true ? new Error("inbox closed") : undefined)
    const cleanup = await registerMemoryComponent(f.host, f.options())
    // when
    const run = f.runCommand("omo:remember", "root", "I prefer tabs")
    // then
    await expect(run).resolves.toBeUndefined()
    expect(f.synthetics).toEqual([
      expect.objectContaining({ sessionID: "root", resume: false, text: "/omo:remember failed: inbox closed" }),
    ])
    expect(f.synthetics[0]?.metadata?.level).toBe("error")
    expect(f.events.map((event) => event.data)).toEqual([
      { sessionID: "root", command: "omo:remember", level: "error", text: "/omo:remember failed: inbox closed" },
    ])
    await cleanup()
  })

  test("#given posting itself fails #when a command runs #then the failure is logged and the command still resolves", async () => {
    // given
    const f = fixture()
    f.addSession("root")
    f.syntheticFailure = () => new Error("session gone")
    const warnings: string[] = []
    const cleanup = await registerMemoryComponent(
      f.host,
      f.options({
        logger: {
          warn: (message) => {
            warnings.push(message)
          },
        },
      }),
    )
    // when
    const run = f.runCommand("omo:memory", "root")
    // then
    await expect(run).resolves.toBeUndefined()
    expect(warnings).toContain("memory command output was not posted")
    await cleanup()
  })

  test("#given a journaled session #when /search runs #then matches come from the identity's transcript journals", async () => {
    // given
    const f = fixture()
    f.addSession("root", {
      messages: [{ id: "msg_1", type: "user", text: "my coffee order is a flat white", time: { created: 1 } }],
    })
    const cleanup = await registerMemoryComponent(f.host, f.options())
    await f.idle("root")
    // when
    await f.runCommand("omo:search", "root", "flat white")
    // then
    expect(f.synthetics).toHaveLength(1)
    expect(f.synthetics[0]?.metadata?.level).toBe("info")
    expect(f.synthetics[0]?.text).toContain("session root")
    expect(f.synthetics[0]?.text).toContain("**flat** **white**")
    await cleanup()
  })
})
