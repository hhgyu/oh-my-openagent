import { afterEach, describe, expect, test } from "bun:test"
import { createBoulderState, writeBoulderState } from "@oh-my-opencode/boulder-state"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GOAL_CONTINUATION_METADATA_KEY, ULW_EXECUTE_CONTINUATION_METADATA_KEY } from "../hooks/continuation-metadata"
import { createIdleContinuationChain } from "../hooks/idle-continuation-chain"
import { registerUlwExecuteContinuation } from "../ulw-execute/component"
import { createUlwLoopStatusRpc } from "../ulw-loop/status-rpc"
import { registerGoal } from "./component"
import { loadGoalEngine } from "./engine"
import { goalStoreFile, goalStoreRef } from "./store-ref"
import { fakeGoalHost, type FakeGoalHost } from "./test-support"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(options: { footer?: ReturnType<typeof createUlwLoopStatusRpc> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "v2-goal-loop-"))
  roots.push(directory)
  const fake = fakeGoalHost(directory)
  const dispose = await registerGoal(fake.host, { timers: fake.timers, ...options })
  const file = goalStoreFile(goalStoreRef(directory, "ses_a"))
  const stored = () => JSON.parse(readFileSync(file, "utf8")).goal
  return { fake, dispose, file, stored }
}

async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
}

const workTurn = (fake: FakeGoalHost, text = "Ported the store.", command = "ls") =>
  fake.turn("ses_a", { tools: [{ tool: "bash", input: { command }, output: `ran ${command}` }], text })

