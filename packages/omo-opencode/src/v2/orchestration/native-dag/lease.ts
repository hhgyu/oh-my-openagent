import { randomInt } from "node:crypto"
import type { DagLeasePort } from "@oh-my-opencode/senpi-task/dag"

// Holders of the DAG component generations alive in THIS host process. A reload keeps the pid, so
// a pid lease would read its own retired generation as live forever (parity P-05).
const liveGenerations = new Set<number>()
// Above any real pid range, so a generation holder is never mistaken for a probe-able process.
const HOLDER_FLOOR = 2 ** 40

export interface NativeDagGenerationLease extends DagLeasePort {
  /** Retires this generation: from now on its recorded holder reads as stale. */
  dispose(): void
}

/** A DAG run lease keyed by the plugin generation instead of the pid. The holder is persisted as
 * `leaseHolderPid` (the checkpoint format is unchanged); it is alive only while the generation that
 * claimed it is live in this process. A holder from another process cannot be proved alive here and
 * reads as stale. */
export function createNativeDagGenerationLease(): NativeDagGenerationLease {
  let holder = HOLDER_FLOOR + randomInt(0, 2 ** 40)
  while (liveGenerations.has(holder)) holder = HOLDER_FLOOR + randomInt(0, 2 ** 40)
  liveGenerations.add(holder)
  const own = holder
  return Object.freeze({
    holder: () => own,
    isAlive: (recorded: number) => liveGenerations.has(recorded),
    dispose() { liveGenerations.delete(own) },
  })
}
