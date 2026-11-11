import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyDagSchedulerEvent, createDagJournal, dagNodeSteeredEvent, type DagDefinition, type DagNodeId, type DagRunId } from "@oh-my-opencode/senpi-task/dag"
import { createNativeDagGenerationLease } from "./lease"
import { createNativeDagRuntime } from "./runtime"
import { nativeDagCallPort } from "./task-port"
import { openDagDeliveryJournal } from "../../host/dag-delivery-journal"
import { createFakeDagOperation } from "./test-support"
import { createNativeDagWakeOwner, type DagWakeOwner } from "./wake"
import { dagWakeInputId } from "./wake-projection"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const PARENT = "ses_dag_root"
const roots: string[] = [], cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Post = { readonly sessionID: string; readonly id: string; readonly text: string; readonly resume: boolean; readonly metadata: { readonly [key: string]: string } }
const node = (id: string, dependsOn?: readonly string[]) => ({ id, prompt: `do ${id}`, category: "quick", ...(dependsOn && { dependsOn }) })

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "omo-v2-dag-wake-"))
  roots.push(directory)
  const lease = createNativeDagGenerationLease()
  cleanups.push(() => lease.dispose())
  const state = { generationLive: true, failSynthetic: false }
  const journalPath = join(directory, "dag-wakes.sqlite")
  const namespace = "opencode2-dag:" + createHash("sha256").update(JSON.stringify([directory, PARENT])).digest("hex")
  const posts: Post[] = [], fakes: ReturnType<typeof createFakeDagOperation>[] = []
  let current: DagWakeOwner | undefined
  const runtime = createNativeDagRuntime({ directory, parentSessionID: PARENT, executionMode: { agents: {}, config: {} }, lease,
    onDriveEnded: runId => current?.arm(PARENT, runId) })
  const session = {
    async get(input: { sessionID: string }) { return { id: input.sessionID, location: { directory } } },
    async synthetic(input: Post & { delivery: "steer" }) {
      if (state.failSynthetic) throw Error("transport down")
      posts.push(input)
      return { id: input.id, sessionID: input.sessionID, type: "synthetic", payload: { text: input.text } }
    },
  }
  function owner(): DagWakeOwner {
    const created = createNativeDagWakeOwner({ session, directory, pollIntervalMs: 0,
      assertGeneration() { if (!state.generationLive) throw Error("Retired Native task generation") },
      journalPathFor: () => journalPath,
      runtimeFor: () => runtime,
      childState: (_root, taskId) => fakes.flatMap(fake => fake.tasksFrom().get(taskId)?.record ?? []).map(child => ({ status: child.status, runEpoch: child.notification.run_epoch }))[0] })
    cleanups.push(() => created.close())
    current = created
    return created
  }
  /** One detached call: admits the frontier inside the call, then the call's operation is revoked. */
  async function detachedCall(runId: DagRunId) {
    const fake = createFakeDagOperation(PARENT)
    for (const earlier of fakes) fake.adopt(earlier)
    fakes.push(fake)
    await runtime.admit(runId, { port: nativeDagCallPort(fake.operation), signal: new AbortController().signal })
    fake.revoke()
    return fake
  }
  async function start(nodes: DagDefinition["nodes"]) {
    const started = await runtime.manager.start({ definition: { key: "s6d", name: "s6d", nodes }, parentSessionId: PARENT, rootSessionId: PARENT })
    return started.snapshot.runId
  }
  /** Journals a steer of `nodeId`'s child outside any call: the checkpoint advances and nothing is folded. */
  function steer(runId: DagRunId, nodeId: string): void {
    const record = runtime.manager.record(runId, PARENT)
    const taskId = record.nodes.find(entry => entry.id === nodeId)?.taskId
    if (taskId === undefined) throw Error(`node ${nodeId} has no child`)
    createDagJournal({ store: runtime.store, runId, initialCheckpoint: record, applyEvent: (checkpoint, event) => applyDagSchedulerEvent(checkpoint, event) })
      .append(dagNodeSteeredEvent({ nodeId: nodeId as DagNodeId, taskId, delivery: "steer" }))
  }
  return { runtime, posts, state, owner, start, detachedCall, steer, journalPath, namespace, seq: (runId: DagRunId) => runtime.manager.record(runId, PARENT).checkpointSeq }
}

