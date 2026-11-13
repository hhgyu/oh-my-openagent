// The Senpi reflection-health line of /doctor: it reads the Senpi worker's completion records, child
// logs and remediation hints, so it stays here and is handed to the memory-core doctor as a host port.

import { join } from "node:path"

import { readReflectionParkFile } from "@oh-my-opencode/memory-core"
import type { DoctorCheck } from "@oh-my-opencode/memory-core/doctor"

import {
  locateReflectionChildLog,
  readReflectionHealth,
  reflectionParkNextProbeAt,
  reflectionRemediation,
} from "../worker"

/**
 * The streak severity is a function of a clock: `readReflectionHealth` retires a trailing failure
 * burst once its newest failure is older than REFLECTION_HEALTH_STALE_MS, so `[warn]` decays to
 * `[ok]` purely with the passage of time. Reading that clock from `deps.now` (the seam `checkFacts`
 * already uses) keeps the derivation a pure function of its inputs instead of the wall clock, so a
 * fixture can pin either side of the boundary and stay pinned. Omitting `now` falls back to
 * `Date.now()`, which is byte-identical to the previous behavior.
 */
export async function checkReflectionHealth(
  reflectionDir: string,
  options: { readonly now?: number } = {},
): Promise<DoctorCheck> {
  const health = await readReflectionHealth(join(reflectionDir, "completions"), {
    now: options.now ?? Date.now(),
  })
  const lastSuccess = health.lastSuccessAt ?? "never"
  if (health.streak === 0 && health.pendingCount === 0) {
    return {
      name: "reflection-health",
      level: "ok",
      detail: `streak 0; pending 0; last success ${lastSuccess}`,
    }
  }
  const failure = health.lastFailure
  const hint = reflectionRemediation(
    failure?.reason,
    failure?.detail,
    await locateReflectionChildLog(reflectionDir, failure?.runId),
  )
  const paused = await describeReflectionPark(reflectionDir)
  return {
    name: "reflection-health",
    level: health.streak >= 3 || paused !== "" ? "warn" : "ok",
    detail: `streak ${health.streak}; fingerprint ${health.fingerprint || "none"}; pending ${health.pendingCount}; last success ${lastSuccess}; ${hint}${paused}`,
  }
}

async function describeReflectionPark(reflectionDir: string): Promise<string> {
  try {
    const park = await readReflectionParkFile(reflectionDir)
    if (park.parkedAt === undefined) return ""
    return `; automatic reflection paused since ${park.parkedAt} (next probe ${reflectionParkNextProbeAt(park) ?? "unknown"}; run /reflect to retry now)`
  } catch (error) {
    return `; park state unreadable: ${error instanceof Error ? error.message : String(error)}`
  }
}
