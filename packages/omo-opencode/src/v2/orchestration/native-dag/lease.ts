import { randomInt } from "node:crypto"
import { getPidLiveness } from "@oh-my-opencode/memory-core/process-identity"
import type { DagFileStore, DagLeasePort, DagRunId, DagRunRecordV1 } from "@oh-my-opencode/senpi-task/dag"
import { NativeDagRefusal } from "./refusals"

// Holders of the DAG component generations alive in THIS host process. A reload keeps the pid, so
// a pid lease would read its own retired generation as live forever (parity P-05).
const liveGenerations = new Set<number>()
// A holder is HOLDER_BASE + pid * GENERATIONS + generation. It stays above every real pid (so a pid
// probe never mistakes it for a process), it is a safe integer for every pid below 2^32 (the
// largest is 2^53 - 1), and it names the process that owns it, so another process can prove it
// alive with that pid's signal-0 probe.
const HOLDER_BASE = 2 ** 52
const GENERATIONS = 2 ** 20
const PID_LIMIT = 2 ** 32
const TERMINAL_RUN: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])

export interface NativeDagGenerationLease extends DagLeasePort {
  /** Retires this generation: from now on its recorded holder reads as stale. */
  dispose(): void
}

export interface NativeDagGenerationLeaseOptions {
  /** The owning process (tests only); defaults to this process. */
  readonly pid?: number
  /** Liveness of ANOTHER process's pid; defaults to the signal-0 probe (alive or EPERM). */
  readonly isProcessAlive?: (pid: number) => boolean
}

/** The owning pid of a generation holder, or undefined for a number this encoding never issues (a
 * holder from before the pid encoding, or a plain pid). */
function holderPid(holder: number): number | undefined {
  if (!Number.isSafeInteger(holder) || holder < HOLDER_BASE) return undefined
  return Math.floor((holder - HOLDER_BASE) / GENERATIONS)
}

/** A DAG run lease keyed by the plugin generation instead of the pid. The holder is persisted as
 * `leaseHolderPid` (the checkpoint format is unchanged) and encodes the owning pid. A holder of THIS
 * process is alive only while the generation that claimed it is live here (a retired generation of
 * the same pid is dead); a holder of another process is alive while that pid is, like Native's pid
 * lease, so a second OpenCode process refuses a run the first is still driving. A holder this
 * encoding never issued reads as stale. */
export function createNativeDagGenerationLease(options: NativeDagGenerationLeaseOptions = {}): NativeDagGenerationLease {
  const pid = options.pid ?? process.pid
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid >= PID_LIMIT) throw Error(`Process id ${pid} cannot be encoded in a DAG generation lease`)
  const isProcessAlive = options.isProcessAlive ?? ((other: number) => getPidLiveness(other) === "alive")
  const issue = () => HOLDER_BASE + pid * GENERATIONS + randomInt(0, GENERATIONS)
  let holder = issue()
  while (liveGenerations.has(holder)) holder = issue()
  liveGenerations.add(holder)
  const own = holder
  return Object.freeze({
    holder: () => own,
    isAlive(recorded: number) {
      const owner = holderPid(recorded)
      if (owner === undefined) return false
      return owner === pid ? liveGenerations.has(recorded) : isProcessAlive(owner)
    },
    dispose() { liveGenerations.delete(own) },
  })
}

type LeasedRecord = DagRunRecordV1 & { readonly leaseHolderPid?: number; readonly previousLeaseHolderPid?: number }

/** The run store as one generation's runtime writes it: an event for a run whose durable checkpoint
 * is already terminal under a holder other than this generation is refused, so a scheduler never
 * writes over a terminal state another holder settled (and released). A run this generation re-enters
 * (a retry or amend of a settled run) carries its own holder first (`claimDagRunLease`), and the
 * scheduler that settles a run still holds it, so neither is affected. Wrap the store ONCE per runtime:
 * the engine keys its commit notifications on the store object. */
export function fenceForeignTerminalRuns(store: DagFileStore, lease: DagLeasePort): DagFileStore {
  return {
    ...store,
    appendEvent(event) {
      const durable = store.readCheckpoint<LeasedRecord>(event.runId)
      if (durable !== null && TERMINAL_RUN.has(durable.status) && durable.leaseHolderPid !== lease.holder()) {
        throw new NativeDagRefusal("run_still_active", `Dag run ${event.runId} was already settled ${durable.status} by another holder; this OpenCode 2 plugin generation does not write over it.`)
      }
      store.appendEvent(event)
    },
  }
}

/** The recorded holder of `record` when it is ANOTHER live generation (of this process or another
 * one), the Native `claimPausedRun` / node-control-context liveness through the generation lease. */
function liveForeignHolder(record: DagRunRecordV1, lease: DagLeasePort): number | undefined {
  const leased: LeasedRecord = record
  const holder = leased.leaseHolderPid ?? (record.status === "paused" ? leased.previousLeaseHolderPid : undefined)
  return holder !== undefined && holder !== lease.holder() && lease.isAlive(holder) ? holder : undefined
}

/** Claims a run for THIS generation while one call drives it: the holder is written as
 * `leaseHolderPid` like Native recovery's claim, so another live generation (a reload overlap, or
 * another OpenCode process still driving it) is refused with `run_still_active` before anything is
 * paused, restored or started. A paused run is only checked here (its previous holder must not be
 * live); Native recovery itself claims it. Returns the release, which drops only our own claim
 * (Native `releaseLease`) and never clears a holder this claim did not set: a stale holder it
 * displaced is written back. */
export function claimDagRunLease(store: DagFileStore, runId: DagRunId, lease: DagLeasePort): () => void {
  let displaced: number | undefined
  store.withRunLock(runId, () => {
    const fresh = store.readCheckpoint<LeasedRecord>(runId)
    if (fresh === null) return
    const holder = liveForeignHolder(fresh, lease)
    if (holder !== undefined) throw new NativeDagRefusal("run_still_active", `Dag run ${runId} is held by another live OpenCode 2 plugin generation (lease ${holder}); call workflow again once it has shut down.`)
    if (fresh.status !== "paused" && fresh.leaseHolderPid !== lease.holder()) {
      displaced = fresh.leaseHolderPid
      store.writeCheckpoint(runId, { ...fresh, leaseHolderPid: lease.holder() })
    }
  })
  return () => store.withRunLock(runId, () => {
    const fresh = store.readCheckpoint<LeasedRecord>(runId)
    if (fresh === null || fresh.leaseHolderPid !== lease.holder()) return
    const { leaseHolderPid: _holder, previousLeaseHolderPid: _previous, ...released } = fresh
    store.writeCheckpoint(runId, displaced === undefined ? released : { ...released, leaseHolderPid: displaced })
  })
}
