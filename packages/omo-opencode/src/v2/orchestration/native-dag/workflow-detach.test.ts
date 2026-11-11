import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DagRunId } from "@oh-my-opencode/senpi-task/dag"
import type { DagToolInput } from "@oh-my-opencode/senpi-task/dag-operations"
import { createNativeDagGenerationLease } from "./lease"
import { createNativeDagRuntime } from "./runtime"
import { nativeDagCallPort } from "./task-port"
import { createFakeDagOperation } from "./test-support"
import { createNativeDagWakeOwner } from "./wake"
import { dagWakeInputId } from "./wake-projection"
import { runNativeWorkflow } from "./workflow-call"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const PARENT = "ses_dag_root"
const roots: string[] = [], cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const settle = () => new Promise(resolve => setTimeout(resolve, 50))
const node = (id: string, dependsOn?: readonly string[]) => ({ id, prompt: `do ${id}`, category: "quick", ...(dependsOn && { dependsOn }) })

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "omo-v2-dag-detach-"))
  roots.push(directory)
  const lease = createNativeDagGenerationLease()
  cleanups.push(() => lease.dispose())
  const posts: string[] = [], fakes: ReturnType<typeof createFakeDagOperation>[] = []
  const runtime = createNativeDagRuntime({ directory, parentSessionID: PARENT, executionMode: { agents: {}, config: {} }, lease,
    onDriveEnded: runId => wake.arm(PARENT, runId) })
  const wake = createNativeDagWakeOwner({ directory, pollIntervalMs: 0, assertGeneration() {},
    session: {
      async get(input) { return { id: input.sessionID, location: { directory } } },
      async synthetic(input) { posts.push(input.id); return { id: input.id, sessionID: input.sessionID, type: "synthetic", payload: { text: input.text } } },
    },
    journalPathFor: () => join(directory, "dag-wakes.sqlite"), runtimeFor: () => runtime,
    childStatus: (_root, taskId) => fakes.flatMap(fake => fake.tasksFrom().get(taskId)?.record.status ?? [])[0] })
  cleanups.push(() => wake.close())
  /** One `workflow` call over a fresh per-call operation that shares the earlier calls' children. */
  async function call(params: DagToolInput) {
    const fake = createFakeDagOperation(PARENT)
    for (const earlier of fakes) fake.adopt(earlier)
    fakes.push(fake)
    const result = await runNativeWorkflow({ runtime, parentSessionID: PARENT, executionMode: { agents: {}, config: {} },
      call: { port: nativeDagCallPort(fake.operation), signal: new AbortController().signal } }, params)
    fake.revoke()
    return { result, fake }
  }
  return { runtime, wake, posts, call }
}

describe("OpenCode 2 detached workflow", () => {
  test("#given a detached start #when it returns #then it admitted the frontier inside the call and nothing starts afterwards", async () => {
    // given
    const dag = harness()

    // when
    const { result, fake } = await dag.call({ action: "start", detach: true, definition: { key: "s6d", name: "s6d", nodes: [node("a"), node("b"), node("c", ["a"])] } })
    const runId = result.details.kind === "started" ? result.details.run_id : ""
    fake.complete("a")
    await settle()

    // then
    expect(result.details.kind).toBe("started")
    expect(result.content[0]?.text).toStartWith(`Started dag run ${runId} (3 nodes).`)
    expect(result.content[0]?.text).toEndWith(` The run is running (0/3 nodes complete). On OpenCode 2 nodes start only inside a workflow call: this call admitted every node that could start now, and nothing more starts until your next workflow call. When an admitted node finishes, this session is woken once; then call workflow with action=wait and run_id=${runId} (detach=true admits the next ready nodes and returns, detach=false blocks until the run settles).`)
    expect(fake.starts.map(start => start.nodeId)).toEqual(["a", "b"])
    expect(dag.runtime.manager.snapshot(runId as DagRunId, PARENT).nodes.find(entry => entry.id === "c")?.state).toBe("pending")
    expect(dag.runtime.driving()).toBe(0)
  })

  test("#given a wake after a settle #when the model's next detached wait runs #then that call admits the next wave and only a later settle wakes again", async () => {
    // given
    const dag = harness()
    const first = await dag.call({ action: "start", detach: true, definition: { key: "s6d", name: "s6d", nodes: [node("a"), node("b"), node("c", ["a"])] } })
    const runId = first.result.details.kind === "started" ? first.result.details.run_id : ""
    first.fake.complete("a")
    await dag.wake.refresh()
    const wokenOnce = [...dag.posts]

    // when
    const second = await dag.call({ action: "wait", run_id: runId })
    await dag.wake.refresh()
    const afterCall = [...dag.posts]
    second.fake.complete("b"); second.fake.complete("c")
    await dag.wake.refresh()

    // then
    expect(wokenOnce).toHaveLength(1)
    expect(second.result.details.kind).toBe("detached")
    expect(second.result.content[0]?.text).toStartWith(`Detached from dag run ${runId}. The run is running (1/3 nodes complete).`)
    expect(second.fake.starts.map(start => start.nodeId)).toEqual(["c"])
    expect(afterCall).toEqual(wokenOnce)
    expect(dag.posts).toEqual([...wokenOnce, dagWakeInputId(runId, "terminal")])
  })

  test("#given a run whose last nodes settled #when the model waits detached #then the call records the end and returns the final result", async () => {
    // given
    const dag = harness()
    const first = await dag.call({ action: "start", detach: true, definition: { key: "s6d", name: "s6d", nodes: [node("a")] } })
    const runId = first.result.details.kind === "started" ? first.result.details.run_id : ""
    first.fake.complete("a")

    // when
    const { result } = await dag.call({ action: "wait", run_id: runId })

    // then
    expect(result.details.kind).toBe("waited")
    expect(result.details.kind === "waited" && result.details.result.status).toBe("completed")
  })
})
