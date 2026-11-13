import { createDagScheduler, type DagRunId, type DagScheduler } from "@oh-my-opencode/senpi-task/dag"
import {
  createDagRuntimeControls,
  createPausedNodeCancel,
  type DagToolDeps,
  type PausedNodeHoldPort,
} from "@oh-my-opencode/senpi-task/dag-operations"
import { admittedChildren, type NativeDagEntered, type NativeDagEntry } from "./drive"
import type { NativeDagCall, NativeDagRuntime } from "./runtime"
import type { NativeDagCallPort } from "./task-port"
import { TERMINAL_TASK_STATUSES } from "./wake-projection"

type RuntimeControls = ReturnType<typeof createDagRuntimeControls>
type NativeDagControlDeps = Required<Pick<DagToolDeps, "cancel" | "cancelNode" | "retry" | "send" | "amend">>

interface NativeDagControlInput {
  readonly runtime: Pick<NativeDagRuntime, "manager" | "control">
  readonly parentSessionID: string
  readonly call: NativeDagCall
  /** `retry` and `amend` re-enter the run; detached (the default) they admit what can start now and
   * return, with detach=false they block until the run settles, like `wait`. */
  readonly detach: boolean
}

/** OpenCode 2 has no inherited run hold: a cancelled child's hold is closed once the child ended,
 * proven through THIS call's port; a child still running refuses, as Native `endedChildClosure`. */
function endedChildClosure(port: Pick<NativeDagCallPort, "get">): PausedNodeHoldPort {
  return {
    async closeHold(taskId) {
      const record = port.get(taskId)
      if (record !== undefined && !TERMINAL_TASK_STATUSES.has(record.status))
        throw Error(`task ${taskId} has not ended, so its run hold is still in place`)
    },
  }
}

/** The workflow control verbs of ONE call (S6e), running the ORIGINAL Native algorithms
 * (`createDagRuntimeControls`, the scheduler's run cancellation, the paused-node cancel) over a
 * scheduler bound to THIS call's operation. Every child action (cancel, steer, revive, start) goes
 * through this call's receipts and nothing is retained after it: a run no call drives right now is
 * held, so the control call itself is the live call that acts on it. A run another call drives is
 * refused with run_still_active. A retry or amend re-entry is driven by this call like `wait`. */
export function nativeDagControls(input: NativeDagControlInput): NativeDagControlDeps {
  const { runtime, parentSessionID: parent, call } = input
  /** One Native runtime control verb over this call's scheduler options. Returns the re-entry it
   * adopted (retry, amend) for the call to drive; every other scheduler it built is retired. */
  function native(verb: (controls: RuntimeControls) => Promise<unknown>): NativeDagEntry {
    return async (options) => {
      let adopted: NativeDagEntered | undefined
      const controllers: DagScheduler[] = []
      const controls = createDagRuntimeControls({
        coreManager: runtime.manager,
        schedulerOptions: options,
        schedulers: new Map(),
        sessionId: () => parent,
        controller(runId, sessionId) {
          const scheduler = createDagScheduler({ ...options, initialRecord: runtime.manager.record(runId, sessionId) })
          controllers.push(scheduler)
          return { scheduler }
        },
        // Admission is held by the call binding itself, never by a latch.
        clearAdmissionLatch() {},
        adoptReentry(_runId, reentry) {
          adopted = reentry
        },
      })
      try {
        await verb(controls)
      } catch (error) {
        await adopted?.scheduler.suspend()
        throw error
      } finally {
        for (const controller of controllers) await controller.suspend()
      }
      return adopted
    }
  }
  /** Native `cancel`: the scheduler's run cancellation cancels every attached child through this
   * call's port and journals the node and run transitions. Children earlier calls admitted are
   * attached first, so a held run's children are cancelled too. */
  const cancelRun =
    (runId: DagRunId, reason: string | undefined): NativeDagEntry =>
    async (options) => {
      const initialRecord = runtime.manager.record(runId, parent)
      const scheduler = createDagScheduler({
        ...options,
        initialRecord,
        preAttachedTasks: admittedChildren(initialRecord, options.taskManager, true),
      })
      try {
        await scheduler.cancel(runId, reason)
      } finally {
        await scheduler.suspend()
      }
      return undefined
    }
  return {
    async cancel(runId, reason) {
      await runtime.control(runId, call, cancelRun(runId, reason), true)
    },
    async cancelNode(runId, nodeId) {
      await runtime.control(
        runId,
        call,
        async (options) => {
          await createPausedNodeCancel(
            (id) => ({ ...options, initialRecord: runtime.manager.record(id, parent) }),
            endedChildClosure(options.taskManager),
          )(runId, nodeId)
          return undefined
        },
        true,
      )
    },
    async retry(runId, nodeIds, options) {
      await runtime.control(
        runId,
        call,
        native((controls) => controls.retry(runId, nodeIds, options)),
        input.detach,
      )
      return runtime.manager.snapshot(runId, parent)
    },
    async send(runId, nodeId, message) {
      let sent: Awaited<ReturnType<RuntimeControls["send"]>> | undefined
      await runtime.control(
        runId,
        call,
        native(async (controls) => {
          sent = await controls.send(runId, nodeId, message)
        }),
        true,
      )
      if (sent === undefined) throw Error(`workflow send to node ${nodeId} produced no outcome`)
      // A revived child's later fold is the engine's; its failure is the store's, not this call's.
      void sent.settled?.catch(() => {})
      return sent
    },
    async amend(runId, definition) {
      await runtime.control(
        runId,
        call,
        native((controls) => controls.amend(runId, definition)),
        input.detach,
      )
      return runtime.manager.snapshot(runId, parent)
    },
  }
}