describe("V2 goal continuation", () => {
  test("#given an active goal and a finished tool turn #when the session settles #then one hidden goal continuation carries the engine's prompt and the store counts it", async () => {
    // given
    const { fake, dispose, stored } = await setup()
    await fake.call("create_goal", { objective: "port the goal loop" }, "ses_a")
    await workTurn(fake)

    // when
    await fake.idle("ses_a")

    // then
    const engine = await loadGoalEngine()
    expect(fake.synthetic).toEqual([
      expect.objectContaining({
        sessionID: "ses_a",
        delivery: "steer",
        resume: true,
        id: expect.stringMatching(/^msg_omo_goal_[0-9a-f]+$/),
        metadata: { [GOAL_CONTINUATION_METADATA_KEY]: "1" },
      }),
    ])
    expect(fake.synthetic[0]?.["text"]).toBe(engine.prompt.buildContinuationPrompt(stored()))
    expect(stored()).toMatchObject({ consecutiveContinuations: 1, lastContinuationSignature: expect.any(String) })
    await dispose()
  })

  test("#given no goal, or a completed one #when the session settles #then nothing is continued", async () => {
    // given
    const { fake, dispose } = await setup()
    await workTurn(fake)
    await fake.idle("ses_a")
    await fake.call("create_goal", { objective: "finish quickly" }, "ses_a")
    await fake.call("update_goal", { status: "complete" }, "ses_a")
    await workTurn(fake, "Done.", "pwd")

    // when
    await fake.idle("ses_a")

    // then
    expect(fake.synthetic).toEqual([])
    await dispose()
  })

  test("#given a continuation already answered by the same unchanged narration #when the session settles again #then the engine's stale guard stops the window without another continuation", async () => {
    // given
    const { fake, dispose, stored } = await setup()
    await fake.call("create_goal", { objective: "avoid loops" }, "ses_a")
    await workTurn(fake, "Still working.")
    await fake.idle("ses_a")

    // when
    await fake.turn("ses_a", { text: "Still working." })
    await fake.idle("ses_a")

    // then
    expect(fake.synthetic).toHaveLength(1)
    expect(stored()).toMatchObject({ status: "active", continuationStoppedAt: expect.any(Number) })
    await dispose()
  })

  test("#given the continuation cap #when the session settles #then the goal blocks with the engine's reason, and the user's next message reactivates it", async () => {
    // given
    const { fake, dispose, file, stored } = await setup()
    await fake.call("create_goal", { objective: "respect the cap" }, "ses_a")
    const engine = await loadGoalEngine()
    const goal = stored()
    const signature = engine.continuation.buildGoalContinuationSignature(
      goal,
      0,
      0,
      engine.continuation.hashAssistantText("Capped."),
    )
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        goal: { ...goal, consecutiveContinuations: 8, lastContinuationSignature: signature },
      }),
    )
    await workTurn(fake, "Capped.")

    // when
    await fake.idle("ses_a")
    const blocked = stored()
    await fake.prompt("ses_a", "keep going")

    // then
    expect(fake.synthetic).toEqual([])
    expect(blocked).toMatchObject({ status: "blocked", blockedReason: "continuation cap reached" })
    expect(stored()).toMatchObject({ status: "active", consecutiveContinuations: 0 })
    await dispose()
  })

  test("#given a turn the user started #when it settles #then the goal waits the engine's grace period and continues only if the session is still idle", async () => {
    // given
    const { fake, dispose } = await setup()
    await fake.call("create_goal", { objective: "wait for the user" }, "ses_a")
    await fake.event("session.execution.started", { sessionID: "ses_a" })
    await fake.prompt("ses_a", "please also update the docs")
    await workTurn(fake)

    // when
    await fake.idle("ses_a")
    const immediate = fake.synthetic.length
    await fake.event("session.execution.succeeded", { sessionID: "ses_a" })
    const grace = fake.armed.at(-1)
    await grace?.fire()

    // then
    const engine = await loadGoalEngine()
    expect(immediate).toBe(0)
    expect(grace?.ms).toBe(engine.continuation.GOAL_USER_GRACE_DELAY_MS)
    expect(fake.synthetic).toHaveLength(1)
    await dispose()
  })

  test("#given an armed grace period #when a new run starts before it fires #then it does not continue", async () => {
    // given
    const { fake, dispose } = await setup()
    await fake.call("create_goal", { objective: "stay out of the way" }, "ses_a")
    await fake.prompt("ses_a", "one more thing")
    await workTurn(fake)
    await fake.idle("ses_a")
    await fake.event("session.execution.succeeded", { sessionID: "ses_a" })

    // when
    await fake.event("session.execution.started", { sessionID: "ses_a" })
    await fake.armed.at(-1)?.fire()

    // then
    expect(fake.synthetic).toEqual([])
    await dispose()
  })

  test("#given an active goal #when the user interrupts the run #then the goal blocks as Native does", async () => {
    // given
    const { fake, dispose, stored } = await setup()
    await fake.call("create_goal", { objective: "stop on interrupt" }, "ses_a")

    // when
    await fake.event("session.execution.interrupted", { sessionID: "ses_a", reason: "user" })
    await until(() => stored().status !== "active")

    // then
    expect(stored()).toMatchObject({ status: "blocked", blockedReason: "user interrupted the turn" })
    await dispose()
  })

  test("#given background work still running #when the session settles #then the goal waits, and the backstop continues without spending the no-progress budget", async () => {
    // given
    const { fake, dispose, stored } = await setup()
    await fake.call("create_goal", { objective: "wait for the shell" }, "ses_a")
    await workTurn(fake)

    // when
    await fake.idle("ses_a", [{ kind: "shell", sessionID: "ses_a", shellID: "sh_1", command: "sleep" }])
    const immediate = fake.synthetic.length
    await fake.event("session.execution.succeeded", { sessionID: "ses_a" })
    const backstop = fake.armed.at(-1)
    await backstop?.fire()

    // then
    expect(immediate).toBe(0)
    expect(backstop?.ms).toBe(270_000)
    expect(fake.synthetic).toHaveLength(1)
    expect(stored()).toMatchObject({ consecutiveContinuations: 1, noProgressContinuations: 0 })
    await dispose()
  })

  test("#given the host's own goal continuation #when it arrives as a prompt #then it is not user input", async () => {
    // given
    const { fake, dispose } = await setup()
    await fake.call("create_goal", { objective: "keep counting" }, "ses_a")
    await workTurn(fake)
    await fake.idle("ses_a")

    // when
    await fake.prompt("ses_a", "continuation", fake.synthetic[0]?.["metadata"] as Record<string, unknown>)
    await workTurn(fake, "Next step done.", "git status")
    await fake.idle("ses_a")

    // then
    expect(fake.synthetic).toHaveLength(2)
    await dispose()
  })

  test("#given an active goal and a continuable boulder work for the same session #when it settles #then only the goal continues, and the work continues once the goal is complete", async () => {
    // given
    const directory = mkdtempSync(join(tmpdir(), "v2-goal-loop-"))
    roots.push(directory)
    mkdirSync(join(directory, ".omo", "plans"), { recursive: true })
    const plan = join(directory, ".omo", "plans", "port.md")
    writeFileSync(plan, "# Port\n\n## TODOs\n\n- [x] 1. map\n- [ ] 2. build\n")
    writeBoulderState(directory, createBoulderState(plan, "opencode:ses_a"))
    const fake = fakeGoalHost(directory)
    const idle = createIdleContinuationChain()
    const disposeExecute = await registerUlwExecuteContinuation(fake.host as never, { skillFile: null, idle })
    const disposeGoal = await registerGoal(fake.host, { timers: fake.timers, idle })
    const registration = await idle.register(fake.host.session)
    await fake.call("create_goal", { objective: "port the loop" }, "ses_a")
    await workTurn(fake)

    // when
    await fake.idle("ses_a")
    const whileGoalActive = fake.synthetic.map((entry) => Object.keys(entry["metadata"] as object)[0])
    await fake.call("update_goal", { status: "complete" }, "ses_a")
    await workTurn(fake, "Goal done.", "pwd")
    await fake.idle("ses_a")

    // then
    expect(whileGoalActive).toEqual([GOAL_CONTINUATION_METADATA_KEY])
    expect(Object.keys(fake.synthetic[1]?.["metadata"] as object)).toEqual([ULW_EXECUTE_CONTINUATION_METADATA_KEY])
    expect(fake.synthetic).toHaveLength(2)
    await registration.dispose()
    await disposeGoal()
    await disposeExecute()
  })

  test("#given the shared footer #when a goal is created and completed #then the footer carries the engine's goal status text", async () => {
    // given
    const footer = createUlwLoopStatusRpc()
    const emitted: unknown[] = []
    await footer.register({
      register: async () => ({
        events: { emit: async (_name: string, data: unknown) => void emitted.push(data) },
        dispose: async () => {},
      }),
    } as never)
    const { fake, dispose, stored } = await setup({ footer })

    // when
    await fake.call("create_goal", { objective: "light the footer" }, "ses_a")
    await fake.call("update_goal", { status: "complete" }, "ses_a")

    // then
    const engine = await loadGoalEngine()
    expect(emitted.at(0)).toEqual({ sessionID: "ses_a", active: false, goal: "Pursuing goal" })
    expect(emitted.at(-1)).toEqual({ sessionID: "ses_a", active: false, goal: engine.ui.goalStatusText(stored()) })
    await dispose()
  })
})
