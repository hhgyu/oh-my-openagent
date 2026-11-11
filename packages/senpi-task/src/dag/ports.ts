import { defaultSignaller } from "../lifecycle/context"
import type { TaskManager } from "../manager/types"

// The exact slice of the task manager the DAG engine drives. A second host implements only these
// nine methods; Senpi's concrete manager satisfies it structurally.
export type DagTaskPort = Pick<
  TaskManager,
  | "startOwned"
  | "findOwnedTask"
  | "get"
  | "getResidentHandle"
  | "subscribeChild"
  | "waitFor"
  | "cancelTask"
  | "sendToTask"
  | "residencyChanged"
>

// Run-lease identity and liveness. The holder is persisted verbatim as `leaseHolderPid` /
// `previousLeaseHolderPid`, so it stays a number to keep the on-disk checkpoint format unchanged.
export type DagLeasePort = {
  // The identity this host writes when it claims a run's lease.
  readonly holder: () => number
  // Whether a recorded holder can still be scheduling the run.
  readonly isAlive: (holder: number) => boolean
}

// Legacy pid knobs still accepted next to an explicit lease, so existing callers keep working.
export type DagLeaseSources = {
  readonly lease?: DagLeasePort
  readonly hostPid?: number
  readonly isProcessAlive?: (pid: number) => boolean
}

// The Senpi default: this process's pid as the holder and the lifecycle port's signal-0 probe.
export function processDagLease(
  hostPid: number = process.pid,
  isAlive: (pid: number) => boolean = defaultSignaller.isAlive,
): DagLeasePort {
  return { holder: () => hostPid, isAlive }
}

export function resolveDagLease(sources: DagLeaseSources): DagLeasePort {
  return sources.lease ?? processDagLease(sources.hostPid, sources.isProcessAlive)
}
