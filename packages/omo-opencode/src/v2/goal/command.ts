// `/omo:goal` (D-039): Native's `/goal` (show, pause, resume, clear, <objective>) is the senpi engine's own handler from
// `command-registration.js`, registered under the V2 namespace. This file only maps what the handler reads:
// - its store ref and accounting are the invoking OpenCode session's (one handler binding per invocation, because the
//   engine's `clearAgentGoalAccounting()` names no session);
// - `ctx.ui.notify` -> the `rpc.omo-goal.command.output` event the OmO TUI shows like memory command output, with
//   the engine's `/goal` texts rewritten to `/omo:goal`; `hasUI` is false, so replacing a goal asks nothing (Native
//   without a UI does the same);
// - `queueGoalContinuation` -> the continuation loop's `queue` (path `sessionStart`), awaited before the command ends.
import type { CommandDomain } from "@opencode/plugin/promise/command"
import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import { z } from "zod"
import { rewriteCommandMentions, v2CommandName } from "../commands/namespace"
import type { createGoalAccounting } from "./accounting"
import { GOAL_COMMAND_OUTPUT_EVENT, GOAL_COMMAND_RPC_ID } from "./command-output-event"
import type { GoalContinuation } from "./continuation"
import type { EngineCommandContext, EngineGoal, EngineGoalCommand, GoalEngine, GoalStoreRef } from "./engine"

const GOAL_COMMAND = v2CommandName("goal")
type Level = "info" | "warning" | "error"

const goalCommandRpc = {
  id: GOAL_COMMAND_RPC_ID,
  methods: {},
  events: {
    [GOAL_COMMAND_OUTPUT_EVENT]: {
      schema: z.object({
        sessionID: z.string(),
        command: z.string(),
        level: z.enum(["info", "warning", "error"]),
        text: z.string(),
      }),
    },
  },
}

export interface GoalCommandDeps {
  readonly engine: GoalEngine
  readonly accounting: ReturnType<typeof createGoalAccounting>
  readonly continuation: GoalContinuation
  ref(sessionID: string): GoalStoreRef
  publish(sessionID: string, goal: EngineGoal | null): void
  warn(what: string): (error: unknown) => void
}

export async function registerGoalCommand(
  host: { readonly command: Pick<CommandDomain, "transform">; readonly rpc?: Pick<Plugin.Context["rpc"], "register"> },
  deps: GoalCommandDeps,
): Promise<Registration[]> {
  const { engine, accounting, continuation } = deps
  const queued = new Map<string, Promise<unknown>[]>()
  const bind = (sessionID: string): EngineGoalCommand => {
    const bound: [string, EngineGoalCommand][] = []
    engine.registerGoalCommand(
      { registerCommand: (name, command) => void bound.push([name, command]) },
      {
        goalStoreRef: (ctx) => ctx.ref,
        accountCurrentAgentTurn: (ctx, mode) => accounting.account(ctx.ref, mode),
        beginAgentGoalAccounting: accounting.begin,
        stopAgentGoalAccounting: (goalId) => accounting.stop(sessionID, goalId),
        clearAgentGoalAccounting: () => accounting.forget(sessionID),
        queueGoalContinuation: (_pi, _ctx, goal) => queued.get(sessionID)?.push(continuation.queue(sessionID, goal)),
        refreshGoalUi: (_ctx, goal) => deps.publish(sessionID, goal),
      },
    )
    const [only] = bound
    if (bound.length !== 1 || only?.[0] !== "goal")
      throw Error(`the senpi goal extension registered the commands ${bound.map(([name]) => name).join(", ")}`)
    return only[1]
  }
  const { description } = bind("")
  const registrations: Registration[] = []
  const output = host.rpc === undefined ? undefined : await host.rpc.register(goalCommandRpc, {})
  if (output !== undefined) registrations.push(output)
  const show = (sessionID: string, level: Level, message: string) => {
    const text = rewriteCommandMentions(message)
    if (output === undefined) {
      console.warn(`[oh-my-openagent/v2] /${GOAL_COMMAND} (no output channel):`, text)
      return Promise.resolve()
    }
    return output.events
      .emit(GOAL_COMMAND_OUTPUT_EVENT, { sessionID, command: GOAL_COMMAND, level, text })
      .catch(deps.warn(`/${GOAL_COMMAND} output was not displayed`))
  }
  try {
    registrations.push(
      await host.command.transform((editor) => {
        editor.add({
          name: GOAL_COMMAND,
          description,
          async execute(invocation) {
            const { sessionID } = invocation
            const shown: Promise<void>[] = []
            const pending: Promise<unknown>[] = []
            queued.set(sessionID, pending)
            const ctx: EngineCommandContext = {
              ref: deps.ref(sessionID),
              hasUI: false,
              ui: { notify: (message, level = "info") => void shown.push(show(sessionID, level, message)) },
            }
            try {
              await bind(sessionID).handler(invocation.prompt.text, ctx)
            } finally {
              if (queued.get(sessionID) === pending) queued.delete(sessionID)
            }
            await Promise.all(shown)
            await Promise.all(pending.map((queue) => queue.catch(deps.warn("goal continuation skipped"))))
          },
        })
      }),
    )
  } catch (error) {
    for (const registration of registrations.reverse()) await registration.dispose().catch(() => {})
    throw error
  }
  return registrations
}
