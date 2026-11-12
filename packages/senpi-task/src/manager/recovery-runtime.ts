import { RpcProcessRunner } from "../runners/rpc-process"
import type { RpcChildHandle, RpcRunnerSpec } from "../runners/types"
import type { TaskRecord } from "../state"
import type { RespawnResult } from "../lifecycle/port"
import type { WorkpoolEngine } from "../workpool/engine"
import type { TaskManagerOptions } from "./types"
import { respawnWithWorkpool } from "./workpool-respawn"

export type RpcRespawnRunner = {
  start(spec: RpcRunnerSpec): Promise<RpcChildHandle>
  settleTeardowns?(): Promise<void>
}
export type TaskManagerImplOptions = TaskManagerOptions & {
  readonly rpcRespawnRunner?: RpcRespawnRunner
}
export interface TaskRecoveryRequest {
  readonly record: TaskRecord
  readonly sessionPath: string | undefined
  readonly paused?: boolean
  readonly beforeLaunch: () => void
}
export type RecoveryWorkerCapabilities = Pick<WorkpoolEngine, "ownsTask" | "yieldResults">
/** Adapter-local Native service: record/sessionPath/handles remain Native contracts. */
export interface TaskRecoveryRuntime {
  respawn(
    request: TaskRecoveryRequest,
    workers: RecoveryWorkerCapabilities,
    epoch: () => number,
  ): Promise<RespawnResult>
  settleTeardowns(): Promise<void>
}
export type TaskRecoveryRuntimeFactory = (options: TaskManagerImplOptions) => TaskRecoveryRuntime

/** Called exactly at the original constructor provisioning point, never on first revival. */
export function createNativeTaskRecoveryRuntime(options: TaskManagerImplOptions): TaskRecoveryRuntime {
  if (options.runners === undefined) throw new Error("Native recovery requires Native runner mappings")
  const runners = options.runners
  const rpcRunner = options.rpcRespawnRunner ?? new RpcProcessRunner()
  return {
    respawn(request, workers, epoch) {
      return respawnWithWorkpool(
        {
          record: request.record,
          ...(request.paused === true ? { paused: true } : {}),
          sessionPath: request.sessionPath,
          stateDir: options.store.stateDir,
          runners,
          rpcRunner,
          beforeLaunch: request.beforeLaunch,
          ...(options.trustedRespawnLaunch === undefined ? {} : { trustedLaunch: options.trustedRespawnLaunch }),
          ...(options.resolveInheritedExtensions === undefined
            ? {}
            : { inheritedExtensions: options.resolveInheritedExtensions }),
        },
        workers,
        epoch,
      )
    },
    async settleTeardowns() {
      await rpcRunner.settleTeardowns?.()
    },
  }
}
