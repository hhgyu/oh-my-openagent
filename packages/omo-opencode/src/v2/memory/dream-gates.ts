// Dream trigger gates, ported from omo-senpi `components/memory/dream-trigger-gates.ts` (host-neutral; a
// later move-to-memory-core candidate). One evaluation order for every origin:
// - `manual` bypasses every automatic gate;
// - otherwise `dream.enabled`, then the shared `min_hours_between` spacing against the dream ledger
//   (`<identity runtime>/dream/state.json`, written by memory-core when a dream run succeeds);
// - `idle` additionally needs strictly more than 8192 bytes of unreflected transcript; `pressure` does not.
// V2 has no `shutdown` origin (parity P-29), so `shutdown_launch` is never read here.

import type { DreamOrigin } from "@oh-my-opencode/memory-core"
import { readFile } from "@oh-my-opencode/memory-core/fs"
import type { OmoMemorySettings } from "@oh-my-opencode/omo-config-core"
import { join } from "node:path"

/** Unreflected-volume floor for the transcript-driven idle origin, in UTF-8 bytes. */
const DREAM_VOLUME_GATE_BYTES = 8192

/** The origins a V2 host can raise. */
export type V2DreamOrigin = Exclude<DreamOrigin, "shutdown">

export interface DreamTriggerSettings {
  readonly enabled: boolean
  readonly idleMinutes: number
  readonly minHoursBetween: number
  readonly autoSelectMax: number
  readonly autoSelectMaxChars: number
}

/** Senpi `resolveDreamTriggerSettings`: the per-identity override wins field by field. */
export function resolveDreamTriggerSettings(settings: OmoMemorySettings, identity: string): DreamTriggerSettings {
  const base = settings.dream
  const override = settings.agents[identity]?.dream
  return {
    enabled: override?.enabled ?? base.enabled,
    idleMinutes: override?.idle_minutes ?? base.idle_minutes,
    minHoursBetween: override?.min_hours_between ?? base.min_hours_between,
    autoSelectMax: override?.auto_select_max ?? base.auto_select_max,
    autoSelectMaxChars: override?.auto_select_max_chars ?? base.auto_select_max_chars,
  }
}

export type DreamGateRejection = "disabled" | "too_soon" | "insufficient_volume"

type DreamGateDecision = { readonly allowed: true } | { readonly allowed: false; readonly rejection: DreamGateRejection }

/** Lazily probed inputs, so an early rejection never pays for a later probe. */
interface DreamGateProbe {
  readonly nowMs: number
  readonly lastDreamAtMs: () => Promise<number | null>
  readonly unreflectedBytes: () => Promise<number>
}

export async function evaluateDreamGates(origin: V2DreamOrigin, settings: DreamTriggerSettings, probe: DreamGateProbe): Promise<DreamGateDecision> {
  if (origin === "manual") return { allowed: true }
  if (!settings.enabled) return { allowed: false, rejection: "disabled" }
  const lastDreamAtMs = await probe.lastDreamAtMs()
  if (lastDreamAtMs !== null && probe.nowMs - lastDreamAtMs <= settings.minHoursBetween * 3_600_000) return { allowed: false, rejection: "too_soon" }
  if (origin !== "pressure" && (await probe.unreflectedBytes()) <= DREAM_VOLUME_GATE_BYTES) return { allowed: false, rejection: "insufficient_volume" }
  return { allowed: true }
}

/** Reads the dream ledger; an absent or malformed ledger means "never dreamed". */
export async function readLastDreamAtMs(runtimeDir: string): Promise<number | null> {
  let raw: string
  try {
    raw = await readFile(join(runtimeDir, "dream", "state.json"), "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  if (parsed === null || typeof parsed !== "object" || !("last_dream_at" in parsed) || typeof parsed.last_dream_at !== "string") return null
  const parsedMs = Date.parse(parsed.last_dream_at)
  return Number.isFinite(parsedMs) ? parsedMs : null
}
