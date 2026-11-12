import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DagToolResult } from "@oh-my-opencode/senpi-task/dag-operations"
import { createNativeDagGenerationLease } from "./lease"
import { createWorkflowHarness } from "./test-support"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const PARENT = "ses_dag_root"
const roots: string[] = [], cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const node = (id: string, dependsOn?: readonly string[], prompt = `do ${id}`) => ({ id, prompt, category: "quick", ...(dependsOn && { dependsOn }) })

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "omo-v2-dag-controls-"))
  roots.push(directory)
  const lease = createNativeDagGenerationLease()
  cleanups.push(() => lease.dispose())
  const dag = createWorkflowHarness(directory, lease, PARENT)
  cleanups.push(() => dag.wake.close())
  return dag
}

function runIdOf(result: DagToolResult): string {
  if (result.details.kind !== "started") throw Error(`expected a start, got ${result.details.kind}`)
  return result.details.run_id
}

function errorOf(result: DagToolResult) {
  if (result.details.kind !== "error") throw Error(`expected a refusal, got ${result.details.kind}`)
  return result.details.error
}

describe("OpenCode 2 workflow controls", () => {
  test("#given a held run with admitted children #when cancel is called #then this call cancels every child and the run is cancelled", async () => {
    // given
    const dag = harness()
    const runId = runIdOf((await dag.call({ action: "start", detach: true, definition: { key: "c", name: "c", nodes: [node("a"), node("b"), node("c", ["a"])] } })).result)

    // when
    const { result, fake } = await dag.call({ action: "cancel", run_id: runId, reason: "stop" })
    await dag.wake.refresh()

    // then
    const record = dag.record(runId)
    expect(result.details.kind).toBe("cancelled")
    expect(fake.cancelled.toSorted()).toEqual(["task-1", "task-2"])
    expect(fake.starts).toEqual([])
    expect(record.status).toBe("cancelled")
    expect(record.nodes.map(entry => entry.state)).toEqual(["cancelled", "cancelled", "cancelled"])
    expect(dag.runtime.driving()).toBe(0)
    expect(dag.posts).toEqual([])
  })

  test("#given a run no user stopped #when cancel_node is called #then the Native paused-node cancel refuses and nothing is cancelled", async () => {
    // given
    const dag = harness()
    const runId = runIdOf((await dag.call({ action: "start", detach: true, definition: { key: "n", name: "n", nodes: [node("a")] } })).result)

    // when
    const { result, fake } = await dag.call({ action: "cancel_node", run_id: runId, node_id: "a" })

    // then
    expect(errorOf(result).code).toBe("run_not_user_paused")
    expect(fake.cancelled).toEqual([])
    expect(dag.record(runId).nodes[0]?.state).toBe("running")
  })

  test("#given a running node #when send is called #then the message reaches that node's child through this call", async () => {
    // given
    const dag = harness()
    const runId = runIdOf((await dag.call({ action: "start", detach: true, definition: { key: "s", name: "s", nodes: [node("a")] } })).result)

    // when
    const { result, fake } = await dag.call({ action: "send", run_id: runId, node_id: "a", message: "focus on tests" })

    // then
    expect(result.details.kind === "sent" && result.details.delivery).toBe("steer")
    // The fake send refuses all-scope authority like the Native operation, so this proves the scoped path.
    expect(fake.sent).toEqual([{ taskId: "task-1", message: "focus on tests" }])
    expect(fake.starts).toEqual([])
  })

  test("#given a settle already woken #when a send call journals its steer #then the call folds the settled child and the root is woken exactly once, and a later settle wakes once more (D-3)", async () => {
    // given
    const dag = harness()
    const first = await dag.call({ action: "start", detach: true, definition: { key: "d3", name: "d3", nodes: [node("s1"), node("s2"), node("s3")] } })
    const runId = runIdOf(first.result)
    first.fake.complete("s2")
    await dag.wake.refresh()
    const woken = [...dag.posts]

    // when
    const sent = await dag.call({ action: "send", run_id: runId, node_id: "s1", message: "steer" })
    await dag.wake.refresh(); await dag.wake.refresh()
    const afterSend = [...dag.posts]
    first.fake.complete("s3")
    await dag.wake.refresh(); await dag.wake.refresh()

    // then
    expect(woken).toHaveLength(1)
    expect(afterSend).toEqual(woken)
    expect(sent.result.details.kind === "sent" && sent.result.details.delivery).toBe("steer")
    expect(sent.fake.sent).toEqual([{ taskId: "task-1", message: "steer" }])
    expect(sent.fake.starts).toEqual([])
    expect(dag.record(runId).nodes.map(entry => entry.state)).toEqual(["running", "completed", "running"])
    expect(sent.result.content[0]?.text).toContain(`This call also recorded node(s) "s2" (completed), which finished before it.`)
    expect(dag.posts).toHaveLength(2)
    expect(dag.posts[1]).not.toBe(dag.posts[0])
    expect(dag.runtime.driving()).toBe(0)
  })

  test("#given a running node #when amend changes it #then Native amend safety refuses; after the run settles an amend re-runs only the changed node in this call", async () => {
    // given
    const dag = harness()
    const definition = { key: "m", name: "m", nodes: [node("a"), node("b", ["a"])] }
    const first = await dag.call({ action: "start", detach: true, definition })
    const runId = runIdOf(first.result)

    // when
    const unsafe = await dag.call({ action: "amend", run_id: runId, definition: { ...definition, nodes: [node("a", undefined, "changed"), node("b", ["a"])] } })
    const settling = dag.begin({ action: "wait", run_id: runId, detach: false })
    first.fake.complete("a")
    await settling.fake.whenStarted("b")
    settling.fake.complete("b")
    await settling.pending
    const amended = await dag.call({ action: "amend", run_id: runId, definition: { ...definition, nodes: [node("a"), node("b", ["a"], "changed")] } })

    // then
    expect(errorOf(unsafe.result).code).toBe("amend_running_node")
    expect(errorOf(unsafe.result).node_ids).toEqual(["a"])
    expect(amended.result.details.kind).toBe("amended")
    expect(amended.fake.starts.map(start => start.nodeId)).toEqual(["b"])
    expect(dag.record(runId).nodes.map(entry => entry.state)).toEqual(["completed", "running"])
  })

  test("#given a settled run #when amend changes a node's prompt #then the re-run child receives the amended prompt, not the old one", async () => {
    // given
    const dag = harness()
    const definition = { key: "p", name: "p", nodes: [node("a", undefined, "first prompt")] }
    const first = await dag.call({ action: "start", detach: true, definition })
    const runId = runIdOf(first.result)
    const settling = dag.begin({ action: "wait", run_id: runId, detach: false })
    first.fake.complete("a")
    await settling.pending

    // when
    const amended = await dag.call({ action: "amend", run_id: runId, definition: { ...definition, nodes: [node("a", undefined, "amended prompt")] } })

    // then
    expect(amended.result.details.kind).toBe("amended")
    expect(first.fake.starts.map(start => start.spec.prompt)).toEqual(["first prompt"])
    expect(amended.fake.starts.map(start => start.spec.prompt)).toEqual(["amended prompt"])
    expect(dag.record(runId).definition.nodes.map(entry => entry.effectivePrompt)).toEqual(["amended prompt"])
  })

  test("#given an amend whose node names skills #when called #then it is refused like start (S6g)", async () => {
    // given
    const dag = harness()
    const runId = runIdOf((await dag.call({ action: "start", detach: true, definition: { key: "k", name: "k", nodes: [node("a")] } })).result)

    // when
    const { result } = await dag.call({ action: "amend", run_id: runId, definition: { key: "k", name: "k", nodes: [{ ...node("a"), load_skills: ["git-master"] }] } })

    // then
    expect(errorOf(result).code).toBe("invalid_definition")
  })

  test("#given no live call path #when a control runs #then nothing acts: a returned call refuses and a run another call drives is refused", async () => {
    // given
    const dag = harness()
    const runId = runIdOf((await dag.call({ action: "start", detach: true, definition: { key: "l", name: "l", nodes: [node("a")] } })).result)

    // when
    const returned = dag.begin({ action: "cancel", run_id: runId }, { revoked: true })
    const outcome = await returned.pending.then(() => "acted", (error: unknown) => String(error))
    const driving = dag.begin({ action: "wait", run_id: runId, detach: false })
    await Promise.resolve()
    const concurrent = await dag.call({ action: "cancel", run_id: runId })
    driving.fake.complete("a")
    await driving.pending

    // then
    expect(outcome).toContain("Native operation callback is closed")
    expect(returned.fake.cancelled).toEqual([])
    expect(errorOf(concurrent.result).code).toBe("run_still_active")
    expect(concurrent.fake.cancelled).toEqual([])
    expect(dag.record(runId).status).toBe("completed")
  })
})
