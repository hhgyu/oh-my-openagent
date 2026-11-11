import {
  createDagFileStore, createDagManager, createDagWaitSurface,
  type DagFileStore, type DagLeasePort, type DagManager, type DagNodeSpawnPolicy, type DagRunId, type DagRunResult, type DagSettings,
} from "@oh-my-opencode/senpi-task/dag"
import { nativeTaskStateDir } from "../native-task/component"
import { driveDagRun } from "./drive"
import { NativeDagRefusal, type NativeDagExecutionSources } from "./refusals"
import type { NativeDagCallPort } from "./task-port"

export interface NativeDagRuntimeOptions {
  readonly directory: string
  /** The root session whose Native task state directory holds this runtime's DAG store. */
  readonly parentSessionID: string
  readonly settings?: Partial<DagSettings>
  readonly executionMode: NativeDagExecutionSources
  readonly lease: DagLeasePort
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
  /** Number of runs a call is driving right now. */
  driving(): number
}

/** The DAG store, manager and per-run blocking drives of ONE root session, stored under that
 * session's Native task state directory. It holds no call: every drive borrows the call it runs in. */
export function createNativeDagRuntime(options: NativeDagRuntimeOptions): NativeDagRuntime {
  const store = createDagFileStore({
    project_dir: options.directory,
    task: { state_dir: nativeTaskStateDir(options.directory, options.parentSessionID), ...(options.settings && { dag: options.settings }) },
  })
  const manager = createDagManager({ store, ...(options.settings && { settings: options.settings }) })
  // Results are projected from the store; a drive returns only after its run is terminal.
  const results = createDagWaitSurface({ store, subscribe: () => () => {} })
  const driving = new Set<DagRunId>()
  return Object.freeze({
    store,
    manager,
    async drive(runId: DagRunId, call: NativeDagCall): Promise<DagRunResult> {
      if (driving.has(runId)) throw new NativeDagRefusal("run_still_active", `Dag run ${runId} is already being driven by another workflow call in this session.`)
      driving.add(runId)
      try {
        await driveDagRun({ store, manager, runId, parentSessionID: options.parentSessionID, call: call.port, signal: call.signal,
          executionMode: options.executionMode, lease: options.lease, ...(call.spawnPolicy && { spawnPolicy: call.spawnPolicy }) })
      } finally { driving.delete(runId) }
      return results.wait(runId, options.parentSessionID)
    },
    driving: () => driving.size,
  })
}
