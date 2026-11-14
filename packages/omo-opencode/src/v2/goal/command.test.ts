import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GOAL_CONTINUATION_METADATA_KEY } from "../hooks/continuation-metadata"
import { createUlwLoopStatusRpc } from "../ulw-loop/status-rpc"
import { registerGoal } from "./component"
import { GOAL_COMMAND_RPC_ID } from "./command-output-event"
import { goalStoreFile, goalStoreRef } from "./store-ref"
import { fakeGoalHost } from "./test-support"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup() {
  const directory = mkdtempSync(join(tmpdir(), "v2-goal-command-"))
  roots.push(directory)
  const fake = fakeGoalHost(directory)
  const footer = createUlwLoopStatusRpc()
  const footerGoals: unknown[] = []
  await footer.register({
    register: async () => ({
      events: {
        emit: async (_name: string, data: unknown) => void footerGoals.push((data as { goal?: unknown }).goal),
      },
      dispose: async () => {},
    }),
  } as never)
  const dispose = await registerGoal(fake.host, { timers: fake.timers, footer })
  const file = (sessionID = "ses_a") => goalStoreFile(goalStoreRef(directory, sessionID))
  const stored = (sessionID = "ses_a") =>
    existsSync(file(sessionID)) ? JSON.parse(readFileSync(file(sessionID), "utf8")).goal : null
  const shown = () => fake.outputs.map((output) => output.data as { command: string; level: string; text: string })
  return { fake, dispose, stored, shown, footerGoals }
}

const BARE_GOAL_COMMAND = /(^|[\s(`"'])\/goal\b/

describe("V2 /omo:goal command", () => {
  test("#given the goal component #when it registers #then the engine's goal command is added as omo:goal and nothing as goal", async () => {
    // given
    const { fake, dispose } = await setup()

    // then
    expect(fake.commands.map((command) => command.name)).toEqual(["omo:goal"])
    await dispose()
  })

  test("#given an idle session without a goal #when /omo:goal sets an objective #then the session's store holds it active and one goal continuation starts", async () => {
    // given
    const { fake, dispose, stored, shown } = await setup()

    // when
    await fake.command("omo:goal", "ses_a", "port the goal command")

    // then
    expect(stored()).toMatchObject({ threadId: "ses_a", objective: "port the goal command", status: "active" })
    expect(stored("ses_b")).toBeNull()
    expect(fake.outputs.map((output) => [output.rpcID, output.name])).toEqual([[GOAL_COMMAND_RPC_ID, "command.output"]])
    expect(shown()[0]).toMatchObject({ command: "omo:goal", level: "info" })
    expect(shown()[0]?.text).toContain("port the goal command")
    expect(fake.synthetic).toEqual([
      expect.objectContaining({
        sessionID: "ses_a",
        resume: true,
        metadata: { [GOAL_CONTINUATION_METADATA_KEY]: "1" },
      }),
    ])
    await dispose()
  })

  test("#given an active goal #when /omo:goal pause, resume and clear run #then the store follows each step and texts name /omo:goal", async () => {
    // given
    const { fake, dispose, stored, shown, footerGoals } = await setup()
    await fake.call("create_goal", { objective: "drive the subcommands" }, "ses_a")

    // when
    await fake.command("omo:goal", "ses_a", "pause")
    const paused = stored()
    const pausedFooter = footerGoals.at(-1)
    await fake.command("omo:goal", "ses_a", "resume")
    const resumed = stored()
    await fake.command("omo:goal", "ses_a", "clear")

    // then
    expect(paused?.status).toBe("paused")
    expect(String(pausedFooter)).toContain("/omo:goal resume")
    expect(resumed?.status).toBe("active")
    expect(stored()).toBeNull()
    expect(shown().map((output) => output.level)).toEqual(["info", "info", "info"])
    for (const output of shown()) expect(output.text).not.toMatch(BARE_GOAL_COMMAND)
    expect(fake.synthetic.filter((post) => post["resume"] === true)).toHaveLength(1)
    await dispose()
  })

  test("#given a goal set by /omo:goal #when it is paused and resumed with no new output since its continuation #then the resume's continuation is a new session message", async () => {
    // given
    const { fake, dispose } = await setup()
    await fake.command("omo:goal", "ses_a", "resume twice")
    await fake.event("session.execution.started", { sessionID: "ses_a" })
    await fake.turn("ses_a", {})
    await fake.event("session.execution.succeeded", { sessionID: "ses_a" })

    // when
    await fake.command("omo:goal", "ses_a", "pause")
    await fake.command("omo:goal", "ses_a", "resume")

    // then
    const continuations = fake.synthetic.filter((post) => post["resume"] === true)
    expect(continuations).toHaveLength(2)
    expect(new Set(continuations.map((post) => post["id"])).size).toBe(2)
    await dispose()
  })

  test("#given no goal #when /omo:goal shows it #then the usage names /omo:goal as a warning", async () => {
    // given
    const { fake, dispose, shown } = await setup()

    // when
    await fake.command("omo:goal", "ses_a")

    // then
    expect(shown()).toEqual([expect.objectContaining({ command: "omo:goal", level: "warning" })])
    expect(shown()[0]?.text).toContain("/omo:goal <objective>")
    expect(shown()[0]?.text).not.toMatch(BARE_GOAL_COMMAND)
    await dispose()
  })

  test("#given a goal stopped for stale progress #when get_goal reads it #then the tool text and the footer name /omo:goal", async () => {
    // given
    const { fake, dispose, stored, footerGoals } = await setup()
    await fake.call("create_goal", { objective: "stop stale" }, "ses_a")
    await fake.turn("ses_a", { tools: [{ tool: "bash", input: { command: "ls" }, output: "ran ls" }], text: "Same." })
    await fake.idle("ses_a")
    await fake.turn("ses_a", { text: "Same." })
    await fake.idle("ses_a")

    // when
    const result = await fake.call("get_goal", {}, "ses_a")

    // then
    expect(stored()).toMatchObject({ status: "active", continuationStoppedAt: expect.any(Number) })
    const text = result.content.map((part) => ("text" in part ? part.text : "")).join("\n")
    expect(text).toContain("/omo:goal resume")
    expect(text).not.toMatch(BARE_GOAL_COMMAND)
    for (const goal of footerGoals) expect(String(goal)).not.toMatch(BARE_GOAL_COMMAND)
    await dispose()
  })
})
