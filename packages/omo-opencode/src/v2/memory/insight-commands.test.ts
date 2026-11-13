import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { GitMemoryRepo } from "@oh-my-opencode/memory-core"
import { OmoMemorySettingsSchema } from "@oh-my-opencode/omo-config-core"
import type { BoundMemorySession } from "./binding"
import { MEMORY_COMMAND_OUTPUT_EVENT } from "./command-output-event"
import { createDoctorCommand } from "./doctor-command"
import { registerMemoryComponent } from "./index"
import { createPalaceCommand } from "./palace-command"
import { createPeopleCommand } from "./people-command"
import { createBoundIdentity } from "./reflection.test-support"
import { createSleeptimeCommand } from "./sleeptime-command"
import { createMemoryFixture } from "./test-support"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

const HUMAN =
  '---\ndescription: who the user is\nkind: person\naliases: ["Boss"]\n---\n\nIDENTITY: the person you work with\nRELATIONSHIP: works-with: jane-doe\n'
const JANE =
  '---\ndescription: Person - Jane Doe\nkind: person\naliases: ["Jane","JD"]\n---\n\nIDENTITY: staff engineer\nRELATIONSHIP: reports-to: human\n'
const SKILL_WITHOUT_NAME = "---\ndescription: a skill with no name field\n---\n\nbody\n"

async function seeded(settings: Record<string, unknown> = {}): Promise<BoundMemorySession> {
  const created = createBoundIdentity()
  cleanups.push(created.cleanup)
  const bound: BoundMemorySession = { ...created.bound, settings: OmoMemorySettingsSchema.parse(settings) }
  const repo = new GitMemoryRepo({ dir: bound.paths.repo, agentId: bound.identity })
  await repo.init({
    authorName: "Insight Fixture",
    seedFiles: [
      { relativePath: "system/persona.md", content: "---\ndescription: who the agent is\n---\n\npersona\n" },
      { relativePath: "system/human.md", content: HUMAN },
      { relativePath: "people/jane-doe/card.md", content: JANE },
      { relativePath: "skills/tidy/SKILL.md", content: SKILL_WITHOUT_NAME },
    ],
  })
  return bound
}

describe("/doctor (S7c)", () => {
  test("#given no bound session #when /doctor runs #then it refuses with the unbound message", async () => {
    // given / when
    const result = await createDoctorCommand().run(undefined, "")

    // then
    expect(result).toEqual({ text: expect.stringContaining("memory is not bound to this session"), level: "error" })
  })

  test("#given a seeded identity with a skill missing its name #when /doctor runs #then it reports the checks and leaves the working tree untouched", async () => {
    // given
    const bound = await seeded()
    const skill = join(bound.paths.repo, "skills/tidy/SKILL.md")

    // when
    const result = await createDoctorCommand().run(bound, "")

    // then
    expect(result.text).toStartWith(`# Memory doctor: ${bound.identity}`)
    expect(result.text).toContain(`[ok] repository: ${bound.paths.repo}`)
    expect(result.text).toContain("[ok] reflection-health: streak 0; no recorded failure")
    expect(result.text).toContain("[info] skills: frontmatter repair is not run by this host's /doctor (read-only)")
    expect(readFileSync(skill, "utf8")).toBe(SKILL_WITHOUT_NAME)
  })

  test("#given a parked reflection identity #when /doctor runs #then the reflection-health line warns with the park and next probe", async () => {
    // given
    const bound = await seeded()
    mkdirSync(bound.paths.reflection, { recursive: true })
    writeFileSync(
      join(bound.paths.reflection, "park.json"),
      JSON.stringify({
        version: 1,
        streak: 3,
        parkedAt: "2026-11-12T00:00:00.000Z",
        lastFailure: {
          runId: "run-9",
          at: "2026-11-12T00:00:00.000Z",
          fingerprint: "fp-1",
          retryable: false,
          reason: "category_unavailable",
        },
      }),
    )

    // when
    const result = await createDoctorCommand().run(bound, "--json")

    // then
    const report = JSON.parse(result.text) as {
      level: string
      checks: { name: string; level: string; detail: string }[]
    }
    const health = report.checks.find((check) => check.name === "reflection-health")
    expect(result.level).toBe("warning")
    expect(health?.level).toBe("warn")
    expect(health?.detail).toContain(
      "automatic reflection paused since 2026-11-12T00:00:00.000Z (next probe 2026-11-12T06:00:00.000Z",
    )
  })

  test("#given an unknown flag #when /doctor runs #then it refuses with the flag named", async () => {
    // given
    const bound = await seeded()

    // when
    const result = await createDoctorCommand().run(bound, "--fix")

    // then
    expect(result).toEqual({ text: "unknown flag --fix", level: "error" })
  })
})

