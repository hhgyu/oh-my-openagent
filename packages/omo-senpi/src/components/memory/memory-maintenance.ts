// The background memory repo maintenance scheduler lives in memory-core (shared with the OpenCode 2
// host). Senpi binds it to its identity context, keeps its `omo-senpi memory` log prefix, and supplies the
// runtime retention pass and the host sweep from the memory commands sidecar, loaded only when one is due.

import { dirname } from "node:path"

import type { ForeignMemoryRuntimeSettings, RuntimeRetentionPolicy } from "@oh-my-opencode/memory-core"
import {
  createMemoryMaintenance as createCoreMemoryMaintenance,
  type MemoryMaintenance as CoreMemoryMaintenance,
  type MemoryMaintenanceHostSweep,
  type MemoryMaintenanceOptions as CoreMemoryMaintenanceOptions,
  type MemoryMaintenanceRetention,
} from "@oh-my-opencode/memory-core/maintenance"
import type { OmoMemorySettings } from "@oh-my-opencode/omo-config-core"

import { loadMemoryCommandsRuntime } from "./commands/runtime-loader"
import type { MemoryIdentityContext } from "./context"

export type MemoryMaintenanceOptions = Omit<
  CoreMemoryMaintenanceOptions<MemoryIdentityContext>,
  "logPrefix" | "retention" | "hostSweep"
> & {
  /** `memory.runtime` windows for this identity; defaults to the documented ones. */
  readonly resolveRetention?: (context: MemoryIdentityContext) => RuntimeRetentionPolicy
  /** `memory.reflection.enabled` for the identity: the health gate only guards identities that reflect. */
  readonly reflectionEnabled?: (context: MemoryIdentityContext) => boolean
  /** `memory.runtime.max_bytes` for this identity (`0` = unbounded); defaults to the documented 2 GiB. */
  readonly resolveMaxBytes?: (context: MemoryIdentityContext) => number
  /** The memory settings an identity's `memory.runtime` windows and cap resolve from, in the sidecar; the two resolvers above win. */
  readonly memorySettings?: (context: MemoryIdentityContext) => OmoMemorySettings
  /** Encoded sidecar directory names this process's live sessions own. */
  readonly ownedSidecars?: () => ReadonlySet<string>
  /**
   * Driver 2 of the host sweep (design 6b): undefined disables it (CI, task children, print runs);
   * otherwise it returns the GLOBAL memory settings that foreign identities are swept with.
   */
  readonly hostSweep?: () => { readonly settings?: ForeignMemoryRuntimeSettings } | undefined
}
export type MemoryMaintenance = CoreMemoryMaintenance<MemoryIdentityContext>

export function createMemoryMaintenance(options: MemoryMaintenanceOptions = {}): MemoryMaintenance {
  const { resolveRetention, reflectionEnabled, resolveMaxBytes, memorySettings, ownedSidecars, hostSweep, ...core } =
    options
  const now = options.now ?? Date.now
  const retention: MemoryMaintenanceRetention<MemoryIdentityContext> = {
    resumePending: async (runtimeDir) => (await loadMemoryCommandsRuntime()).retentionResumePending(runtimeDir),
    run: async (context, repo, signal) => {
      const { runMaintenanceRetention } = await loadMemoryCommandsRuntime()
      signal.throwIfAborted()
      await runMaintenanceRetention({
        identity: context.identity,
        paths: context.identityPaths,
        repo,
        signal,
        now,
        ...(resolveRetention === undefined ? {} : { policy: resolveRetention(context) }),
        ...(resolveMaxBytes === undefined ? {} : { maxBytes: resolveMaxBytes(context) }),
        ...(memorySettings === undefined ? {} : { settings: memorySettings(context) }),
        reflectionEnabled: reflectionEnabled?.(context) ?? true,
        ...(options.isLiveSession === undefined ? {} : { isLiveSession: options.isLiveSession }),
        ...(ownedSidecars === undefined ? {} : { ownedSidecars: ownedSidecars() }),
        ...(options.logger === undefined
          ? {}
          : { info: options.logger.info.bind(options.logger), warn: options.logger.warn.bind(options.logger) }),
      })
    },
  }
  const sweep = (context: MemoryIdentityContext): MemoryMaintenanceHostSweep | undefined => {
    const host = hostSweep?.()
    if (host === undefined) return undefined
    const memoryRoot = dirname(dirname(context.identityPaths.root))
    return {
      memoryRoot,
      run: async ({ isHostedIdentity, signal, now: clock }) => {
        const { runMaintenanceHostSweep } = await loadMemoryCommandsRuntime()
        signal.throwIfAborted()
        await runMaintenanceHostSweep({
          memoryRoot,
          ...(host.settings === undefined ? {} : { settings: host.settings }),
          isHostedIdentity,
          signal,
          now: clock,
          ...(options.logger === undefined ? {} : { info: options.logger.info.bind(options.logger) }),
        })
      },
    }
  }
  return createCoreMemoryMaintenance<MemoryIdentityContext>({
    ...core,
    logPrefix: "omo-senpi memory",
    retention,
    hostSweep: sweep,
  })
}
