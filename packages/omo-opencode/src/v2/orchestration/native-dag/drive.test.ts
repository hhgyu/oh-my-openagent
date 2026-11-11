import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DagDefinition, DagNodeId, DagRunId } from "@oh-my-opencode/senpi-task/dag"
import { createNativeDagGenerationLease } from "./lease"
import { createNativeDagRuntime } from "./runtime"
import { NativeDagRefusal } from "./refusals"
import { createHeldDagTaskPort, NativeDagAdmissionHeld, nativeDagCallPort } from "./task-port"
import { createFakeDagOperation } from "./test-support"

setDefaultTimeout(process.platform === "win32" ? 60_000 : 20_000)

const PARENT = "ses_dag_root"
const roots: string[] = []
const leases: { dispose(): void }[] = []
afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runtime() {
  const directory = mkdtempSync(join(tmpdir(), "omo-v2-dag-"))
  roots.push(directory)
  const lease = createNativeDagGenerationLease()
  leases.push(lease)
  return createNativeDagRuntime({ directory, parentSessionID: PARENT, executionMode: { agents: {}, config: {} }, lease })
}

const node = (id: string, dependsOn?: readonly string[]) => ({ id, prompt: `do ${id}`, category: "quick", ...(dependsOn && { dependsOn }) })

async function startRun(dag: ReturnType<typeof runtime>, nodes: DagDefinition["nodes"]): Promise<DagRunId> {
  const started = await dag.manager.start({ definition: { key: "s6c", name: "s6c", nodes }, parentSessionId: PARENT, rootSessionId: PARENT })
  return started.snapshot.runId
}

/** Lets every queued microtask and timer of the engine run, without asserting on wall-clock time. */
const settle = () => new Promise(resolve => setTimeout(resolve, 50))

describe("native DAG blocking drive", () => {
  test("#given a 3-node DAG with one dependency #when a call drives it #then the frontier admits a and b first and c only after a", async () => {
    // given
    const dag = runtime()
    const runId = await startRun(dag, [node("a"), node("b"), node("c", ["a"])])
    const fake = createFakeDagOperation(PARENT)

    // when
    const drive = dag.drive(runId, { port: nativeDagCallPort(fake.operation), signal: new AbortController().signal })
    await fake.whenStarted("a"); await fake.whenStarted("b")
    await settle()
    const firstWave = fake.starts.map(start => start.nodeId)
    fake.complete("a")
    await fake.whenStarted("c")
    fake.complete("b"); fake.complete("c")
    const result = await drive

    // then
    expect(firstWave).toEqual(["a", "b"])
    expect(fake.starts.map(start => start.nodeId)).toEqual(["a", "b", "c"])
    expect(fake.starts.every(start => start.spec.run_in_background === false && start.spec.depth === 1 && start.spec.parent_session_id === PARENT)).toBe(true)
    expect(result.status).toBe("completed")
    const attached = dag.store.readEvents(runId, 0, { limit: 500 }).events.flatMap(event => event.type === "dag.node.task-attached" ? [String(event.nodeId)] : [])
    expect(attached).toEqual(["a", "b", "c"])
    expect(dag.driving()).toBe(0)
  })

  test("#given a call that ends mid-run #when its admitted node finishes afterwards #then no node starts until the next blocking call admits it", async () => {
    // given
    const dag = runtime()
    const runId = await startRun(dag, [node("a"), node("b", ["a"])])
    const first = createFakeDagOperation(PARENT), call = new AbortController()
    const drive = dag.drive(runId, { port: nativeDagCallPort(first.operation), signal: call.signal })
    await first.whenStarted("a")

    // when
    call.abort(Error("call ended"))
    const ended = await drive.then(() => "settled", (error: unknown) => error instanceof Error ? error.message : String(error))
    first.revoke()
    first.complete("a")
    await settle()

    // then
    expect(ended).toBe("call ended")
    expect(first.starts.map(start => start.nodeId)).toEqual(["a"])
    expect(dag.manager.snapshot(runId, PARENT).nodes.find(entry => entry.id === "b")?.state).toBe("pending")

    // when the next blocking call drives the same run
    const second = createFakeDagOperation(PARENT)
    second.adopt(first)
    const next = dag.drive(runId, { port: nativeDagCallPort(second.operation), signal: new AbortController().signal })
    await second.whenStarted("b")
    second.complete("b")

    // then a is attached again (not restarted) and b is admitted by THIS call
    expect((await next).status).toBe("completed")
    expect(second.starts.map(start => start.nodeId)).toEqual(["b"])
  })
})

