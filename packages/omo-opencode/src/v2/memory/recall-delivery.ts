import { renderNudgeBlock, type RecallNudge } from "@oh-my-opencode/memory-core"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { describeError, type MemoryBinder } from "./binding"
import { resolveRecallSettings, type MemoryLogger } from "./config"
import { RECALL_SURFACE_HASH, type MemoryRecallCollector, type RecallStores } from "./recall"

/** System-part metadata marker: at most one recall part per model request. */
export const RECALL_PART_MARKER = "omo.kibitzer.recall"

export interface MemoryRecallDeliveryDeps {
  readonly binder: MemoryBinder
  readonly stores: RecallStores
  readonly collector: Pick<MemoryRecallCollector, "settled">
  readonly logger: MemoryLogger
}

export interface MemoryRecallDelivery {
  onContext(context: Pick<SessionContext, "sessionID" | "system">): Promise<void>
}

/**
 * Drains the session's pending nudges into one tagged system part of the current model request, then
 * records the delivered paths in the session ledger so they never repeat. The part is composed before
 * any bookkeeping: a ledger failure leaves the path eligible again, it never suppresses the nudge.
 */
export function createRecallDelivery(deps: MemoryRecallDeliveryDeps): MemoryRecallDelivery {
  return {
    async onContext(context) {
      if (carriesRecall(context.system)) return
      const bound = await deps.binder.resolve(context.sessionID)
      if (bound === undefined || !resolveRecallSettings(bound.settings, bound.identity).enabled) return
      // A prompt's own collection lands in the same turn's first request.
      await deps.collector.settled(context.sessionID)
      let nudges: RecallNudge[]
      try {
        nudges = dedupeByPath(await deps.stores.pending(bound).take(context.sessionID))
      } catch (error) {
        deps.logger.warn("memory recall pending take skipped", { sessionID: context.sessionID, error: describeError(error) })
        return
      }
      if (nudges.length === 0 || carriesRecall(context.system)) return
      context.system.push({
        type: "text",
        text: nudges.map(renderNudgeBlock).join("\n"),
        metadata: { [RECALL_PART_MARKER]: true, paths: nudges.map(nudge => nudge.path) },
      })
      try {
        await deps.stores.ledger(bound).markSurfaced(context.sessionID, nudges.map(nudge => ({ path: nudge.path, hash: RECALL_SURFACE_HASH })))
      } catch (error) {
        deps.logger.warn("memory recall ledger mark skipped", { sessionID: context.sessionID, error: describeError(error) })
      }
    },
  }
}

function carriesRecall(system: SessionContext["system"]): boolean {
  return system.some(part => part.metadata?.[RECALL_PART_MARKER] === true)
}

function dedupeByPath(nudges: readonly RecallNudge[]): RecallNudge[] {
  const seen = new Set<string>()
  return nudges.filter(nudge => !seen.has(nudge.path) && seen.add(nudge.path) !== undefined)
}
