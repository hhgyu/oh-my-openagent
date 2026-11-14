import { afterEach, describe, expect, test } from "bun:test"
import { createBoulderState, writeBoulderState, type ContinuableWork } from "@oh-my-opencode/boulder-state"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ULW_EXECUTE_STEERING_REMINDER } from "@oh-my-opencode/boulder-state"
import { fakeUlwLoopHost } from "../ulw-loop/test-support"
import { registerUlwExecuteContinuation } from "./component"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function projectWithWork(sessionKey: string): string {
  const root = mkdtempSync(join(tmpdir(), "v2-ulwx-"))
  roots.push(root)
  mkdirSync(join(root, ".omo", "plans"), { recursive: true })
  const plan = join(root, ".omo", "plans", "port.md")
  writeFileSync(plan, "# Port\n\n## TODOs\n\n- [x] 1. map\n- [ ] 2. build\n- [ ] 3. verify\n")
  writeBoulderState(root, createBoulderState(plan, sessionKey))
  return root
}

function register(directory: string, findWork?: (directory: string, sessionKey: string) => ContinuableWork | null) {
  const fake = fakeUlwLoopHost()
  ;(fake.host.location as { directory: string }).directory = directory
  const registered = registerUlwExecuteContinuation(fake.host, { skillFile: null, ...(findWork && { findWork }) })
  return { ...fake, registered }
}

describe("V2 ulw-execute continuation", () => {
  test("#given a boulder work this session owns with unchecked boxes #when it settles #then one hidden steer continuation names the plan and the opencode session key", async () => {
    // given
    const directory = projectWithWork("opencode:ses_a")
    const { idle, synthetic, registered } = register(directory)
    const dispose = await registered

    // when
    await idle("ses_a")
    await idle("ses_a")

    // then
    expect(synthetic).toEqual([
      expect.objectContaining({
        sessionID: "ses_a",
        delivery: "steer",
        resume: true,
        id: expect.stringMatching(/^msg_omo_ulwx_[0-9a-f]+$/),
        text: expect.stringContaining("Your session id in boulder.json: opencode:ses_a"),
      }),
    ])
    expect(String(synthetic[0]?.["text"])).toContain("Remaining top-level checkboxes: 2 of 3")
    await dispose()
  })

  test("#given a work another session owns #when this session settles #then nothing is injected", async () => {
    // given
    const directory = projectWithWork("opencode:ses_other")
    const { idle, synthetic, registered } = register(directory)
    const dispose = await registered

    // when
    await idle("ses_a")

    // then
    expect(synthetic).toEqual([])
    await dispose()
  })

  test("#given the continuation cap #when a real user prompt arrives #then the budget restarts, and the host's own continuation never restarts it", async () => {
    // given
    let round = 0
    const work = (): ContinuableWork => ({
      work: { work_id: "w1", plan_name: "port", started_at: `t${round++}`, session_ids: ["opencode:ses_a"] } as never,
      planPath: "/plan.md",
      checklist: { completed: 1, remaining: 2, total: 3, nextTaskLabel: "2. build" } as never,
    })
    const { idle, prompt, synthetic, registered } = register("/project", () => work())
    const dispose = await registered
    for (let index = 0; index < 10; index++) await idle("ses_a")
    const capped = synthetic.length

    // when
    await prompt("ses_a", "continuation", synthetic.at(-1)?.["metadata"] as Record<string, unknown>)
    await idle("ses_a")
    const afterOwn = synthetic.length
    await prompt("ses_a", "keep going")
    await idle("ses_a")

    // then
    expect(capped).toBe(8)
    expect(afterOwn).toBe(8)
    expect(synthetic.length).toBe(9)
    await dispose()
  })

  test("#given a continuable work #when the user steers a running turn #then the ulw-execute reminder is appended only mid-run", async () => {
    // given
    const directory = projectWithWork("opencode:ses_a")
    const { prompt, event, registered } = register(directory)
    const dispose = await registered

    // when
    const idleText = await prompt("ses_a", "first")
    await event("session.execution.started", "ses_a")
    const runningText = await prompt("ses_a", "steer")

    // then
    expect(idleText).toBe("first")
    expect(runningText).toBe(`steer\n\n${ULW_EXECUTE_STEERING_REMINDER}`)
    await dispose()
  })
})
