import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSkillPrepend } from "@oh-my-opencode/senpi-task"
import type { DagToolResult } from "@oh-my-opencode/senpi-task/dag-operations"
import { createNativeDagGenerationLease } from "./lease"
import { preparedSkillHost, ROOT_CALLER } from "./skills-fixture"
import { createWorkflowHarness } from "./test-support"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const roots: string[] = [], cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const node = (id: string, prompt: string, loadSkills?: readonly string[], dependsOn?: readonly string[]) =>
  ({ id, prompt, category: "quick", ...(loadSkills && { load_skills: [...loadSkills] }), ...(dependsOn && { dependsOn: [...dependsOn] }) })
const skillAssert = (id: string) => ({ sessionID: ROOT_CALLER.sessionID, agent: ROOT_CALLER.agent, action: "skill", resources: [id] })

async function harness(authorized = true) {
  const directory = mkdtempSync(join(tmpdir(), "omo-v2-dag-skills-"))
  roots.push(directory)
  const lease = createNativeDagGenerationLease()
  cleanups.push(() => lease.dispose())
  const host = await preparedSkillHost(directory)
  const dag = createWorkflowHarness(directory, lease, ROOT_CALLER.sessionID, [], authorized ? host.authority : undefined)
  cleanups.push(() => dag.wake.close())
  return { dag, host }
}

function runIdOf(result: DagToolResult): string {
  if (result.details.kind !== "started") throw Error(`expected a start, got ${result.details.kind}`)
  return result.details.run_id
}