describe("native DAG spawn policy", () => {
  test("#given a call whose spawn policy denies an agent node #when driven #then the node fails without a start, as Native does", async () => {
    // given
    const dag = runtime()
    const runId = await startRun(dag, [{ id: "a", prompt: "do a", subagent_type: "plan-consultant" }])
    const fake = createFakeDagOperation(PARENT)

    // when
    const result = await dag.drive(runId, { port: nativeDagCallPort(fake.operation), signal: new AbortController().signal,
      spawnPolicy: () => ({ kind: "deny", message: "plan gate closed" }) })

    // then
    expect(fake.starts).toEqual([])
    expect(result.status).toBe("failed")
    expect(dag.manager.snapshot(runId, PARENT).nodes[0]?.error?.message).toContain("plan gate closed")
  })
})

describe("held DAG task port", () => {
  test("#given no bound call #when the engine starts a node #then the start is held, never reaches a call, and ends on drop", async () => {
    // given
    const held = createHeldDagTaskPort("dag_held" as DagRunId)
    const fake = createFakeDagOperation(PARENT)
    const owner = { kind: "dag" as const, runId: "dag_held" as DagRunId, nodeId: "a" as DagNodeId, fingerprint: "f" }

    // when
    const start = held.port.startOwned({ prompt: "p", parent_session_id: PARENT, depth: 1 }, owner)
    await settle()
    const waiting = held.held()
    held.dropHeld()
    const outcome = await start.then(() => "started", (error: unknown) => error)

    // then
    expect(waiting).toBe(1)
    expect(outcome).toBeInstanceOf(NativeDagAdmissionHeld)
    expect(fake.starts).toEqual([])
    expect(() => held.port.get("task-1")).toThrow(NativeDagAdmissionHeld)
    expect(() => held.port.sendToTask({ idOrName: "task-1", message: "m" })).toThrow(NativeDagAdmissionHeld)
  })

  test("#given a bound call #when it is released #then the port refuses to act for it", () => {
    // given
    const held = createHeldDagTaskPort("dag_held" as DagRunId)
    const fake = createFakeDagOperation(PARENT)
    const release = held.bind(nativeDagCallPort(fake.operation))

    // when
    const during = held.port.get("task-1")
    release()

    // then
    expect(during).toBeUndefined()
    expect(() => held.port.findOwnedTask({ kind: "dag", runId: "dag_x" as DagRunId, nodeId: "a" as DagNodeId })).toThrow(NativeDagAdmissionHeld)
  })

  test("#given the engine's all-scope send to this run's node child #when it reaches the port #then it goes through the call's scoped send", async () => {
    // given
    const runId = "dag_send" as DagRunId
    const held = createHeldDagTaskPort(runId)
    const fake = createFakeDagOperation(PARENT)
    const release = held.bind(nativeDagCallPort(fake.operation))
    const started = await held.port.startOwned({ prompt: "p", parent_session_id: PARENT, depth: 1 }, { kind: "dag", runId, nodeId: "a" as DagNodeId, fingerprint: "f" })
    const taskId = started.kind === "started" ? started.task_id : "none"

    // when
    const outcome = await held.port.sendToTask({ idOrName: taskId, message: "focus", callerSessionId: PARENT, allScope: true })
    release()

    // then
    expect(outcome).toEqual({ kind: "steered", task_id: taskId })
    expect(fake.sent).toEqual([{ taskId, message: "focus" }])
  })

  test("#given a task outside this run #when the port is asked to send to it #then it refuses to the model and nothing is sent", () => {
    // given
    const runId = "dag_send" as DagRunId
    const held = createHeldDagTaskPort(runId)
    const fake = createFakeDagOperation(PARENT)
    fake.seed("task-plain")
    fake.seed("task-other-run", { owner: { kind: "dag", runId: "dag_other" as DagRunId, nodeId: "a" as DagNodeId, fingerprint: "f" } })
    fake.seed("task-foreign-root", { parent: "ses_other_root", owner: { kind: "dag", runId, nodeId: "a" as DagNodeId, fingerprint: "f" } })
    const call = nativeDagCallPort(fake.operation)
    const release = held.bind(call)

    // when
    const attempts = ["task-plain", "task-other-run", "task-foreign-root", "task-missing"].map(idOrName => {
      try { return held.port.sendToTask({ idOrName, message: "m", allScope: true }) } catch (error) { return error }
    })
    const direct = (() => { try { return call.sendToTask({ idOrName: "task-foreign-root", message: "m" }) } catch (error) { return error } })()
    release()

    // then
    for (const attempt of attempts) expect(attempt).toBeInstanceOf(NativeDagRefusal)
    expect(direct).toBeInstanceOf(NativeDagRefusal)
    expect((attempts[1] as NativeDagRefusal).code).toBe("node_not_found")
    expect((attempts[1] as NativeDagRefusal).message).toBe("Task task-other-run is not a node child of workflow run dag_send, so workflow send does not reach it. Send targets only this run's own nodes.")
    expect(fake.sent).toEqual([])
  })
})
