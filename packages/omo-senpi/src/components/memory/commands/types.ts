// Shared seams for the memory slash-command suite.
//
// The host-neutral context, identity and response helpers live in memory-core
// (`@oh-my-opencode/memory-core/commands`); this module adds the senpi-only sinks
// and settings the facts, reflection, dream and people commands read.

import type { MemoryCommandDeps as CoreMemoryCommandDeps } from "@oh-my-opencode/memory-core/commands"
import type { OmoConfig, OmoMemorySettings } from "@oh-my-opencode/omo-config-core"

import type { PeopleAskRunner } from "./people-ask"

export {
  requireIdentity,
  respond,
  sessionIdOf,
  type MemoryCommandContext,
  type MemoryCommandHandler,
  type MemoryCommandIdentity,
  type MemoryCommandUi,
  type NotifyLevel,
} from "@oh-my-opencode/memory-core/commands"

/** P22 trigger-wiring seam: a manual `/reflect` request the scheduler reserves or queues. */
export interface ManualReflectionRequest {
  readonly focus?: string
  readonly recentN?: number
  readonly conversationIds?: readonly string[]
}

export interface ReflectionRequestReceipt {
  readonly disposition: "reserved" | "pending"
  readonly runId: string
  /** A dead run that held the reflection lock was settled, so this request runs next (#10377). */
  readonly recoveredRunId?: string
  /** The lock is held by a run whose liveness cannot be proven; shown with the next step (#10377). */
  readonly stuck?: string
}

export interface ReflectionRequestSink {
  request(request: ManualReflectionRequest): Promise<ReflectionRequestReceipt>
}

export interface ManualDreamCommandRequest {
  readonly focus?: string
  readonly conversationIds?: readonly string[]
  readonly targetDoc?: string
}

export type DreamCommandOutcome =
  | { readonly fired: true; readonly runId: string; readonly status: "active" | "pending" }
  | { readonly fired: false; readonly rejection: string }

export interface DreamRequestSink {
  request(request: ManualDreamCommandRequest): Promise<DreamCommandOutcome>
}

/** `/facts retry` seam: triggers exactly ONE reconcile/launch attempt after an unpark. */
export interface FactsRetrySink {
  reconcile(): Promise<void>
}

export interface MemoryCommandSettings {
  readonly settings: OmoMemorySettings
  /** Path of the omo config file users edit to change memory settings. */
  readonly configPath?: string
  /** Full resolved config; `/people --ask` needs it to resolve the quick model category. */
  readonly config?: OmoConfig
}

export interface MemoryCommandDeps extends CoreMemoryCommandDeps {
  loadSettings(): MemoryCommandSettings
  reflectionSink?: ReflectionRequestSink
  dreamSink?: DreamRequestSink
  /** Absent means `/facts retry` still clears records but cannot trigger a launch itself. */
  factsSink?: FactsRetrySink
  /** Dialectic-lite seam for `/people --ask`; defaults to a real quick child. */
  peopleAsk?: PeopleAskRunner
  /** Environment handed to command-spawned children; defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Doctor stale-lock liveness probe; defaults to signal-0. */
  isProcessAlive?(pid: number): boolean
}

export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
