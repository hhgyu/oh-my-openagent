// `/reflect [--recent N | --conversation <ids>] [focus text]` (plan S7g), porting omo-senpi
// `commands/reflect.ts` and its `reflectionSink` from `wiring-static.ts`: a manual request is evaluated
// through the reservation store (memory-core `evaluate({kind: "manual"})`, which captures this session's
// snapshot). The run that wins the active slot launches right away in the background; when a run is
// already active the request fills the single pending slot and runs next. Manual requests bypass the
// park gate, so a parked answer is an invariant failure, as in Senpi. Not ported: Senpi's stale-holder
// recovery after a pending answer (#10377); V2 recovers a dead holder at the next bind instead.

import type { ReflectionEvent, ReservationResult } from "@oh-my-opencode/memory-core"
import { parseCommandArgs } from "@oh-my-opencode/memory-core/commands/args"
import type { NotifyLevel } from "@oh-my-opencode/memory-core/commands"
import type { BoundMemorySession } from "./binding"
import { reflectionSettings } from "./reflection-run-store"

/** Registered name of the reflection command, kept apart from the core `MEMORY_COMMAND_NAMES` record. */
const REFLECT_COMMAND_NAMES: Readonly<Record<"reflect", string>> = { reflect: "reflect" }

/** A memory command outside the memory-core suite; its result is posted like every memory command output. */
export interface ExtraMemoryCommand {
  readonly name: string
  readonly description: string
  run(
    bound: BoundMemorySession | undefined,
    args: string,
  ): Promise<{ readonly text: string; readonly level: NotifyLevel }>
}

type ReflectEvaluate = (bound: BoundMemorySession, event: ReflectionEvent) => Promise<ReservationResult | null>

const UNBOUND = "memory is not bound to this session; start a session with memory enabled and retry"

function parseConversationIds(value: string | true | undefined): string[] | undefined {
  if (value === undefined || value === true) return undefined
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  return ids.length > 0 ? ids : undefined
}

export function createReflectCommand(evaluate: ReflectEvaluate): ExtraMemoryCommand {
  return {
    name: REFLECT_COMMAND_NAMES.reflect,
    description: "Request a memory reflection run now, optionally scoped and focused.",
    async run(bound, args) {
      if (bound === undefined) return { text: UNBOUND, level: "error" }
      if (!reflectionSettings(bound).enabled) {
        return {
          text: "reflection is disabled; set reflection.enabled to true in your omo config to enable it",
          level: "error",
        }
      }
      const parsed = parseCommandArgs(args)
      const recentRaw = parsed.flags.get("recent")
      let recentN: number | undefined
      if (recentRaw !== undefined) {
        const value = recentRaw === true ? Number.NaN : Number.parseInt(recentRaw, 10)
        if (!Number.isInteger(value) || value <= 0) {
          return { text: "--recent expects a positive integer, for example /reflect --recent 5", level: "error" }
        }
        recentN = value
      }
      const conversationIds = parseConversationIds(parsed.flags.get("conversation"))
      const focus = parsed.positionals.join(" ").trim()
      const result = await evaluate(bound, {
        kind: "manual",
        ...(focus.length > 0 ? { focus } : {}),
        ...(recentN === undefined ? {} : { recentN }),
        ...(conversationIds === undefined ? {} : { conversationIds }),
      })
      if (result === null) throw new Error("reflection reservation rejected")
      if (result.status === "parked") throw new Error("manual reflection must bypass the park gate")
      const scope = [
        recentN === undefined ? undefined : `recent ${recentN}`,
        conversationIds === undefined ? undefined : `conversations ${conversationIds.join(", ")}`,
        focus.length > 0 ? `focus "${focus}"` : undefined,
      ].filter((part): part is string => part !== undefined)
      const suffix = scope.length > 0 ? ` (${scope.join("; ")})` : ""
      if (result.status === "active")
        return {
          text: `reflection run ${result.run.runId} reserved${suffix}; it runs in the background`,
          level: "info",
        }
      return {
        text: `reflection request queued as ${result.run.runId}${suffix}; a run is already active and this request runs next`,
        level: "info",
      }
    },
  }
}
