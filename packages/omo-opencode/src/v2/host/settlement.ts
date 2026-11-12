import type { SessionDomain, SessionIdle } from "@opencode/plugin/promise/session"
import type { SessionLease, SessionScopes } from "./session-state"

export interface SettlementTurn {
  readonly executionID: string
  readonly turn: number
  readonly kind: "primary" | "control"
}
export interface SettlementFact {
  readonly sessionID: SessionLease["sessionID"]
  readonly generation: number
  readonly executionID: string
  readonly turn: number
  readonly eligible: boolean
  readonly reason: "successful-model-idle" | "owned-background"
  readonly ownedBackground: number
  readonly descendantBackground: number
}
type Outcome = "running" | "settling" | "settled" | "failed" | "interrupted" | "retrying" | "control" | "uncertain"
interface Frame {
  readonly turn: SettlementTurn
  readonly controller: AbortController
  outcome: Outcome
}
export interface SettlementOptions {
  readonly lease: SessionLease
  readonly scopes: SessionScopes
  /** Required trusted ingress verifier; model text is never a resume authority. */
  readonly trust: { authorizeResume(token: unknown, lease: SessionLease): Promise<boolean> }
  /** One future durable arbiter owns admission; this coordinator only publishes facts. */
  readonly publish: (
    fact: SettlementFact,
    lifetime: { readonly signal: AbortSignal; assertActive(): void },
  ) => Promise<void>
}

export function createSettlementCoordinator(options: SettlementOptions) {
  const { lease, scopes } = options
  const turns = new Map<string, number>()
  const registrations: Array<{ dispose(): Promise<void> }> = []
  const publications = new Set<Promise<void>>()
  let frame: Frame | undefined
  let paused = false
  let pauseEpoch = 0
  let disposed = false
  let installation: Promise<void> | undefined
  let disposal: Promise<void> | undefined
  function pause() {
    pauseEpoch++
    paused = true
    if (frame) {
      frame.outcome = "interrupted"
      frame.controller.abort(new Error("Settlement paused"))
    }
  }
  lease.signal.addEventListener("abort", pause)
  function assertActive(candidate: SessionLease) {
    if (candidate !== lease || disposed || paused) throw new Error("Settlement owner is paused, foreign or disposed")
    scopes.assert(lease)
  }
  function finish(outcome: Exclude<Outcome, "running" | "settling" | "settled" | "uncertain">) {
    if (frame) {
      frame.outcome = outcome
      frame.controller.abort(new Error(`Settlement ${outcome}`))
    }
  }
  async function idle(input: SessionIdle): Promise<void> {
    if (input.sessionID !== lease.sessionID || disposed || paused || lease.signal.aborted) return
    scopes.assert(lease)
    const current = frame
    if (!current || current.outcome !== "running" || current.turn.kind !== "primary") return
    const ownedBackground = input.background.filter((job) => job.sessionID === lease.sessionID).length
    const fact: SettlementFact = Object.freeze({
      sessionID: lease.sessionID,
      generation: lease.generation,
      executionID: current.turn.executionID,
      turn: current.turn.turn,
      eligible: ownedBackground === 0,
      reason: ownedBackground ? "owned-background" : "successful-model-idle",
      ownedBackground,
      descendantBackground: input.background.length - ownedBackground,
    })
    // Claim before the first await. A second callback or uncertain receipt cannot
    // cause two admissions for this edge. Descendant completion is informational.
    if (fact.eligible) current.outcome = "settling"
    const publication = Promise.resolve().then(async () => {
      if (frame !== current || current.controller.signal.aborted) return
      const assertCurrent = () => {
        assertActive(lease)
        if (frame !== current || current.controller.signal.aborted) throw new Error("Settlement edge retired")
      }
      assertCurrent()
      await options.publish(fact, { signal: current.controller.signal, assertActive: assertCurrent })
    })
    publications.add(publication)
    try {
      await publication
      if (frame === current && current.outcome === "settling") current.outcome = "settled"
    } catch (error) {
      if (frame === current && fact.eligible) current.outcome = "uncertain"
      throw error
    } finally {
      publications.delete(publication)
    }
  }
  const coordinator = {
    assertActive,
    begin(turn: SettlementTurn) {
      assertActive(lease)
      if (!turn.executionID || !Number.isSafeInteger(turn.turn) || turn.turn < 1)
        throw new Error("Explicit execution and positive turn identity required")
      if ((turns.get(turn.executionID) ?? 0) >= turn.turn) throw new Error("Repeated or stale settlement edge")
      if (!turns.has(turn.executionID) && turns.size >= 1024)
        throw new Error("Settlement generation must retire before accepting more executions")
      turns.set(turn.executionID, turn.turn)
      frame?.controller.abort(new Error("Settlement edge replaced"))
      frame = {
        turn: Object.freeze({ ...turn }),
        controller: new AbortController(),
        outcome: turn.kind === "control" ? "control" : "running",
      }
    },
    end(input: { executionID: string; turn: number; outcome: "failed" | "interrupted" | "retrying" | "control" }) {
      if (frame?.turn.executionID === input.executionID && frame.turn.turn === input.turn) finish(input.outcome)
    },
    pause,
    async resume(token: unknown) {
      if (disposed) throw new Error("Settlement coordinator disposed")
      scopes.assert(lease)
      const requestedAt = pauseEpoch
      if (!(await options.trust.authorizeResume(token, lease)))
        throw new Error("Resume requires verified real user input")
      scopes.assert(lease)
      if (disposed) throw new Error("Settlement coordinator disposed")
      if (requestedAt !== pauseEpoch) throw new Error("A newer Stop superseded resume verification")
      paused = false
      // The old turn remains interrupted. Trusted input must start a new turn.
    },
    idle,
    install(host: Pick<SessionDomain, "hook">): Promise<void> {
      if (disposed) return Promise.reject(new Error("Settlement coordinator disposed"))
      if (installation) return installation
      installation = (async () => {
        try {
          for (const registration of [
            () => host.hook("experimental.idle", idle),
            () =>
              host.hook("retry", (input) => {
                if (input.sessionID === lease.sessionID) finish("retrying")
              }),
            () =>
              host.hook("compaction", (input) => {
                if (input.sessionID === lease.sessionID) finish("control")
              }),
          ]) {
            const handle = await registration()
            if (disposed) {
              await handle.dispose()
              throw new Error("Settlement installation retired")
            }
            registrations.push(handle)
          }
        } catch (error) {
          const cleanup = await Promise.allSettled(
            registrations
              .splice(0)
              .reverse()
              .map((registration) => registration.dispose()),
          )
          const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected")
          if (failures.length)
            throw new AggregateError(
              [error, ...failures.map((result) => result.reason)],
              "Settlement hook installation and rollback failed",
            )
          throw error
        }
      })()
      return installation
    },
    dispose(): Promise<void> {
      if (disposal) return disposal
      disposed = true
      pause()
      lease.signal.removeEventListener("abort", pause)
      disposal = (async () => {
        await installation?.catch(() => {})
        await Promise.allSettled([...publications])
        const cleanup = await Promise.allSettled(
          registrations
            .splice(0)
            .reverse()
            .map((registration) => registration.dispose()),
        )
        const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected")
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Settlement hook disposal incomplete",
          )
      })()
      return disposal
    },
  }
  return coordinator
}
