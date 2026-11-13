// `memory.runtime` resolution for an identity a session hosts (moved from omo-senpi
// memory-runtime-retention.ts, shared with the OpenCode 2 host). The settings are the resolved
// `memory` block of the host's config; `agents.<id>.runtime` wins field by field.

import type { RuntimeRetentionPolicy } from "./policy"

interface RuntimeLayer {
  readonly retention_days: number
  readonly abandoned_journal_days: number
  readonly discard_unreflected_journals: boolean
  readonly completions_days: number
  readonly pass_budget_ms: number
  readonly max_bytes: number
}

/** The resolved memory settings this module reads (structurally an `OmoMemorySettings`). */
export interface RuntimeMemorySettings {
  readonly runtime: RuntimeLayer
  readonly reflection: { readonly enabled: boolean }
  readonly agents: Readonly<
    Record<
      string,
      { readonly runtime?: Partial<RuntimeLayer>; readonly reflection?: { readonly enabled?: boolean } } | undefined
    >
  >
}

/** `memory.runtime` windows for one identity. */
export function resolveRuntimeRetentionPolicy(
  settings: RuntimeMemorySettings,
  identity: string,
): RuntimeRetentionPolicy {
  const base = settings.runtime
  const override = settings.agents[identity]?.runtime
  return {
    retentionDays: override?.retention_days ?? base.retention_days,
    abandonedJournalDays: override?.abandoned_journal_days ?? base.abandoned_journal_days,
    discardUnreflectedJournals: override?.discard_unreflected_journals ?? base.discard_unreflected_journals,
    completionsDays: override?.completions_days ?? base.completions_days,
    passBudgetMs: override?.pass_budget_ms ?? base.pass_budget_ms,
  }
}

/** `memory.runtime.max_bytes` for one identity (`0` = unbounded). */
export function resolveRuntimeMaxBytes(settings: RuntimeMemorySettings, identity: string): number {
  return settings.agents[identity]?.runtime?.max_bytes ?? settings.runtime.max_bytes
}

/** `memory.reflection.enabled` for one identity: the retention health gate guards only identities that reflect. */
export function resolveRuntimeReflectionEnabled(settings: RuntimeMemorySettings, identity: string): boolean {
  return settings.agents[identity]?.reflection?.enabled ?? settings.reflection.enabled
}