describe("/sleeptime (S7c)", () => {
  test("#given an identity override #when /sleeptime runs #then the resolved values carry the override mark and V2-only lines say what is unused", async () => {
    // given
    const created = createBoundIdentity()
    cleanups.push(created.cleanup)
    const settings = OmoMemorySettingsSchema.parse({
      agents: { [created.bound.identity]: { dream: { idle_minutes: 5 } } },
    })

    // when
    const result = await createSleeptimeCommand().run({ ...created.bound, settings }, "")

    // then
    expect(result.level).toBe("info")
    expect(result.text).toContain(`# Sleeptime reflection: ${created.bound.identity}`)
    expect(result.text).toContain("Dream idle: idle 5 minutes [agent override]")
    expect(result.text).toContain("Dream shutdown: not available on OpenCode (no shutdown event)")
    expect(result.text).toContain("Sandbox: not used on OpenCode")
  })

  test("#given no bound session #when /sleeptime runs #then it refuses", async () => {
    // given / when
    const result = await createSleeptimeCommand().run(undefined, "")

    // then
    expect(result.level).toBe("error")
  })
})

describe("/people (S7d)", () => {
  test("#given person cards #when /people runs without a name #then the roster and the derived edges are listed", async () => {
    // given
    const bound = await seeded()

    // when
    const result = await createPeopleCommand().run(bound, "")

    // then
    expect(result.level).toBe("info")
    expect(result.text).toContain("# People (2)")
    expect(result.text).toContain("works-with -> jane-doe")
  })

  test("#given an alias #when /people <alias> runs #then that person's card is rendered", async () => {
    // given
    const bound = await seeded()

    // when
    const result = await createPeopleCommand().run(bound, "JD")

    // then
    expect(result.text).toContain("# Jane Doe (jane-doe)")
    expect(result.text).toContain("IDENTITY: staff engineer")
  })

  test("#given --ask #when /people runs #then it is refused with an explicit message and nothing is read", async () => {
    // given
    const created = createBoundIdentity()
    cleanups.push(created.cleanup)

    // when
    const result = await createPeopleCommand().run(created.bound, 'jane --ask "what does she prefer?"')

    // then
    expect(result).toEqual({
      text: expect.stringContaining("/people --ask is not available on OpenCode yet"),
      level: "error",
    })
  })

  test("#given people records disabled #when /people runs #then it refuses", async () => {
    // given
    const bound = await seeded({ people: { enabled: false } })

    // when
    const result = await createPeopleCommand().run(bound, "")

    // then
    expect(result).toEqual({ text: "people records are disabled (memory.people.enabled)", level: "error" })
  })

  test("#given an unknown name #when /people runs #then the miss names the closest slugs", async () => {
    // given
    const bound = await seeded()

    // when
    const result = await createPeopleCommand().run(bound, "jane-do")

    // then
    expect(result).toEqual({ text: 'no person matches "jane-do"; closest slugs: jane-doe', level: "error" })
  })

  test("#given people records and a name near none of them #when /people runs #then the miss lists the known slugs", async () => {
    // given
    const bound = await seeded()

    // when
    const result = await createPeopleCommand().run(bound, "nobody-here")

    // then
    expect(result).toEqual({ text: 'no person matches "nobody-here"; known slugs: human, jane-doe', level: "error" })
  })
})

describe("/palace (S7d)", () => {
  test("#given a seeded identity #when /palace runs #then the viewer is written under the identity runtime and its path reported", async () => {
    // given
    const bound = await seeded()

    // when
    const result = await createPalaceCommand({ now: () => new Date("2026-11-12T01:02:03.000Z") }).run(bound, "")

    // then
    const path = join(bound.paths.viewers, "palace-2026-11-12T01-02-03-000Z.html")
    expect(result).toEqual({ text: `memory palace written to ${path}`, level: "info" })
    expect(dirname(path)).toBe(bound.paths.viewers)
    expect(statSync(path).isFile()).toBe(true)
    expect(readFileSync(path, "utf8")).toContain("jane-doe")
  })

  test("#given no bound session #when /palace runs #then it warns that there is nothing to render", async () => {
    // given / when
    const result = await createPalaceCommand().run(undefined, "")

    // then
    expect(result).toEqual({
      text: "memory is not bound in this session, so /palace has nothing to render",
      level: "warning",
    })
  })
})

describe("read-side command registration", () => {
  test("#given the memory component #when /sleeptime runs through the host #then the output takes the RPC event and the stripped record route", async () => {
    // given
    const f = createMemoryFixture()
    cleanups.push(() => {
      f.cleanup()
    })
    f.addSession("root")
    const cleanup = await registerMemoryComponent(f.host, f.options())
    const registered = ["doctor", "sleeptime", "people", "palace"].filter((name) => f.commands.has(name))

    // when
    await f.runCommand("sleeptime", "root")
    await cleanup()

    // then
    expect(registered).toEqual(["doctor", "sleeptime", "people", "palace"])
    expect(f.events.map((event) => event.name)).toEqual([MEMORY_COMMAND_OUTPUT_EVENT])
    expect(f.synthetics).toHaveLength(1)
    expect(f.synthetics[0]?.description).toBe("/sleeptime")
    expect(f.synthetics[0]?.resume).toBe(false)
  })
})
