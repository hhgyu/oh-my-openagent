// OpenCode 2 port of Native's goal extension on the engine's own code. registerGoalTools builds create_goal,
// update_goal and get_goal; this component only supplies what the engine reads from its session:
// - goalStoreRef: the calling OpenCode session (the tool context's sessionID), never a model-supplied id;
// - the todo gate: update_goal(complete) is refused, with the engine's message, while the last todowrite has open tasks;
// - goal accounting (accounting.ts) and the continuation loop (continuation.ts), first in the shared idle chain;
// - Native's goal status line -> the footer RPC, with the engine's goal status text;
// - Native's `/goal` -> `/omo:goal` (command.ts); the engine's texts naming `/goal` are rewritten to `/omo:goal`.
import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import { Error as ToolError, type Info, type Result, type ToolContext } from "@opencode/plugin/promise/tool"
import { createHash, randomUUID } from "node:crypto"
import { GOAL_CONTINUATION_METADATA_KEY, isOwnContinuation } from "../hooks/continuation-metadata"
import {
  attachIdleContinuation,
  IDLE_CONTINUATION_RANK,
  type IdleContinuationChain,
} from "../hooks/idle-continuation-chain"
import { rewriteCommandMentions } from "../commands/namespace"
import type { UlwLoopStatusRpc } from "../ulw-loop/status-rpc"
import { createGoalAccounting } from "./accounting"
import { registerGoalCommand } from "./command"
import { createGoalContinuation, type GoalTimers } from "./continuation"
import { pumpGoalEvents } from "./events"
import { loadGoalEngine, type EngineGoal, type EngineGoalTool, type EngineToolContext, type GoalEngine } from "./engine"
import { createRunRecords } from "./run-record"
import { goalStoreRef } from "./store-ref"
import { createTodoState } from "./todo-state"

export type { GoalTimers } from "./continuation"
export type GoalHost = Pick<Plugin.Context, "tool" | "session" | "event" | "location"> &
  Partial<Pick<Plugin.Context, "command" | "rpc">>

export interface GoalOptions {
  readonly engine?: () => Promise<GoalEngine>
  readonly home?: string
  readonly timers?: GoalTimers
  readonly idle?: IdleContinuationChain
  readonly footer?: UlwLoopStatusRpc
}

