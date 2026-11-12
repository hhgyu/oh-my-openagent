import {
  createDagFileStore, createDagManager, createDagWaitSurface,
  type DagFileStore, type DagLeasePort, type DagManager, type DagMaterializeSkills, type DagNodeSpawnPolicy, type DagRunId, type DagRunRecordV1, type DagRunResult, type DagSettings,
} from "@oh-my-opencode/senpi-task/dag"
import { nativeTaskStateDir } from "../native-task/component"
import { driveDagRun, type NativeDagEntry } from "./drive"
import { fenceForeignTerminalRuns } from "./lease"
import { pauseRunsForShutdown } from "./recovery"
import { NativeDagRefusal, type NativeDagExecutionSources } from "./refusals"
import { callBoundSkillMaterializer } from "./skills"
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

/** One call's authority over the runtime: its operation port, its abort signal, its spawn policy
 * and, when its verb materializes skills, Native's materializer over THIS call's authorized skills. */
export interface NativeDagCall {
  readonly port: NativeDagCallPort
  readonly signal: AbortSignal
  readonly spawnPolicy?: DagNodeSpawnPolicy
  readonly materializeSkills?: DagMaterializeSkills
}

export interface NativeDagRuntime {
  readonly store: DagFileStore
  /** Reads, reuse and every verb that materializes nothing. It holds no skill authority. */
  readonly manager: DagManager
  /** The manager `start` and `amend` run through inside `call`: Native's manager over the same store
   * with the call's materializer, so each node's effectivePrompt is stored in the run record. */
  managerFor(call: NativeDagCall): DagManager
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
  /** Component close: waits for every drive to retire (the closing service already ended its call),
   * then pauses every live run of this root the way Native shutdown does, cancelling no child. */
  pauseForShutdown(): Promise<readonly DagRunId[]>
}

/** The DAG store, manager and per-run blocking drives of ONE root session, stored under that
 * session's Native task state directory. It holds no call: every drive borrows the call it runs in. */
export function createNativeDagRuntime(options: NativeDagRuntimeOptions): NativeDagRuntime {
  // One fenced store for the manager, every drive and every control: the engine keys its commit
  // notifications on the store object, and no writer here overwrites another holder's terminal run.
  const store = fenceForeignTerminalRuns(createDagFileStore({
    project_dir: options.directory,
    task: { state_dir: nativeTaskStateDir(options.directory, options.parentSessionID), ...(options.settings && { dag: options.settings }) },
  }), options.lease)
  // A manager outside a call never loads a skill; without a materializer an `amend` would keep each
  // changed node's PREVIOUS effective prompt and the re-run would dispatch the stale prompt.
  const managerWith = (materializeSkills: DagMaterializeSkills) => createDagManager({ store, materializeSkills, ...(options.settings && { settings: options.settings }) })
  const manager = managerWith(callBoundSkillMaterializer)
  // Results are projected from the store; a drive returns only after its run is terminal.
  const results = createDagWaitSurface({ store, subscribe: () => () => {} })
  const driving = new Map<string, Promise<unknown>>()
  async function run(runId: DagRunId, call: NativeDagCall, detach: boolean, enter?: NativeDagEntry): Promise<DagRunRecordV1> {
    if (driving.has(runId)) throw new NativeDagRefusal("run_still_active", `Dag run ${runId} is already being driven by another workflow call in this session.`)
    const drive = driveDagRun({ store, manager, runId, parentSessionID: options.parentSessionID, call: call.port, signal: call.signal, detach,
      executionMode: options.executionMode, lease: options.lease, materializeSkills: call.materializeSkills ?? callBoundSkillMaterializer,
      ...(call.spawnPolicy && { spawnPolicy: call.spawnPolicy }), ...(enter && { enter }) })
    driving.set(runId, drive)
    try {
      return await drive
    } finally {
      driving.delete(runId)
      options.onDriveEnded?.(runId)
    }
  }
  return Object.freeze({
    store,
    manager,
    managerFor: (call: NativeDagCall) => call.materializeSkills ? managerWith(call.materializeSkills) : manager,
    async drive(runId: DagRunId, call: NativeDagCall): Promise<DagRunResult> {
      await run(runId, call, false)
      return results.wait(runId, options.parentSessionID)
    },
    async admit(runId: DagRunId, call: NativeDagCall): Promise<void> { await run(runId, call, true) },
    control: (runId: DagRunId, call: NativeDagCall, entry: NativeDagEntry, detach: boolean) => run(runId, call, detach, entry),
    driving: () => driving.size,
    isDriving: (runId: string) => driving.has(runId),
    async pauseForShutdown() {
      await Promise.allSettled([...driving.values()])
      return pauseRunsForShutdown(store, options.parentSessionID, options.lease)
    },
  })
}
