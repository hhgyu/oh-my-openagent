// The background memory repo maintenance scheduler lives in memory-core (shared with the OpenCode 2
// host). Senpi binds it to its identity context and keeps its `omo-senpi memory` log prefix.

import {
  createMemoryMaintenance as createCoreMemoryMaintenance,
  type MemoryMaintenance as CoreMemoryMaintenance,
  type MemoryMaintenanceOptions as CoreMemoryMaintenanceOptions,
} from "@oh-my-opencode/memory-core/maintenance"

import type { MemoryIdentityContext } from "./context"

export type MemoryMaintenanceOptions = Omit<CoreMemoryMaintenanceOptions<MemoryIdentityContext>, "logPrefix">
export type MemoryMaintenance = CoreMemoryMaintenance<MemoryIdentityContext>

export function createMemoryMaintenance(options: MemoryMaintenanceOptions = {}): MemoryMaintenance {
  return createCoreMemoryMaintenance<MemoryIdentityContext>({ ...options, logPrefix: "omo-senpi memory" })
}
