import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { TaskRecord } from "../state"
import { compileDag, type DagDefinition } from "./graph"
import type { DagRunRecordV1 } from "./manager"
import { processDagLease, resolveDagLease, type DagTaskPort } from "./ports"
import { createDagScheduler } from "./scheduler"
import { createDagFileStore } from "./store"
import type { DagRunId } from "./types"

const cleanupRoots: string[] = []
const runId = "run-ports" as DagRunId
const parentSessionId = "ses-ports"
const createdAt = "2026-11-11T00:00:00.000Z"

afterEach(() => {
  for (const root of cleanupRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempProject(): string {
  const directory = fs.mkdtempSync(join(tmpdir(), "senpi-dag-ports-"))
  cleanupRoots.push(directory)
  return directory
}

function recordFor(input: DagDefinition): DagRunRecordV1 {
  const compiled = compileDag(input, { at: createdAt })
  if (!compiled.ok) throw new Error("test DAG did not compile")
  return {
    schemaVersion: 1, checkpointSeq: 0, runId, runKey: input.key, name: input.name,
    parentSessionId, rootSessionId: parentSessionId, definitionFingerprint: "definition-fingerprint",
    definition: { key: input.key, name: input.name, nodes: input.nodes.map((entry) => ({ ...entry, effectivePrompt: entry.prompt })) },
    status: "pending", generation: 1, createdAt, updatedAt: createdAt,
    nodes: compiled.nodes, edges: compiled.edges, waves: compiled.waves,
    criticalPath: compiled.criticalPath, bottlenecks: compiled.bottlenecks, diagnostics: compiled.diagnostics,
  }
}

// A host that knows nothing about Senpi's TaskManager: exactly the nine DagTaskPort methods, and
// every child completes as soon as it is admitted.
function minimalPort(): { readonly port: DagTaskPort; readonly admitted: string[] } {
  const tasks = new Map<string, TaskRecord>()
  const admitted: string[] = []
  const unsupported = (): Promise<never> => Promise.reject(new Error("not used by this run"))
  const port: DagTaskPort = {
    async startOwned(spec, owner) {
      const taskId = `task-${owner.nodeId}`
      admitted.push(String(owner.nodeId))
      tasks.set(taskId, {
        task_id: taskId, name: String(owner.nodeId), parent_session_id: spec.parent_session_id,
        root_session_id: parentSessionId, depth: 1, category: "quick", execution_mode: "in-process",
        model: "fake-model", notify_on_terminal: true, owner, status: "completed", residency_state: "resident",
        created_at: createdAt, updated_at: createdAt, final_response: `done ${owner.nodeId}`,
        notification: { run_epoch: 1, notified_epoch: 0 },
      })
      return { kind: "started", reused: false, task_id: taskId, status: "running", name: String(owner.nodeId) }
    },
    findOwnedTask: (owner) => [...tasks.values()].find((task) => task.owner?.nodeId === owner.nodeId),
    get: (taskId) => tasks.get(taskId),
    getResidentHandle: () => undefined,
    subscribeChild: () => () => undefined,
    async waitFor(taskId) {
      const task = tasks.get(taskId)
      if (task === undefined) throw new Error(`unknown task ${taskId}`)
      return task
    },
    cancelTask: unsupported,
    sendToTask: unsupported,
    residencyChanged: () => new Promise<void>(() => undefined),
  }
  return { port, admitted }
}

describe("DagTaskPort", () => {
  test("#given a host implementing only DagTaskPort #when a two-node chain runs #then the scheduler admits both nodes in dependency order and completes", async () => {
    // given
    const store = createDagFileStore({ project_dir: tempProject() })
    const initialRecord = recordFor({
      key: "ports", name: "ports",
      nodes: [{ id: "A", prompt: "do A", category: "quick" }, { id: "B", prompt: "do B", category: "quick", dependsOn: ["A"] }],
    })
    store.writeCheckpoint(runId, initialRecord)
    const { port, admitted } = minimalPort()

    // when
    const result = await createDagScheduler({ store, taskManager: port, initialRecord }).run()

    // then
    expect(admitted).toEqual(["A", "B"])
    expect(result.status).toBe("completed")
    expect(result.nodes.map((entry) => `${entry.id}:${entry.state}`)).toEqual(["A:completed", "B:completed"])
  })
})

describe("DagLeasePort defaults", () => {
  test("#given no explicit lease #when resolved from legacy pid knobs #then the holder is the given pid and liveness is the given probe", () => {
    // given
    const probed: number[] = []

    // when
    const lease = resolveDagLease({ hostPid: 4242, isProcessAlive: (pid) => { probed.push(pid); return pid === 7 } })

    // then
    expect(lease.holder()).toBe(4242)
    expect([lease.isAlive(7), lease.isAlive(8)]).toEqual([true, false])
    expect(probed).toEqual([7, 8])
  })

  test("#given an explicit lease and legacy knobs #when resolved #then the explicit lease wins", () => {
    // given
    const explicit = { holder: () => 9, isAlive: () => false }

    // when
    const lease = resolveDagLease({ lease: explicit, hostPid: 4242, isProcessAlive: () => true })

    // then
    expect(lease).toBe(explicit)
  })

  test("#given nothing injected #when the default lease is built #then it names this process and sees it alive", () => {
    // given / when
    const lease = processDagLease()

    // then
    expect(lease.holder()).toBe(process.pid)
    expect(lease.isAlive(process.pid)).toBe(true)
  })
})
