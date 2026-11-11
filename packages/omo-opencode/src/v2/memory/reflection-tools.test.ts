import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { createNodeGitExec, validateCompletion } from "@oh-my-opencode/memory-core"
import type { AgentEditor } from "@opencode/plugin/promise/agent"
import { REFLECTION_AGENT_ID, REFLECTION_PERMISSIONS, registerReflectionAgent } from "./reflection-agent"
import { REFLECTION_PERSONA } from "./reflection-persona"
import { createReflectionRunScope } from "./reflection-run-scope"
import { createReflectionTools, REFLECTION_FOREIGN_SESSION_MESSAGE, REFLECTION_TOOL_NAMES } from "./reflection-tools"
import { createReflectionFixture, refusal, REFLECTION_TEST_AGENT, runTool, toolContext, type ReflectionFixture } from "./reflection.test-support"

setDefaultTimeout(process.platform === "win32" ? 30_000 : 10_000)

const fixtures: ReflectionFixture[] = []
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup() })

async function setup() {
  const fixture = await createReflectionFixture()
  fixtures.push(fixture)
  const scope = createReflectionRunScope({ runId: "run-1", worktreeDir: fixture.worktree.dir, transcriptPath: fixture.transcriptPath, agentId: REFLECTION_TEST_AGENT })
  const [read, list, grep, memory] = createReflectionTools(sessionID => sessionID === "ses_reflection_1" ? scope : undefined)
  return { fixture, scope, read, list, grep, memory, child: toolContext("ses_reflection_1") }
}

describe("reflection tools", () => {
  describe("#given a session that is not an issued reflection child", () => {
    test("#when it calls any reflection tool #then each call is refused with a model-visible error and nothing is written", async () => {
      // given
      const { fixture, read, list, grep, memory } = await setup()
      const foreign = toolContext("ses_root")

      // when
      const messages = await Promise.all([
        refusal(runTool(read, { target: "transcript" }, foreign)),
        refusal(runTool(list, {}, foreign)),
        refusal(runTool(grep, { pattern: "tabs", target: "transcript" }, foreign)),
        refusal(runTool(memory, { command: "create", reason: "chore(reflection): x", file_path: "reference/x.md", description: "x", file_text: "x" }, foreign)),
      ])

      // then
      expect(messages).toEqual(REFLECTION_TOOL_NAMES.map(name => `${name}: ${REFLECTION_FOREIGN_SESSION_MESSAGE}`))
      expect(existsSync(join(fixture.worktree.dir, "reference", "x.md"))).toBe(false)
    })
  })

  describe("#given the issued reflection child", () => {
    test("#when it reads the transcript and the worktree #then both are returned in numbered lines", async () => {
      // given
      const { read, list, grep, child } = await setup()

      // when
      const transcript = await runTool(read, { target: "transcript", offset: 1, limit: 3 }, child)
      const persona = await runTool(read, { path: "system/persona.md" }, child)
      const tree = await runTool(list, {}, child)
      const hits = await runTool(grep, { pattern: "TABS", target: "transcript", ignore_case: true }, child)

      // then
      expect(String(transcript.content)).toStartWith("transcript: lines 1-3 of")
      expect(String(persona.content)).toContain("4: I am helpful.")
      expect(String(tree.content)).toContain("system/persona.md (")
      expect(String(tree.content)).not.toContain(".git")
      expect(String(hits.content)).toContain("transcript:")
    })

    test("#when it names a path outside the worktree #then traversal, absolute, Git and symlink escapes are refused", async () => {
      // given
      const { fixture, read, list, grep, child } = await setup()
      // A junction needs no symlink privilege on Windows; elsewhere it is an ordinary directory symlink.
      symlinkSync(fixture.outside, join(fixture.worktree.dir, "escape"), "junction")

      // when
      const traversal = await refusal(runTool(read, { path: "../../outside/secret.md" }, child))
      const absolute = await refusal(runTool(read, { path: join(fixture.outside, "secret.md") }, child))
      const git = await refusal(runTool(read, { path: ".git" }, child))
      const symlink = await refusal(runTool(read, { path: "escape/secret.md" }, child))
      const grepEscape = await refusal(runTool(grep, { pattern: "secret", path: "escape" }, child))
      const tree = await runTool(list, {}, child)
      const everywhere = await runTool(grep, { pattern: "outside secret" }, child)

      // then
      expect(traversal).toContain("path_traversal")
      expect(absolute).toContain("path_absolute")
      expect(git).toContain("path_git")
      expect(symlink).toContain("path_escape")
      expect(grepEscape).toContain("path_escape")
      expect(String(tree.content)).not.toContain("escape")
      expect(everywhere.content).toBe("no matches")
    })

    test("#when it edits through reflection_memory #then each edit is a real commit on the run branch and the run validates", async () => {
      // given
      const { fixture, scope, memory, read, child } = await setup()

      // when
      const result = await runTool(memory, {
        command: "create", reason: "feat(reflection): record indentation preference\n\nUpdates:\n- tabs preference",
        file_path: "reference/preferences.md", description: "Coding style preferences of the user", file_text: "Prefers tabs.\n",
      }, child)
      const written = await runTool(read, { path: "reference/preferences.md" }, child)

      // then
      const exec = createNodeGitExec()
      const tip = await exec.run(["rev-parse", "HEAD"], { cwd: fixture.worktree.dir, timeoutMs: 30_000 })
      const branch = await exec.run(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: fixture.worktree.dir, timeoutMs: 30_000 })
      expect(scope.commits()).toEqual([tip.stdout.trim()])
      expect(result.metadata).toEqual({ commit: tip.stdout.trim(), paths: ["reference/preferences.md"] })
      expect(branch.stdout.trim()).toBe(fixture.worktree.branch)
      expect(await fixture.parent.head()).toBe(fixture.worktree.baseSha)
      expect(String(written.content)).toContain("Prefers tabs.")
      const validation = await validateCompletion(fixture.worktree, fixture.worktree.baseSha)
      expect(validation.status).toBe("valid")
    })

    test("#when the run was deactivated #then a later edit is refused", async () => {
      // given
      const { scope, memory, child } = await setup()
      scope.deactivate()

      // when
      const message = await refusal(runTool(memory, { command: "create", reason: "chore(reflection): late", file_path: "reference/late.md", description: "late", file_text: "x" }, child))

      // then
      expect(message).toContain("no longer active")
    })
  })
})

