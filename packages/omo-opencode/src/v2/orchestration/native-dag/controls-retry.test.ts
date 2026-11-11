import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DagToolResult } from "@oh-my-opencode/senpi-task/dag-operations"
import { createNativeDagGenerationLease } from "./lease"
import { createWorkflowHarness } from "./test-support"
import { dagWakeInputId } from "./wake-projection"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const PARENT = "ses_dag_root"
const roots: string[] = [], cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const node = (id: string, dependsOn?: readonly string[]) => ({ id, prompt: `do ${id}`, category: "quick", ...(dependsOn && { dependsOn }) })

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "omo-v2-dag-retry-"))
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

describe("OpenCode 2 workflow retry and the run wake", () => {
  test("#given a failed run #when retry blocks (detach=false) #then this call re-admits the failed node and its skipped dependent and the run completes", async () => {
    // given
    const dag = harness()
    const first = await dag.call({ action: "start", detach: true, definition: { key: "r", name: "r", nodes: [node("a"), node("b", ["a"])] } })
    const runId = runIdOf(first.result)
    first.fake.settle("a", "error")
    await dag.call({ action: "wait", run_id: runId, detach: false })
    const failed = dag.record(runId)

    // when
    const retry = dag.begin({ action: "retry", run_id: runId, detach: false })
    await retry.fake.whenStarted("a")
    retry.fake.complete("a")
    await retry.fake.whenStarted("b")
    retry.fake.complete("b")
    const result = await retry.pending

    // then
    expect(failed.status).toBe("failed")
    expect(failed.nodes.map(entry => entry.state)).toEqual(["failed", "skipped"])
    expect(result.details.kind).toBe("retried")
    expect(result.details.kind === "retried" && result.details.snapshot.status).toBe("completed")
    expect(retry.fake.starts.map(start => start.nodeId)).toEqual(["a", "b"])
    expect(dag.runtime.driving()).toBe(0)
  })

  test("#given a run that finished outside a call #when it is retried detached and finishes again #then the second terminal wake has its own id", async () => {
    // given
    const dag = harness()
    const first = await dag.call({ action: "start", detach: true, definition: { key: "w", name: "w", nodes: [node("a")] } })
    const runId = runIdOf(first.result)
    first.fake.settle("a", "error")
    await dag.wake.refresh()
    await dag.call({ action: "wait", run_id: runId })

    // when
    const retry = await dag.call({ action: "retry", run_id: runId })
    retry.fake.complete("a")
    await dag.wake.refresh()

    // then
    expect(retry.result.details.kind === "retried" && retry.result.details.snapshot.status).toBe("running")
    expect(retry.fake.starts.map(start => start.nodeId)).toEqual(["a"])
    expect(dag.record(runId).generation).toBe(2)
    expect(dag.posts).toEqual([dagWakeInputId(runId, { terminalGeneration: 1 }), dagWakeInputId(runId, { terminalGeneration: 2 })])
    expect(new Set(dag.posts).size).toBe(2)
  })

  test("#given a wake intent whose delivery failed #when a control folds its settle and a later node settles #then the stale wake is never delivered and only the current one is", async () => {
    // given
    const dag = harness()
    const first = await dag.call({ action: "start", detach: true, definition: { key: "t", name: "t", nodes: [node("a"), node("b"), node("c")] } })
    const runId = runIdOf(first.result)
    first.fake.complete("a")
    dag.state.failSynthetic = true
    await dag.wake.refresh()
    const staleSeq = dag.record(runId).checkpointSeq
    const stale = dagWakeInputId(runId, { settled: [{ nodeId: "a", taskId: "task-1", runEpoch: 1, status: "completed" }] })

    // when
    const sent = await dag.call({ action: "send", run_id: runId, node_id: "b", message: "hurry" })
    dag.state.failSynthetic = false
    await dag.wake.refresh()
    const afterSend = [...dag.posts]
    first.fake.complete("c")
    await dag.wake.refresh()

    // then
    expect(sent.result.details.kind === "sent" && sent.result.details.delivery).toBe("steer")
    expect(sent.fake.sent).toEqual([{ taskId: "task-2", message: "hurry" }])
    expect(sent.result.content[0]?.text).toContain(`This call also recorded node(s) "a" (completed), which finished before it.`)
    expect(dag.record(runId).checkpointSeq).toBeGreaterThan(staleSeq)
    expect(afterSend).toEqual([])
    expect(dag.posts).toEqual([dagWakeInputId(runId, { settled: [{ nodeId: "c", taskId: "task-3", runEpoch: 1, status: "completed" }] })])
    expect(dag.posts).not.toContain(stale)
  })
})
