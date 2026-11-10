// One bounded `wakes.ndjson` line per settled wake under `recall/sidecars/<encoded-session>/` (the
// record half of omo-senpi `kibitzer/observe.ts`). Writes are serialized per file and never throw
// into the sidecar.

import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { redactKibitzerEventText } from "@oh-my-opencode/memory-core/recall-sidecar"
import type { KibitzerWakeOutcome } from "./outcome"

export const KIBITZER_WAKE_RECORD_MAX_CHARS = 4096
const PATH_CAP = 200

export interface KibitzerWakeRecorder {
  record(file: string, outcome: KibitzerWakeOutcome): void
  idle(): Promise<void>
}

export function kibitzerWakeRecord(outcome: KibitzerWakeOutcome, at: number): string {
  const base = {
    at: new Date(at).toISOString(), wake: outcome.wake, generation: outcome.generation, status: outcome.status,
    ...(outcome.cause === undefined ? {} : { cause: outcome.cause }),
    ...(outcome.model === undefined ? {} : { model: outcome.model.slice(0, PATH_CAP) }),
    ...(outcome.cursors === undefined ? {} : { cursors: outcome.cursors }),
    toolCalls: outcome.toolCalls, durationMs: outcome.durationMs, slotWaitMs: outcome.slotWaitMs, steered: outcome.steered,
    ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
    diagnostic: outcome.diagnostic,
  }
  const full = {
    ...base,
    ...(outcome.reason === undefined ? {} : { reason: redactKibitzerEventText(outcome.reason) }),
    delivered: outcome.nudges.map(nudge => nudge.path.slice(0, PATH_CAP)),
  }
  const line = JSON.stringify(full)
  return line.length <= KIBITZER_WAKE_RECORD_MAX_CHARS ? line : JSON.stringify({ ...base, truncated: true })
}

export function createKibitzerWakeRecorder(options: { readonly now?: () => number; readonly warn?: (message: string, details?: Record<string, unknown>) => void } = {}): KibitzerWakeRecorder {
  const now = options.now ?? Date.now
  const chains = new Map<string, Promise<void>>()
  return {
    record(file, outcome) {
      const line = `${kibitzerWakeRecord(outcome, now())}\n`
      const next = (chains.get(file) ?? Promise.resolve()).then(async () => {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 })
        await appendFile(file, line, { encoding: "utf8", mode: 0o600 })
      }).catch((error: unknown) => {
        options.warn?.("kibitzer wake record skipped", { error: error instanceof Error ? error.message : String(error) })
      })
      chains.set(file, next)
      void next.finally(() => { if (chains.get(file) === next) chains.delete(file) })
    },
    async idle() {
      await Promise.allSettled([...chains.values()])
    },
  }
}
