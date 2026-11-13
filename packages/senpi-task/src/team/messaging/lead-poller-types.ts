import type { TeamModeConfig } from "@oh-my-opencode/team-core/config"
import type { DeliveryReservation } from "@oh-my-opencode/team-core/team-mailbox"
import type { Message } from "@oh-my-opencode/team-core/types"

import type { PersistedTaskEvent } from "../../store"
import type { LeadDeliveryJournal } from "./delivery-journal"
import type { SessionMarkerIndex } from "./session-marker-index"

export type LeadInjection = Readonly<{ key: string; source: "team-message"; content: string; onFlushed?: () => void }>

export type LeadInjectionSink = {
  enqueue(injection: LeadInjection): void
}

export type LeadPollFilter = Readonly<{ from?: string }>

export type LeadPoller = {
  pollOnce(filter?: LeadPollFilter): Promise<void>
  shutdown(): void
}

export type LeadPollerDeps = {
  readonly teamRunId: string
  readonly config: TeamModeConfig
  readonly coordinator: LeadInjectionSink
  readonly deliveryJournal?: LeadDeliveryJournal
  readonly appendEvent?: (taskId: string, event: PersistedTaskEvent) => void
  readonly eventTaskId: (message: Message) => string | undefined
  readonly leadSessionFile?: () => string | undefined
  /** Host-owned delivery evidence. When present it replaces the lead session-file marker scan, and a
   * flushed injection that is not delivered is released for redelivery: the sink calls `onFlushed`
   * once it is done with an injection, whether or not the host accepted it. Absent: unchanged. */
  readonly isDelivered?: (messageId: string) => boolean | Promise<boolean>
}

export type PendingPhase = "awaiting_flush" | "awaiting_persistence" | "recovery"

export type PendingDelivery = {
  readonly message: Message
  readonly reservation: DeliveryReservation
  phase: PendingPhase
}

export type LeadPollState = {
  readonly pending: Map<string, PendingDelivery>
  readonly isStopped: () => boolean
  readonly markerIndex: SessionMarkerIndex
}

export class InvalidReservedLeadMessageError extends Error {
  readonly path: string
  constructor(path: string) {
    super(`Invalid reserved lead team message: ${path}`)
    this.name = "InvalidReservedLeadMessageError"
    this.path = path
  }
}
