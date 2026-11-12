import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dagStatusRpc, type DagStatus } from "../../rpc/dag"
import { createNativeDagGenerationLease } from "./lease"
import { createNativeDagRuntime } from "./runtime"
import { createDagStatusRpc, type DagStatusRpcPort } from "./status-rpc"

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "omo-dag-status-"))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const lease = createNativeDagGenerationLease()
  cleanup.push(() => lease.dispose())
  const runtimes = new Map<string, ReturnType<typeof createNativeDagRuntime>>()
  const status = createDagStatusRpc({ snapshots: sessionID => {
    const runtime = runtimes.get(sessionID)
    return runtime?.manager.list(sessionID).map(run => runtime.manager.snapshot(run.runId, sessionID)) ?? []
  } })
  cleanup.push(() => status.close())
  const emitted: DagStatus[] = []
  let fail = false
  let handler: ((input: { sessionID: string }) => Promise<DagStatus>) | undefined
  const rpc: DagStatusRpcPort = { async register(definition, handlers) {
    expect(definition).toBe(dagStatusRpc)
    handler = input => handlers.status(input, { signal: new AbortController().signal, error: () => { throw Error("undeclared error") } })
    return { async dispose() {}, events: { async emit(_name, data) {
      if (fail) throw Error("transport unavailable")
      emitted.push(data)
    } } }
  } }
  function runtime(sessionID: string) {
    const created = createNativeDagRuntime({ directory, parentSessionID: sessionID, lease, executionMode: { agents: {}, config: {} },
      onChanged: () => status.refreshSession(sessionID) })
    runtimes.set(sessionID, created)
    return created
  }
  return { status, rpc, runtime, emitted, fail: (value: boolean) => { fail = value },
    read: (sessionID: string) => { if (!handler) throw Error("not registered"); return handler({ sessionID }) } }
}

describe("session-scoped DAG RPC", () => {
  test("#given two sessions #when runs commit #then status and events expose only each session's durable node states without prompts", async () => {
    const h = harness()
    await h.status.register(h.rpc)
    const a = h.runtime("a"), b = h.runtime("b")
    // when
    const started = await a.manager.start({ parentSessionId: "a", rootSessionId: "a", definition: {
      key: "build", name: "Build", nodes: [{ id: "compile", prompt: "private prompt", category: "quick" }],
    } })
    await b.manager.start({ parentSessionId: "b", rootSessionId: "b", definition: {
      key: "other", name: "Other", nodes: [{ id: "secret", prompt: "other secret", category: "quick" }],
    } })
    await h.status.settled()
    const view = await h.read("a")
    // then
    expect(view.runs).toHaveLength(1)
    expect(view.runs[0]).toMatchObject({ runId: started.snapshot.runId, name: "Build", counts: { total: 1, pending: 1 }, nodes: [{ id: "compile", state: "pending" }] })
    expect(JSON.stringify(view)).not.toContain("private prompt")
    expect((await h.read("missing")).runs).toEqual([])
    expect(h.emitted.filter(event => event.sessionID === "a").at(-1)).toEqual(view)
    expect(h.emitted.filter(event => event.sessionID === "b").at(-1)?.runs[0]?.name).toBe("Other")
  })

  test("#given an unchanged view and a failed emission #when refreshed and disposed #then duplicates are skipped, failures retry and no late event escapes", async () => {
    const h = harness()
    await h.status.register(h.rpc)
    h.runtime("a")
    h.fail(true)
    h.status.refreshSession("a")
    await h.status.settled()
    h.fail(false)
    h.status.refreshSession("a")
    await h.status.settled()
    h.status.refreshSession("a")
    await h.status.settled()
    expect(h.emitted).toEqual([{ sessionID: "a", runs: [] }])
    h.status.refreshSession("b")
    h.status.close()
    await h.status.settled()
    expect(h.emitted).toHaveLength(1)
  })
})
