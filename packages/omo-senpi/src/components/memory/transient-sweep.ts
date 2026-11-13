// Age-bounded reclaim for transient memory identity runs (issue #7765). The sweep lives in
// @oh-my-opencode/memory-core/transient (shared with the OpenCode 2 host); this module binds the
// `omo-senpi memory` warning prefix.

import {
  sweepTransientMemoryRuns as sweepCoreTransientMemoryRuns,
  type TransientSweepInput as CoreTransientSweepInput,
  type TransientSweepResult,
} from "@oh-my-opencode/memory-core/transient"

export { TRANSIENT_RUN_MAX_AGE_MS, type TransientSweepResult } from "@oh-my-opencode/memory-core/transient"

export type TransientSweepInput = Omit<CoreTransientSweepInput, "logPrefix">

export type TransientSweep = (input: TransientSweepInput) => Promise<TransientSweepResult>

export async function sweepTransientMemoryRuns(input: TransientSweepInput): Promise<TransientSweepResult> {
  return sweepCoreTransientMemoryRuns({ ...input, logPrefix: "omo-senpi memory" })
}
