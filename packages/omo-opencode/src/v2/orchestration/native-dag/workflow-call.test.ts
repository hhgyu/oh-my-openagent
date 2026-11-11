import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DagRunId } from "@oh-my-opencode/senpi-task/dag"
import type { DagToolInput, DagToolResult } from "@oh-my-opencode/senpi-task/dag-operations"
import type { ListedTool } from "../../host/tool-registry"
import { NATIVE_DAG_TOOL_NAME } from "../../tools/native-dag-codecs"
import { childCatalog } from "../native-task/component"
import { assertRootWorkflowCaller } from "./component"
import { createNativeDagGenerationLease } from "./lease"
import type { NativeDagExecutionSources } from "./refusals"
import { createNativeDagRuntime } from "./runtime"
import { nativeDagCallPort } from "./task-port"
import { createFakeDagOperation } from "./test-support"
import { runNativeWorkflow } from "./workflow-call"

const PARENT = "ses_dag_root"
const roots: string[] = []
const leases: { dispose(): void }[] = []
afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Only the field the execution-mode resolver reads; a process-mode agent definition.
const agents = { "process-worker": { executionMode: "process" } } as unknown as NativeDagExecutionSources["agents"]

function harness() {
  const directory = mkdtempSync(join(tmpdir(), "omo-v2-workflow-"))
  roots.push(directory)
  const lease = createNativeDagGenerationLease()
  leases.push(lease)
  const executionMode: NativeDagExecutionSources = { agents, config: {} }
  const runtime = createNativeDagRuntime({ directory, parentSessionID: PARENT, executionMode, lease })
  const drives: string[] = []
  const fake = createFakeDagOperation(PARENT)
  const call = { port: nativeDagCallPort(fake.operation), signal: new AbortController().signal }
  const spied = { manager: runtime.manager, drive: (runId: DagRunId, borrowed: typeof call) => { drives.push(runId); return runtime.drive(runId, borrowed) },
    admit: (runId: DagRunId, borrowed: typeof call) => { drives.push(runId); return runtime.admit(runId, borrowed) },
    control: runtime.control }
  const run = (params: DagToolInput) => runNativeWorkflow({ runtime: spied, parentSessionID: PARENT, call, executionMode }, params)
  return { runtime, drives, fake, run }
}

function errorOf(result: DagToolResult) {
  if (result.details.kind !== "error") throw Error(`expected a refusal, got ${result.details.kind}`)
  return { ...result.details.error, text: result.content[0]?.text ?? "" }
}

const definition = (nodes: NonNullable<DagToolInput["definition"]>["nodes"]) => ({ key: "s6c", name: "s6c", nodes })
const oneNodeRun = { key: "s6c", name: "s6c", nodes: [{ id: "a", prompt: "p", category: "quick" }] }

describe("OpenCode 2 workflow refusals", () => {
  test("#given a node that names skills #when started #then it is refused until S6g and no run is created", async () => {
    // given
    const { run, runtime } = harness()

    // when
    const refused = errorOf(await run({ action: "start", definition: definition([{ id: "a", prompt: "p", category: "quick", load_skills: ["git-master"] }]) }))

    // then
    expect(refused.code).toBe("invalid_definition")
    expect(refused.node_ids).toEqual(["a"])
    expect(refused.text).toBe(`Node(s) "a" name skills in load_skills. DAG skill loading is not available on OpenCode 2 yet (S6g); remove load_skills.`)
    expect(runtime.manager.list(PARENT)).toEqual([])
  })

  test("#given a node whose agent runs in process mode #when started #then it is refused (P-02)", async () => {
    // given
    const { run, runtime } = harness()

    // when
    const refused = errorOf(await run({ action: "start", definition: definition([{ id: "a", prompt: "p", category: "quick" }, { id: "b", prompt: "p", subagent_type: "process-worker" }]) }))

    // then
    expect(refused.node_ids).toEqual(["b"])
    expect(refused.text).toBe(`Node(s) "b" resolve to process execution mode. OpenCode 2 runs DAG nodes in-process only; pick an agent or category that runs in-process.`)
    expect(runtime.manager.list(PARENT)).toEqual([])
  })

  test("#given guide #when called #then the original tool's own refusal is returned", async () => {
    // given
    const { run, runtime } = harness()
    const started = await runtime.manager.start({ definition: oneNodeRun, parentSessionId: PARENT, rootSessionId: PARENT })

    // when
    const refused = errorOf(await run({ action: "guide", run_id: started.snapshot.runId, text: "focus" }))

    // then
    expect(refused.text).toBe("Guidance is not available in this session.")
  })

  test("#given an owned child session #when it calls workflow #then it is refused as a non-root caller", () => {
    // given
    const child = { resolveAncestry: () => ({ rootSessionId: PARENT, depth: 1 }) }
    const root = { resolveAncestry: () => ({ rootSessionId: PARENT, depth: 0 }) }

    // when
    const refuse = () => assertRootWorkflowCaller("ses_child", child)

    // then
    expect(refuse).toThrow("The workflow tool is available only to a root session")
    expect(() => assertRootWorkflowCaller(PARENT, root)).not.toThrow()
  })

  test("#given a host catalog listing workflow #when a child catalog is derived #then workflow is never a child grant", () => {
    // given
    const catalog = [NATIVE_DAG_TOOL_NAME, "read"].map(name => ({ id: name, name, description: name }) as unknown as ListedTool)

    // when
    const granted = childCatalog(catalog).map(tool => tool.name)

    // then
    expect(granted).toEqual(["read"])
  })
})

describe("OpenCode 2 blocking workflow", () => {
  test("#given a start #when its nodes complete #then the call returns only after the run settled", async () => {
    // given
    const { run, fake, drives } = harness()

    // when
    const pending = run({ action: "start", definition: definition([{ id: "a", prompt: "p", category: "quick" }]) })
    await fake.whenStarted("a")
    fake.complete("a")
    const result = await pending

    // then
    expect(result.details.kind).toBe("started")
    expect(result.details.kind === "started" && result.details.snapshot.status).toBe("completed")
    expect(result.content[0]?.text).toEndWith(" The run settled with status completed (1/1 nodes complete).")
    expect(drives).toHaveLength(1)
  })
})
