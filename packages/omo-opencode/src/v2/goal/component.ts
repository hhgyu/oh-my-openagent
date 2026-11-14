// OpenCode 2 port of Native's model-callable goal trio. The engine's own registerGoalTools builds create_goal,
// update_goal and get_goal; this component only supplies what the engine reads from its session:
// - goalStoreRef: the calling OpenCode session (the tool context's sessionID), never a model-supplied id;
// - the todo gate: update_goal(complete) is refused, with the engine's message, while the last todowrite has open tasks;
// - goal accounting: Senpi's per-session window (opened by create_goal, read by get_goal/update_goal, also closed out
//   on settle), fed by `session.step.ended` tokens (input as input, output plus reasoning as output).
import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import { Error as ToolError, type Info, type Result, type ToolContext } from "@opencode/plugin/promise/tool"
import {
  loadGoalEngine,
  type EngineGoal,
  type EngineGoalTool,
  type EngineToolContext,
  type GoalAccountingMode,
  type GoalEngine,
  type GoalUsage,
} from "./engine"
import { goalStoreRef } from "./store-ref"
import { createTodoState } from "./todo-state"

export type GoalHost = Pick<Plugin.Context, "tool" | "session" | "event" | "location">

export interface GoalOptions {
  readonly engine?: () => Promise<GoalEngine>
  readonly home?: string
}

const GOAL_TOOL_NAMES = ["create_goal", "update_goal", "get_goal"] as const
const emptyUsage = (): GoalUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 })

interface Accounting {
  window?: { readonly goalId: string; measuredFrom: number }
  pending: GoalUsage
}

export async function registerGoal(host: GoalHost, options: GoalOptions = {}): Promise<() => Promise<void>> {
  const directory = host.location.directory
  const engine = await (options.engine ?? loadGoalEngine)()
  const todos = createTodoState()
  const sessions = new Map<string, Accounting>()
  const registrations: Registration[] = []
  const stop = new AbortController()
  const accountingOf = (sessionID: string) => {
    let state = sessions.get(sessionID)
    if (!state) sessions.set(sessionID, (state = { pending: emptyUsage() }))
    return state
  }
  const beginWindow = (goal: EngineGoal) => {
    if (goal.status !== "active" || goal.continuationStoppedAt !== undefined) return
    const state = accountingOf(goal.threadId)
    if (state.window?.goalId === goal.id) return
    state.pending = emptyUsage()
    state.window = { goalId: goal.id, measuredFrom: Date.now() }
  }

  async function accountTurn(ctx: EngineToolContext, mode: GoalAccountingMode): Promise<EngineGoal | null> {
    const state = accountingOf(ctx.ref.threadId)
    const window = state.window
    if (window === undefined) {
      // A reload drops the in-memory window; Native reopens it at session start for an active goal.
      const goal = await engine.store.readGoal(ctx.ref)
      if (goal) beginWindow(goal)
      return goal
    }
    const usage = state.pending
    state.pending = emptyUsage()
    const now = Date.now()
    const elapsedSeconds = Math.max(0, Math.round((now - window.measuredFrom) / 1000))
    const goal = await engine.store.accountGoalUsage(ctx.ref, usage, elapsedSeconds, mode, window.goalId)
    if (goal?.id === window.goalId) state.window = { goalId: window.goalId, measuredFrom: now }
    else delete state.window
    return goal
  }

  const definitions: EngineGoalTool[] = []
  engine.registerGoalTools(
    { registerTool: (tool) => definitions.push(tool) },
    {
      goalStoreRef: (ctx) => ctx.ref,
      beginAgentGoalAccounting: beginWindow,
      refreshGoalUi: () => {},
      accountCurrentAgentTurn: accountTurn,
      markGoalBlockedThisTurn: () => {},
      markGoalCompletedThisTurn: (goal) => {
        accountingOf(goal.threadId).window = { goalId: goal.id, measuredFrom: Date.now() }
      },
    },
  )

  const toInfo = (definition: EngineGoalTool): Info => ({
    name: definition.name,
    description: definition.description,
    input: definition.parameters as Info["input"],
    options: { codemode: false },
    async execute(input: unknown, context: ToolContext): Promise<Result> {
      const ctx: EngineToolContext = {
        ref: goalStoreRef(directory, context.sessionID, options.home),
        sessionManager: { getBranch: () => [] },
      }
      try {
        if (definition.name === "update_goal" && (input as { status?: unknown } | null)?.status === "complete") {
          const open = todos.openTasks(context.sessionID)
          if (open.length > 0) throw Error(engine.openTodoCompletionError(open))
        }
        const result = await definition.execute(String(context.id), input, context.signal, undefined, ctx)
        return {
          content: result.content.flatMap((part) =>
            part.type === "text" ? [{ type: "text", text: part.text ?? "" }] : [],
          ),
          metadata: { goal: JSON.parse(JSON.stringify(result.details ?? null)) },
        } as Result
      } catch (error) {
        throw new ToolError({ message: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  try {
    if (
      definitions
        .map((tool) => tool.name)
        .sort()
        .join() !== [...GOAL_TOOL_NAMES].sort().join()
    )
      throw Error(`the senpi goal extension registered ${definitions.map((tool) => tool.name).join(", ")}`)
    let collided: string | undefined
    registrations.push(
      await host.tool.transform((editor) => {
        // Never shadow another plugin's goal tool: the model would get two tools with one name.
        collided = editor.list().find((entry) => (GOAL_TOOL_NAMES as readonly string[]).includes(entry.name))?.name
        if (collided === undefined) for (const definition of definitions) editor.add(toInfo(definition))
      }),
    )
    if (collided !== undefined) {
      console.warn(`[oh-my-openagent/v2] another \`${collided}\` tool is registered; the Native goal tools stay off`)
    } else {
      registrations.push(
        await host.tool.hook("execute.after", (input) => {
          if (input.status === "completed") todos.observe(input.sessionID, input.tool, input.input)
        }),
      )
      registrations.push(
        await host.session.hook("experimental.idle", async (input) => {
          if (sessions.get(input.sessionID)?.window === undefined) return
          await accountTurn(
            { ref: goalStoreRef(directory, input.sessionID, options.home), sessionManager: { getBranch: () => [] } },
            "active",
          ).catch((error: unknown) => console.warn("[oh-my-openagent/v2] goal accounting skipped", String(error)))
        }),
      )
    }
  } catch (error) {
    for (const registration of registrations.reverse()) await registration.dispose().catch(() => {})
    throw error
  }

  const pump = (async () => {
    for await (const event of host.event.subscribe({
      types: ["session.step.ended", "session.deleted"],
      signal: stop.signal,
    })) {
      const sessionID = event.data.sessionID
      if (event.type === "session.deleted") {
        sessions.delete(sessionID)
        todos.forget(sessionID)
        continue
      }
      const state = sessions.get(sessionID)
      const tokens = (event.data as { tokens?: { input?: number; output?: number; reasoning?: number } }).tokens
      if (!state?.window || !tokens) continue
      state.pending.input += Math.max(0, tokens.input ?? 0)
      state.pending.output += Math.max(0, (tokens.output ?? 0) + (tokens.reasoning ?? 0))
    }
  })().catch((error: unknown) => {
    if (!stop.signal.aborted) console.warn("[oh-my-openagent/v2] goal event stream stopped", String(error))
  })

  return async () => {
    stop.abort()
    await pump
    sessions.clear()
    for (const registration of registrations.reverse()) await registration.dispose()
  }
}