describe("OpenCode 2 workflow node skills (S6g)", () => {
  test("#given a node with an allowed skill #when started #then the root caller asserts its id once and the child's prompt carries Native's skill prepend", async () => {
    // given
    const { dag, host } = await harness()
    const location = host.addSkill("alpha", "ALPHA SKILL BODY")

    // when
    const started = await dag.call({ action: "start", detach: true, definition: { key: "s", name: "s", nodes: [node("a", "do a", ["alpha"]), node("b", "do b", ["alpha"])] } })
    const runId = runIdOf(started.result)

    // then
    const expected = buildSkillPrepend([{ name: "alpha", content: "ALPHA SKILL BODY", location }], "do a")
    expect(host.asserts).toEqual([skillAssert("alpha-id")])
    expect(started.fake.starts.find(start => start.nodeId === "a")?.spec.prompt).toBe(expected)
    expect(dag.record(runId).definition.nodes[0]?.effectivePrompt).toBe(expected)
    expect(existsSync(join(dag.runtime.store.paths.root, "skills", `${runId}.json`))).toBe(true)
  })

  test("#given a node whose skill the permission denies #when started #then the call fails with the denial and no run or child exists", async () => {
    // given
    const { dag, host } = await harness()
    host.addSkill("alpha", "ALPHA")
    host.addSkill("secret", "SECRET")
    host.denied.add("secret-id")

    // when
    const { fake, pending } = dag.begin({ action: "start", detach: true, definition: { key: "d", name: "d", nodes: [node("a", "do a", ["alpha"]), node("b", "do b", ["secret"])] } })
    const outcome = await pending.then(() => "started", (error: unknown) => String(error))

    // then
    expect(outcome).toContain("skill secret-id denied")
    expect(host.asserts).toEqual([skillAssert("alpha-id"), skillAssert("secret-id")])
    expect(dag.runtime.manager.list(ROOT_CALLER.sessionID)).toEqual([])
    expect(fake.starts).toEqual([])
  })

  test("#given a missing and a disabled skill #when started #then, like Native, neither is asserted, the node dispatches its plain prompt and each is a missing_skill diagnostic", async () => {
    // given
    const { dag, host } = await harness()
    host.addSkill("off", "DISABLED BODY")

    // when
    const started = await dag.call({ action: "start", detach: true, definition: { key: "m", name: "m", nodes: [node("a", "do a", ["nowhere", "off"])] } })
    const runId = runIdOf(started.result)

    // then
    expect(host.asserts).toEqual([])
    expect(started.fake.starts.map(start => start.spec.prompt)).toEqual(["do a"])
    expect(dag.record(runId).diagnostics.filter(entry => entry.kind === "missing_skill").map(entry => entry.kind === "missing_skill" && entry.skill)).toEqual(["nowhere", "off"])
  })

  test("#given a settled run #when amend changes a node and adds a skill published since #then that call asserts it against a fresh listing and the re-run child carries it", async () => {
    // given
    const { dag, host } = await harness()
    const definition = { key: "a", name: "a", nodes: [node("a", "first")] }
    const first = await dag.call({ action: "start", detach: true, definition })
    const runId = runIdOf(first.result)
    const settling = dag.begin({ action: "wait", run_id: runId, detach: false })
    first.fake.complete("a")
    await settling.pending
    const location = host.addSkill("beta", "BETA BODY")

    // when
    const amended = await dag.call({ action: "amend", run_id: runId, definition: { ...definition, nodes: [node("a", "second", ["beta"])] } })

    // then
    expect(amended.result.details.kind).toBe("amended")
    expect(host.asserts).toEqual([skillAssert("beta-id")])
    expect(amended.fake.starts.map(start => start.spec.prompt)).toEqual([buildSkillPrepend([{ name: "beta", content: "BETA BODY", location }], "second")])
  })

  test("#given a failed skilled node #when retried plainly, then with a prompt override #then the plain retry reuses the stored prompt unasserted and the override re-authorizes and re-materializes", async () => {
    // given
    const { dag, host } = await harness()
    const location = host.addSkill("alpha", "ALPHA V1")
    const first = await dag.call({ action: "start", detach: true, definition: { key: "r", name: "r", nodes: [node("a", "do a", ["alpha"])] } })
    const runId = runIdOf(first.result)
    first.fake.settle("a", "error")
    await dag.call({ action: "wait", run_id: runId, detach: false })

    // when
    const plain = dag.begin({ action: "retry", run_id: runId, detach: false })
    await plain.fake.whenStarted("a")
    plain.fake.settle("a", "error")
    await plain.pending
    const assertsAfterPlain = host.asserts.length
    const override = dag.begin({ action: "retry", run_id: runId, node_id: "a", prompt: "do a again", detach: false })
    await override.fake.whenStarted("a")
    override.fake.complete("a")
    await override.pending

    // then
    expect(plain.fake.starts.map(start => start.spec.prompt)).toEqual([buildSkillPrepend([{ name: "alpha", content: "ALPHA V1", location }], "do a")])
    expect(assertsAfterPlain).toBe(1)
    expect(host.asserts).toEqual([skillAssert("alpha-id"), skillAssert("alpha-id")])
    expect(override.fake.starts.map(start => start.spec.prompt)).toEqual([buildSkillPrepend([{ name: "alpha", content: "ALPHA V1", location }], "do a again")])
    expect(dag.record(runId).status).toBe("completed")
  })

  test("#given a settled run and a call with no skill authority #when amend changes a node and names a skill #then it is refused and the run keeps its definition", async () => {
    // given
    const { dag } = await harness(false)
    const definition = { key: "k", name: "k", nodes: [node("a", "first")] }
    const first = await dag.call({ action: "start", detach: true, definition })
    const runId = runIdOf(first.result)
    const settling = dag.begin({ action: "wait", run_id: runId, detach: false })
    first.fake.complete("a")
    await settling.pending
    const before = dag.record(runId).definitionFingerprint

    // when
    const { result } = await dag.call({ action: "amend", run_id: runId, definition: { ...definition, nodes: [node("a", "second", ["alpha"])] } })

    // then
    expect(result.details.kind === "error" && result.details.error.code).toBe("invalid_definition")
    expect(dag.record(runId).definitionFingerprint).toBe(before)
  })
})
