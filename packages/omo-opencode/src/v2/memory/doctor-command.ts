// `/doctor [--json]` (plan S7c): the memory-core doctor (moved from omo-senpi `commands/doctor-runtime.ts`)
// over the bound identity. Two host differences, both recorded in the parity table:
// - the reflection-health line reads the memory-core park file (streak, last failure, park state); V2
//   writes no Senpi completion records, child logs or remediation hints;
// - the skill `name:` frontmatter repair is not run, so `/doctor` never writes the memory repo's working
//   tree outside a memory commit (a dirty tree would fail the next reflection merge with `parent_dirty`).
// The projection line reports the limits the V2 projection compiles with (`memory.projection`); the
// runtime-size line reads the bound settings' `memory.runtime` cap and windows.

import {
  formatStaleLockFixLines,
  readReflectionParkFile,
  reclaimDeadOwnerLocks,
  REFLECTION_PARK_PROBE_INTERVAL_MS,
  resolveRuntimeMaxBytes,
  resolveRuntimeReflectionEnabled,
  resolveRuntimeRetentionPolicy,
  runStaleLockReaper,
  type ReflectionParkState,
} from "@oh-my-opencode/memory-core"
import { runDoctor, type DoctorCheck } from "@oh-my-opencode/memory-core/doctor"
import { v2Slash } from "../commands/namespace"
import type { BoundMemorySession } from "./binding"
import { coreCommandCall, INSIGHT_COMMAND_NAMES, UNBOUND_MEMORY_SESSION } from "./insight-commands"
import type { ExtraMemoryCommand } from "./reflect-command"

/** A streak at or above this many failures warns, as Senpi's reflection-health line does. */
const STREAK_WARN = 3

function nextProbeAt(park: ReflectionParkState): string {
  const from = Date.parse(park.lastProbeAt ?? park.parkedAt ?? "")
  return Number.isFinite(from) ? new Date(from + REFLECTION_PARK_PROBE_INTERVAL_MS).toISOString() : "unknown"
}

/** The V2 reflection-health line, from the reservation store's park file. */
async function reflectionParkHealth(reflectionDir: string): Promise<DoctorCheck> {
  let park: ReflectionParkState
  try {
    park = await readReflectionParkFile(reflectionDir)
  } catch (error) {
    return {
      name: "reflection-health",
      level: "warn",
      detail: `park state unreadable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (park.streak === 0 && park.parkedAt === undefined)
    return { name: "reflection-health", level: "ok", detail: "streak 0; no recorded failure" }
  const failure = park.lastFailure
  const last =
    failure === undefined
      ? "no failure detail"
      : `last failure ${failure.reason ?? "unknown"} at ${failure.at} (run ${failure.runId})${failure.detail === undefined ? "" : `: ${failure.detail}`}`
  const paused =
    park.parkedAt === undefined
      ? ""
      : `; automatic reflection paused since ${park.parkedAt} (next probe ${nextProbeAt(park)}; run ${v2Slash("reflect")} to retry now)`
  return {
    name: "reflection-health",
    level: park.streak >= STREAK_WARN || park.parkedAt !== undefined ? "warn" : "ok",
    detail: `streak ${park.streak}; fingerprint ${failure?.fingerprint ?? "none"}; ${last}${paused}`,
  }
}

/**
 * `/doctor --fix [--dry-run]`: the shared stale reflection-lock reaper with its minimal settle (the one
 * `omo doctor --fix` runs), then the dead-owner lock reclaim. A live holder, a young launch or a run whose
 * owner is not provably gone is kept and reported.
 */
async function reflectionLockFix(bound: BoundMemorySession, dryRun: boolean): Promise<readonly string[]> {
  const report = await runStaleLockReaper({ runtimeDir: bound.paths.runtime, dryRun })
  const locks = dryRun ? undefined : await reclaimDeadOwnerLocks(bound.paths.locks)
  return formatStaleLockFixLines(bound.identity, report, locks)
}

export function createDoctorCommand(deps: { readonly now?: () => number } = {}): ExtraMemoryCommand {
  return {
    name: INSIGHT_COMMAND_NAMES.doctor,
    description: "Run deterministic memory health checks; --fix [--dry-run] reclaims stale reflection locks.",
    async run(bound: BoundMemorySession | undefined, args: string) {
      if (bound === undefined) return { text: UNBOUND_MEMORY_SESSION, level: "error" }
      const call = coreCommandCall(bound)
      const text = await runDoctor(
        {
          ...call.deps,
          ...(deps.now === undefined ? {} : { now: deps.now }),
          skillRepair: false,
          doctorSettings: () => ({
            warnTokens: bound.settings.compile_warn_tokens,
            projectionLimits: {
              maxEntriesPerDirectory: bound.settings.projection.max_entries_per_directory,
              maxBytes: bound.settings.projection.max_bytes,
            },
          }),
          reflectionHealth: (identity) => reflectionParkHealth(identity.identityPaths.reflection),
          runtimeSize: (identity) => ({
            maxBytes: resolveRuntimeMaxBytes(bound.settings, identity.identity),
            policy: resolveRuntimeRetentionPolicy(bound.settings, identity.identity),
            reflectionEnabled: resolveRuntimeReflectionEnabled(bound.settings, identity.identity),
          }),
          reflectionLockFix: (_sessionId, options) => reflectionLockFix(bound, options.dryRun),
        },
        call.ctx,
        args,
      )
      return { text, level: call.level() }
    },
  }
}
