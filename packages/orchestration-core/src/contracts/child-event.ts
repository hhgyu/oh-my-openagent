// Normalized OmO child-event data; no host session/history identity is implied.
// The child-event seam the manager subscribes to for transcript logging. `type` is the discriminator;
// the transcript-bearing fields are OPTIONAL so both runners' concrete events (in-process
// ChildSessionEvent and rpc AgentSessionEvent) remain assignable to this widened shape.
export type ManagedChildEvent = {
  readonly type: string
  readonly message?: unknown
  readonly toolCallId?: string
  readonly toolName?: string
  readonly args?: unknown
  readonly input?: unknown
  readonly result?: unknown
  readonly isError?: boolean
  readonly to?: string
}

export type ManagedChildListener = (event: ManagedChildEvent) => void

