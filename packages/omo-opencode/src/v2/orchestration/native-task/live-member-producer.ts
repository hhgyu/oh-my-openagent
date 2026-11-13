// Named so declaration emit can reference the original workpool result type.
import type { WorkpoolToolResult } from "@oh-my-opencode/senpi-task/task-operations"
import {
  createMemberTaskSendTool,
  createWorkpoolWorkerTool,
  type MemberTaskSendDeps,
  type MemberTaskSendInput,
  type MemberTaskSendTool,
  type WorkpoolWorkerDeps,
  type WorkpoolWorkerTool,
} from "@oh-my-opencode/senpi-task/task-operations"

/** Supplied only by trusted composition from the original backend child and actual SDK caller. */
export interface MemberProducerCall {
  readonly child: object
  readonly sessionID: string
  readonly agent: string
  readonly registration: object
}
export interface MemberProducerBinding extends MemberProducerCall {
  /** Checks the actual registration generation and backend lifetime, never caller-supplied flags. */
  readonly assertCurrent: () => void
}

function own<I, R, T extends { readonly parameters: unknown; readonly execute: (id: string, input: I) => Promise<R> }>(
  nativeTool: T,
  assertOwnerCurrent: () => void,
) {
  let binding: MemberProducerBinding | undefined
  let revoked = false
  const pending = new Set<Promise<void>>()
  function assertCurrent(call: MemberProducerCall): void {
    if (revoked) throw Error("Member producer revoked")
    if (!binding) throw Error("Member producer unbound")
    if (
      call.child !== binding.child ||
      call.sessionID !== binding.sessionID ||
      call.agent !== binding.agent ||
      call.registration !== binding.registration
    ) {
      throw Error("Member producer custody mismatch")
    }
    const current = binding
    assertOwnerCurrent()
    current.assertCurrent()
    if (revoked) throw Error("Member producer revoked")
    if (
      binding !== current ||
      call.child !== current.child ||
      call.sessionID !== current.sessionID ||
      call.agent !== current.agent ||
      call.registration !== current.registration
    ) {
      throw Error("Member producer custody changed during validation")
    }
  }
  return {
    // These are the original factory object, schema and function, not reconstructed descriptors.
    nativeTool,
    parameters: nativeTool.parameters,
    execute: nativeTool.execute,
    bind(value: MemberProducerBinding): void {
      if (revoked) throw Error("Member producer revoked")
      if (binding) throw Error("Member producer already bound")
      if (!value.child || !value.registration || !value.sessionID || !value.agent)
        throw Error("Incomplete member custody")
      const checkRegistration = value.assertCurrent
      assertOwnerCurrent()
      checkRegistration.call(value)
      if (revoked) throw Error("Member producer revoked")
      // Snapshot identities, so mutation of a caller-owned binding object cannot reassign custody.
      binding = Object.freeze({
        child: value.child,
        sessionID: value.sessionID,
        agent: value.agent,
        registration: value.registration,
        assertCurrent: () => checkRegistration.call(value),
      })
    },
    assertCurrent,
    invoke(call: MemberProducerCall, callID: string, input: I): Promise<R> {
      assertCurrent(call)
      let settled!: () => void
      const completion = new Promise<void>((resolve) => {
        settled = resolve
      })
      // Own the invocation before entering the closure: an engine event may synchronously revoke/join.
      pending.add(completion)
      const finish = () => {
        pending.delete(completion)
        settled()
      }
      try {
        const original = nativeTool.execute(callID, input)
        // Both outcomes settle our custody; the caller still receives the exact original promise/result.
        void original.then(finish, finish)
        return original
      } catch (error) {
        finish()
        throw error
      }
    },
    revoke(): void {
      revoked = true
    },
    async join(): Promise<void> {
      revoked = true
      // The Native mailbox/yield closures have no abort port. Interruption cannot certify exit.
      await Promise.allSettled([...pending])
    },
  }
}

/** The owner must check LIVE team membership and the original task lifetime on every invocation. */
export function createTeamMemberProducer(owner: {
  readonly native: MemberTaskSendDeps
  readonly assertCurrent: () => void
}) {
  const checkOwner = owner.assertCurrent
  return own<MemberTaskSendInput, Awaited<ReturnType<MemberTaskSendTool["execute"]>>, MemberTaskSendTool>(
    createMemberTaskSendTool(owner.native),
    () => checkOwner.call(owner),
  )
}

/** Only the genuine worker engine is accepted here; the leader scheduler/context is not exposed. */
export function createWorkpoolMemberProducer(owner: {
  readonly native: WorkpoolWorkerDeps
  readonly assertCurrent: () => void
}) {
  const checkOwner = owner.assertCurrent
  const epoch = owner.native.runEpoch()
  return own<
    Parameters<WorkpoolWorkerTool["execute"]>[1],
    Awaited<ReturnType<WorkpoolWorkerTool["execute"]>>,
    WorkpoolWorkerTool
  >(createWorkpoolWorkerTool(owner.native), () => {
    checkOwner.call(owner)
    if (owner.native.runEpoch() !== epoch) throw Error("Member worker epoch changed")
  })
}