describe("omo-reflection agent", () => {
  test("#given the agent permissions #then everything is denied except exactly the four reflection tools", () => {
    // given
    const allowed = REFLECTION_PERMISSIONS.filter(rule => rule.effect === "allow").map(rule => rule.action)

    // then
    expect(REFLECTION_PERMISSIONS[0]).toEqual({ action: "*", resource: "*", effect: "deny" })
    expect(allowed.toSorted()).toEqual(["reflection_grep", "reflection_list", "reflection_memory", "reflection_read"])
    expect(REFLECTION_PERMISSIONS.filter(rule => rule.effect === "deny")).toHaveLength(1)
  })

  test("#given the agent domain #when the agent is registered #then it is a hidden subagent with the persona and the confined permissions", async () => {
    // given
    const agents = new Map<string, Record<string, unknown>>()
    const editor = { update: (id: string, apply: (agent: Record<string, unknown>) => void) => { const agent = agents.get(id) ?? {}; apply(agent); agents.set(id, agent) } }

    // when
    // The double implements only `update`, the one editor method the registration calls.
    await registerReflectionAgent({ transform: async apply => { apply(editor as unknown as AgentEditor); return { dispose: async () => undefined } } })

    // then
    const agent = agents.get(REFLECTION_AGENT_ID)
    expect(agent?.mode).toBe("subagent")
    expect(agent?.hidden).toBe(true)
    expect(agent?.system).toBe(REFLECTION_PERSONA)
    expect(agent?.permissions).toEqual(REFLECTION_PERMISSIONS.map(rule => ({ ...rule })))
  })
})

