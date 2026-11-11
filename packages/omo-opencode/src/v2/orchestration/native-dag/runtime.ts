import {
  createDagFileStore, createDagManager, createDagWaitSurface,
  type DagFileStore, type DagLeasePort, type DagManager, type DagMaterializeSkills, type DagNodeSpawnPolicy, type DagRunId, type DagRunRecordV1, type DagRunResult, type DagSettings,
} from "@oh-my-opencode/senpi-task/dag"
import { nativeTaskStateDir } from "../native-task/component"
import { driveDagRun, type NativeDagEntry } from "./drive"
import { NativeDagRefusal, type NativeDagExecutionSources } from "./refusals"
import type { NativeDagCallPort } from "./task-port"

export interface NativeDagRuntimeOptions {
  readonly directory: string
  /** The root session whose Native task state directory holds this runtime's DAG store. */
  readonly parentSessionID: string
  readonly settings?: Partial<DagSettings>
  readonly executionMode: NativeDagExecutionSources
  readonly lease: DagLeasePort
  /** A call stopped driving `runId` (it returned, detached or was interrupted): arms its wake. */
  readonly onDriveEnded?: (runId: DagRunId) => void
}

/** One call's authority over the runtime: its operation port, its abort signal and its spawn policy. */
export interface NativeDagCall {
  readonly port: NativeDagCallPort
  readonly signal: AbortSignal
  readonly spawnPolicy?: DagNodeSpawnPolicy
}

export interface NativeDagRuntime {
  readonly store: DagFileStore
  readonly manager: DagManager
  /** Drives `runId` inside `call` until it settles or the call aborts, then returns its result. */
  drive(runId: DagRunId, call: NativeDagCall): Promise<DagRunResult>
  /** Detached: admits every node that can start now inside `call`, then returns without blocking. */
  admit(runId: DagRunId, call: NativeDagCall): Promise<void>
  /** Runs a control verb's `entry` inside `call`, then drives the re-entry it returns: until the run
   * settles, or detached until the admission is quiet. The run counts as driven meanwhile. */
  control(runId: DagRunId, call: NativeDagCall, entry: NativeDagEntry, detach: boolean): Promise<DagRunRecordV1>
  /** Number of runs a call is driving right now. */
  driving(): number
  isDriving(runId: string): boolean
}

/** Native's skill materialization for a node that loads no skills: the effective prompt IS the
 * submitted prompt (Native `buildSkillPrepend` with nothing to prepend). OpenCode 2 refuses every
 * definition that names skills (S6g) before the manager sees it, so this is the whole materializer
 * here. Without it an `amend` keeps each changed node's PREVIOUS effective prompt and the re-run
 * dispatches the stale prompt. */
const nativeDagNoSkillMaterializer: DagMaterializeSkills = ({ definition }) => ({
  nodes: definition.nodes.map(node => ({ nodeId: node.id, effectivePrompt: node.prompt })),
})

/** The DAG store, manager and per-run blocking drives of ONE root session, stored under that
 * session's Native task state directory. It holds no call: every drive borrows the call it runs in. */
export function createNativeDagRuntime(options: NativeDagRuntimeOptions): NativeDagRuntime {
  const store = createDagFileStore({
    project_dir: options.directory,
    task: { state_dir: nativeTaskStateDir(options.directory, options.parentSessionID), ...(options.settings && { dag: options.settings }) },
  })
  const manager = createDagManager({ store, materializeSkills: nativeDagNoSkillMaterializer, ...(options.settings && { settings: options.settings }) })
  // Results are projected from the store; a drive returns only after its run is terminal.
  const results = createDagWaitSurface({ store, subscribe: () => () => {} })
  const driving = new Set<string>()
  async function run(runId: DagRunId, call: NativeDagCall, detach: boolean, enter?: NativeDagEntry): Promise<DagRunRecordV1> {
    if (driving.has(runId)) throw new NativeDagRefusal("run_still_active", `Dag run ${runId} is already being driven by another workflow call in this session.`)
    driving.add(runId)
    try {
      return await driveDagRun({ store, manager, runId, parentSessionID: options.parentSessionID, call: call.port, signal: call.signal, detach,
        executionMode: options.executionMode, lease: options.lease, ...(call.spawnPolicy && { spawnPolicy: call.spawnPolicy }), ...(enter && { enter }) })
    } finally {
      driving.delete(runId)
      options.onDriveEnded?.(runId)
    }
  }
  return Object.freeze({
    store,
    manager,
    async drive(runId: DagRunId, call: NativeDagCall): Promise<DagRunResult> {
      await run(runId, call, false)
      return results.wait(runId, options.parentSessionID)
    },
    async admit(runId: DagRunId, call: NativeDagCall): Promise<void> { await run(runId, call, true) },
    control: (runId: DagRunId, call: NativeDagCall, entry: NativeDagEntry, detach: boolean) => run(runId, call, detach, entry),
    driving: () => driving.size,
    isDriving: (runId: string) => driving.has(runId),
  })
}
