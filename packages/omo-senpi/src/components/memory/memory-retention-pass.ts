// The runtime retention pass and the host-sweep slice that memory-maintenance.ts runs when one is due. They
// live in memory-core (retention/maintenance-pass.ts, shared with the OpenCode 2 host); this module binds
// the `omo-senpi memory` log prefix. It ships in the memory commands sidecar (commands/runtime.ts) and
// loads through loadMemoryCommandsRuntime, so the entry bundle carries only the scheduler and its due
// checks. Nothing in the entry bundle may import this module statically.

import {
  retentionResumePending,
  runMaintenanceHostSweep as runCoreMaintenanceHostSweep,
  runMaintenanceRetention as runCoreMaintenanceRetention,
  type MaintenanceHostSweepInput as CoreMaintenanceHostSweepInput,
  type MaintenanceRetentionInput as CoreMaintenanceRetentionInput,
} from "@oh-my-opencode/memory-core"

export { retentionResumePending }

const LOG_PREFIX = "omo-senpi memory"

export type MaintenanceRetentionInput = Omit<CoreMaintenanceRetentionInput, "logPrefix">
export type MaintenanceHostSweepInput = Omit<CoreMaintenanceHostSweepInput, "logPrefix">

export async function runMaintenanceRetention(input: MaintenanceRetentionInput): Promise<void> {
  await runCoreMaintenanceRetention({ ...input, logPrefix: LOG_PREFIX })
}

export async function runMaintenanceHostSweep(input: MaintenanceHostSweepInput): Promise<void> {
  await runCoreMaintenanceHostSweep({ ...input, logPrefix: LOG_PREFIX })
}
