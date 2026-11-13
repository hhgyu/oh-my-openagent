import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { REFLECTION_GREP_LIMITS } from "./reflection-grep-guard"
import { runReflectionGrep } from "./reflection-read-tools"
import { createReflectionRunScope } from "./reflection-run-scope"
import { createReflectionTools } from "./reflection-tools"
import {
  createReflectionFixture,
  refusal,
  REFLECTION_TEST_AGENT,
  runTool,
  toolContext,
  type ReflectionFixture,
} from "./reflection.test-support"

setDefaultTimeout(process.platform === "win32" ? 30_000 : 10_000)

const fixtures: ReflectionFixture[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})

async function setup() {
  const fixture = await createReflectionFixture()
  fixtures.push(fixture)
  const scope = createReflectionRunScope({
    runId: "run-1",
    worktreeDir: fixture.worktree.dir,
    transcriptPath: fixture.transcriptPath,
    agentId: REFLECTION_TEST_AGENT,
  })
  const grep = createReflectionTools((sessionID) => (sessionID === "ses_reflection_1" ? scope : undefined))[2]
  return { fixture, scope, grep, child: toolContext("ses_reflection_1") }
}

describe("reflection_grep pattern bounds", () => {
  test("#given catastrophic or unbounded patterns #when the child greps #then each is refused with a model-visible pattern_unsafe reason before matching", async () => {
    // given
    const { grep, child } = await setup()
    const patterns = [
      "(a+)+$",
      "(a|aa)*b",
      "(?:\\w*\\s?)*x",
      "(\\w+)\\1",
      "(?<w>a)\\k<w>",
      ".*.*.*.*x",
      "x".repeat(REFLECTION_GREP_LIMITS.patternChars + 1),
    ]

    // when
    const refusals = await Promise.all(patterns.map((pattern) => refusal(runTool(grep, { pattern }, child))))

    // then
    for (const message of refusals) expect(message).toContain('"rejected":"pattern_unsafe"')
    expect(refusals[0]).toContain("quantified group contains another quantifier")
    expect(refusals[1]).toContain("quantified group contains an alternation")
    expect(refusals[3]).toContain("backreferences")
    expect(refusals[5]).toContain("unbounded quantifiers")
    expect(refusals[6]).toContain("longer than")
  })

  test("#given ordinary patterns #when the child greps #then they still search", async () => {
    // given
    const { grep, child } = await setup()

    // when
    const results = await Promise.all(
      ["(?:tabs|spaces)", "prefers (tabs)?", "u\\w{2,8}r", "(user )?prefers"].map((pattern) =>
        runTool(grep, { pattern, target: "transcript" }, child),
      ),
    )

    // then
    for (const result of results) expect(String(result.content)).toContain("transcript:")
  })

  test("#given a match only past the bounded line prefix #when the child greps #then the line is not matched", async () => {
    // given
    const { fixture, scope } = await setup()
    writeFileSync(
      join(fixture.worktree.dir, "long.md"),
      `${"a".repeat(REFLECTION_GREP_LIMITS.matchChars)}needle\nneedle early\n`,
    )

    // when
    const output = await runReflectionGrep(scope, { pattern: "needle", path: "long.md" })

    // then
    expect(output).toBe("long.md:2: needle early")
  })

  test("#given a search that outlives its time budget #when the clock passes the budget #then it stops and says so", async () => {
    // given
    const { fixture, scope } = await setup()
    writeFileSync(
      join(fixture.worktree.dir, "many.md"),
      Array.from({ length: 50 }, (_, index) => `line ${index} tabs`).join("\n"),
    )
    let now = 0
    const clock = (): number => {
      now += REFLECTION_GREP_LIMITS.budgetMs / 4
      return now
    }

    // when
    const output = await runReflectionGrep(scope, { pattern: "tabs", path: "many.md" }, clock)

    // then
    const lines = output.split("\n")
    expect(lines.at(-1)).toBe(
      `[search stopped after ${REFLECTION_GREP_LIMITS.budgetMs} ms; narrow the pattern or path]`,
    )
    expect(lines.length).toBeLessThan(10)
  })
})