describe("native DAG run wake", () => {
  test("#given a detached run #when a node settles outside a call #then exactly one wake is posted with the deterministic id", async () => {
    // given
    const dag = harness(), wake = dag.owner()
    const runId = await dag.start([node("a"), node("b"), node("c", ["a"])])
    const fake = await dag.detachedCall(runId)

    // when
    fake.complete("a")
    await wake.refresh(); await wake.refresh()

    // then
    const seq = dag.seq(runId)
    expect(dag.posts).toHaveLength(1)
    expect(dag.posts[0]?.id).toBe("msg_omo_dag_" + createHash("sha256").update(`dag:${runId}:frontier:[["a","task-1",1,"completed"]]`).digest("hex").slice(0, 40))
    expect(dag.posts[0]?.id).toBe(dagWakeInputId(runId, { settled: [{ nodeId: "a", taskId: "task-1", runEpoch: 1, status: "completed" }] }))
    expect(dag.posts[0]?.sessionID).toBe(PARENT)
    expect(dag.posts[0]?.resume).toBe(true)
    expect(dag.posts[0]?.metadata).toEqual({ omoDagRunId: runId, omoDagSeq: String(seq), omoDagWake: "frontier" })
    expect(dag.posts[0]?.text).toStartWith(`Workflow "s6d" (run ${runId}): node(s) "a" (completed) finished while no workflow call was in progress. Ready to start: "c". Still running: "b". On OpenCode 2 a background workflow run advances only on your next workflow call: call workflow with action=wait and run_id=${runId} (detach=true admits the ready nodes and returns at once; detach=false blocks until the run settles).`)
    expect(fake.starts.map(start => start.nodeId)).toEqual(["a", "b"])
  })

  test("#given a wake already posted #when more nodes settle before the model acts #then they coalesce into that one wake", async () => {
    // given
    const dag = harness(), wake = dag.owner()
    const runId = await dag.start([node("a"), node("b"), node("c", ["a", "b"])])
    const fake = await dag.detachedCall(runId)
    fake.complete("a")
    await wake.refresh()

    // when
    fake.complete("b")
    await wake.refresh()

    // then
    expect(dag.posts).toHaveLength(1)
  })

  test("#given every admitted node finished #when the wake runs #then one terminal wake with the run's terminal id is posted", async () => {
    // given
    const dag = harness(), wake = dag.owner()
    const runId = await dag.start([node("a")])
    const fake = await dag.detachedCall(runId)

    // when
    fake.complete("a")
    await wake.refresh()

    // then
    expect(dag.posts.map(post => post.id)).toEqual([dagWakeInputId(runId, { terminalGeneration: 1 })])
    expect(dag.posts[0]?.metadata.omoDagWake).toBe("finished")
    expect(dag.posts[0]?.text).toContain("No node is running and none can start: the run is completed (1 completed, 0 failed, cancelled or skipped, 0 never started; 1 total).")
  })

  test("#given a run the root does not own or a retired generation #when a node settles #then nothing is posted", async () => {
    // given
    const dag = harness(), wake = dag.owner()
    const runId = await dag.start([node("a"), node("b", ["a"])])
    const fake = await dag.detachedCall(runId)
    fake.complete("a")

    // when
    dag.state.generationLive = false
    await wake.refresh()
    dag.state.generationLive = true
    wake.arm("ses_other_root", runId)
    await wake.refresh()

    // then the generation fence posted nothing, and the foreign arm is dropped
    expect(dag.posts).toEqual([])
  })

  test("#given an ACKed wake #when a new owner of the same journal runs #then it is not redelivered, while an un-ACKed one is reposted with the same id", async () => {
    // given
    const dag = harness(), first = dag.owner()
    const runId = await dag.start([node("a"), node("b"), node("c", ["a"])])
    const fake = await dag.detachedCall(runId)
    fake.complete("a")
    dag.state.failSynthetic = true
    await first.refresh()
    dag.state.failSynthetic = false

    // when the intent was recorded but transport failed, the next pass reposts the SAME id
    await first.refresh()
    await first.close()
    const second = dag.owner()
    second.arm(PARENT, runId)
    await second.refresh()

    // then
    expect(dag.posts.map(post => post.id)).toEqual([dagWakeInputId(runId, { settled: [{ nodeId: "a", taskId: "task-1", runEpoch: 1, status: "completed" }] })])
  })

  test("#given an ACKed wake #when a steer advances the checkpoint without folding the settle #then the same settle is not announced again, and a new settle still wakes once (D-3)", async () => {
    // given
    const dag = harness(), wake = dag.owner()
    const runId = await dag.start([node("s1"), node("s2"), node("s3")])
    const fake = await dag.detachedCall(runId)
    fake.complete("s2")
    await wake.refresh()
    const announcedAt = dag.seq(runId)

    // when
    dag.steer(runId, "s1")
    await wake.refresh(); await wake.refresh()
    const afterSteer = dag.posts.map(post => post.id)
    fake.complete("s3")
    dag.steer(runId, "s1")
    await wake.refresh(); await wake.refresh()

    // then
    expect(dag.seq(runId)).toBe(announcedAt + 2)
    expect(afterSteer).toHaveLength(1)
    expect(dag.posts).toHaveLength(2)
    expect(dag.posts[1]?.text).toContain(`node(s) "s2" (completed), "s3" (completed) finished`)
    expect(new Set(dag.posts.map(post => post.id)).size).toBe(2)
  })

  test("#given the same node's settle #when its child is a new task or a revived run epoch #then the frontier id differs, and node order does not change it", () => {
    // given
    const a = { nodeId: "a", taskId: "task-1", runEpoch: 1, status: "completed" }, b = { nodeId: "b", taskId: "task-2", runEpoch: 1, status: "error" }

    // when
    const base = dagWakeInputId("dag_r", { settled: [a, b] })

    // then
    expect(dagWakeInputId("dag_r", { settled: [b, a] })).toBe(base)
    expect(dagWakeInputId("dag_r", { settled: [{ ...a, taskId: "task-3" }, b] })).not.toBe(base)
    expect(dagWakeInputId("dag_r", { settled: [{ ...a, runEpoch: 2 }, b] })).not.toBe(base)
    expect(dagWakeInputId("dag_other", { settled: [a, b] })).not.toBe(base)
    expect(dagWakeInputId("dag_r", { terminalGeneration: 1 })).not.toBe(dagWakeInputId("dag_r", { terminalGeneration: 2 }))
  })

  test("#given an ACKed wake #when its run is gone and the owner is closed #then its rows are retired and nothing more is posted", async () => {
    // given
    const dag = harness(), wake = dag.owner()
    const runId = await dag.start([node("a"), node("b", ["a"])])
    const fake = await dag.detachedCall(runId)
    fake.complete("a")
    await wake.refresh()

    // when
    rmSync(dag.runtime.store.paths.run(runId), { force: true }); rmSync(dag.runtime.store.paths.event(runId), { force: true })
    await wake.refresh()
    await wake.close()
    wake.arm(PARENT, runId)
    await wake.refresh()

    // then
    const journal = openDagDeliveryJournal({ path: dag.journalPath, namespace: dag.namespace })
    const runs = journal.listRuns()
    journal.close()
    expect(dag.posts).toHaveLength(1)
    expect(runs).toEqual([])
  })
})