const GOAL_TOOL_NAMES = ["create_goal", "update_goal", "get_goal"] as const
const realTimers: GoalTimers = {
  set: (callback, ms) => setTimeout(() => void callback().catch(warn("goal continuation skipped")), ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}
const warn = (what: string) => (error: unknown) => console.warn(`[oh-my-openagent/v2] ${what}`, String(error))

export async function registerGoal(host: GoalHost, options: GoalOptions = {}): Promise<() => Promise<void>> {
  const directory = host.location.directory
  const engine = await (options.engine ?? loadGoalEngine)()
  const todos = createTodoState()
  const runs = createRunRecords()
  const accounting = createGoalAccounting(engine.store)
  const registrations: Registration[] = []
  const stop = new AbortController()
  const ref = (sessionID: string) => goalStoreRef(directory, sessionID, options.home)
  const context = (sessionID: string): EngineToolContext => ({
    ref: ref(sessionID),
    sessionManager: { getBranch: () => [] },
  })
  const statusText = (goal: EngineGoal | null) =>
    goal === null ? undefined : rewriteCommandMentions(engine.ui.goalStatusText(goal))
  const publish = (sessionID: string, goal: EngineGoal | null) =>
    options.footer?.publishGoal(sessionID, statusText(goal))
  options.footer?.readGoalsFrom(async (sessionID) => statusText(await engine.store.readGoal(ref(sessionID))))

  const continuation = createGoalContinuation({
    engine,
    timers: options.timers ?? realTimers,
    ref,
    todoCounts: (sessionID) => todos.counts(sessionID),
    account: (sessionID) => accounting.account(ref(sessionID), "active"),
    changed: (sessionID, goal) => {
      if (goal) accounting.begin(goal)
      publish(sessionID, goal)
    },
    modelId: async (sessionID) => {
      const info = await host.session.get({ sessionID }).catch(() => undefined)
      return info?.model ? `${info.model.providerID}/${info.model.id}` : undefined
    },
    deliver: async (sessionID, text, count, signature, queued) => {
      // A status change resets the count, so a resumed goal can repeat an earlier count and signature.
      const nonce = queued ? `\0${randomUUID()}` : ""
      const digest = createHash("sha256").update(`${sessionID}\0${count}\0${signature}${nonce}`).digest("hex")
      await host.session.synthetic({
        sessionID,
        id: `msg_omo_goal_${digest.slice(0, 24)}`,
        text,
        delivery: "steer",
        resume: true,
        metadata: { [GOAL_CONTINUATION_METADATA_KEY]: String(count) },
      })
    },
  })

  const definitions: EngineGoalTool[] = []
  engine.registerGoalTools(
    { registerTool: (tool) => definitions.push(tool) },
    {
      goalStoreRef: (ctx) => ctx.ref,
      beginAgentGoalAccounting: accounting.begin,
      refreshGoalUi: (ctx, goal) => publish(ctx.ref.threadId, goal),
      accountCurrentAgentTurn: (ctx, mode) => accounting.account(ctx.ref, mode),
      markGoalBlockedThisTurn: () => {},
      markGoalCompletedThisTurn: accounting.completed,
    },
  )

  const toInfo = (definition: EngineGoalTool): Info => ({
    name: definition.name,
    description: definition.description,
    input: definition.parameters as Info["input"],
    options: { codemode: false },
    async execute(input: unknown, toolContext: ToolContext): Promise<Result> {
      const ctx = context(toolContext.sessionID)
      try {
        if (definition.name === "update_goal" && (input as { status?: unknown } | null)?.status === "complete") {
          const open = todos.openTasks(toolContext.sessionID)
          if (open.length > 0) throw Error(engine.openTodoCompletionError(open))
        }
        const result = await definition.execute(String(toolContext.id), input, toolContext.signal, undefined, ctx)
        publish(toolContext.sessionID, await engine.store.readGoal(ctx.ref))
        return {
          content: result.content.flatMap((part) =>
            part.type === "text" ? [{ type: "text", text: rewriteCommandMentions(part.text ?? "") }] : [],
          ),
          metadata: { goal: JSON.parse(JSON.stringify(result.details ?? null)) },
        } as Result
      } catch (error) {
        throw new ToolError({ message: error instanceof Error ? error.message : String(error) })
      }
    },
  })

  try {
    const names = definitions.map((tool) => tool.name).sort()
    if (names.join() !== [...GOAL_TOOL_NAMES].sort().join())
      throw Error(`the senpi goal extension registered ${names.join(", ")}`)
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
          runs.tool(input.sessionID, {
            messageID: input.messageID,
            tool: input.tool,
            input: input.input,
            ...(input.status === "completed" ? { output: input.result.content } : { error: input.error.message }),
          })
        }),
      )
      registrations.push(
        await attachIdleContinuation(host.session, options.idle, IDLE_CONTINUATION_RANK.goal, async (input) => {
          const run = runs.take(input.sessionID)
          const goal = await accounting.account(ref(input.sessionID), "active")
          publish(input.sessionID, goal)
          return continuation.afterIdle(input.sessionID, goal, run, input.background)
        }),
      )
      registrations.push(
        await host.session.hook("prompt", async (input) => {
          if (!isOwnContinuation(input.metadata)) await continuation.userPrompt(input.sessionID)
        }),
      )
      if (host.command !== undefined)
        registrations.push(
          ...(await registerGoalCommand(
            { command: host.command, ...(host.rpc && { rpc: host.rpc }) },
            { engine, accounting, continuation, ref, publish, warn },
          )),
        )
    }
  } catch (error) {
    for (const registration of registrations.reverse()) await registration.dispose().catch(() => {})
    throw error
  }

  const pump = pumpGoalEvents(host.event, stop.signal, {
    stepStarted: (sessionID) => continuation.stepStarted(sessionID),
    stepEnded: (sessionID, messageID, finish, tokens) => {
      runs.stepEnded(sessionID, messageID, finish)
      accounting.tokens(sessionID, tokens)
    },
    text: (sessionID, messageID, text) => runs.text(sessionID, messageID, text),
    executionStarted: (sessionID) => continuation.executionStarted(sessionID),
    executionEnded: (sessionID) => continuation.executionEnded(sessionID),
    interrupted: (sessionID, reason) =>
      continuation.interrupted(sessionID, reason).catch(warn("goal interrupt skipped")),
    deleted: (sessionID) => {
      accounting.forget(sessionID)
      todos.forget(sessionID)
      runs.forget(sessionID)
      continuation.forget(sessionID)
    },
  }).catch((error: unknown) => {
    if (!stop.signal.aborted) warn("goal event stream stopped")(error)
  })

  return async () => {
    stop.abort()
    await pump
    continuation.dispose()
    accounting.clear()
    for (const registration of registrations.reverse()) await registration.dispose()
  }
}
