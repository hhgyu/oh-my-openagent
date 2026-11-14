// V2 port of Native computer use (omo-senpi `components/computer-use`): the `computer` tool (and `computer_actions`
// behind `computer.cua_adapter`) with Native's read/exec permission tiers, the eval `computer` global, `/omo:computer`,
// and the computer-use skill. Everything below the registration shell is the shared senpi-desktop packages.
//
// Exposure: Native registers the tool search-exposed (hidden until tool_search activates it). OpenCode 2.2.6 has no
// tool_search; its closest surface is Code Mode, so the tool is `codemode: true` (not in the direct tool list, found
// and called through `execute`), and eval cells reach it as the `computer` global through the owned host-tool bridge.

import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { RpcRegistration } from "@opencode/plugin/promise/rpc"
import type { Info, Result, ToolContext } from "@opencode/plugin/promise/tool"
import { computerPreludeAssets } from "@oh-my-opencode/senpi-desktop-prelude"
import {
  COMPUTER_ACTIONS_TOOL_NAME,
  COMPUTER_PERMISSION,
  COMPUTER_SKILL_NAME,
  COMPUTER_TOOL_NAME,
  computerActionsPermissionParser,
  computerActionsToolDefinition,
  computerPermissionParser,
  computerToolDefinition,
} from "@oh-my-opencode/senpi-desktop-tool/registration"
import { resolve } from "node:path"
import { z } from "zod"
import type { OwnedEvalHostTool } from "../tools/codemode-host-tools"
import type { EvalKernelPreludes } from "../tools/codemode-worker-protocol"
import { rewriteCommandMentions } from "../commands/namespace"
import { adaptEvalResult, toToolError } from "../tools/native-eval-result"
import { EVAL_DENIED_AGENTS } from "../tools/native-eval"
import {
  COMPUTER_COMMAND_DESCRIPTION,
  COMPUTER_COMMAND_NAME,
  type ComputerSkillState,
  runComputerSlashCommand,
} from "./command"
import { COMPUTER_COMMAND_OUTPUT_EVENT, COMPUTER_PERMISSION_EVENT, COMPUTER_RPC_ID } from "./command-output-event"
import type { EngineLocatorOptions } from "./engine"
import { createSessionRuntimes, type SessionRuntimesOptions } from "./session-runtimes"
import { COMPUTER_UNAVAILABLE_MESSAGE, loadComputerAvailability } from "./settings"
import { buildComputerSkill, COMPUTER_SKILL_ID } from "./skill"

type ToolName = typeof COMPUTER_TOOL_NAME | typeof COMPUTER_ACTIONS_TOOL_NAME

export type ComputerHost = Pick<
  Plugin.Context,
  "tool" | "session" | "event" | "location" | "permission" | "command" | "skill" | "rpc"
>

export interface ComputerComponentOptions {
  readonly platform?: string
  readonly home?: string
  readonly engine?: EngineLocatorOptions
  readonly createChild?: SessionRuntimesOptions["createChild"]
  readonly loadRuntime?: SessionRuntimesOptions["loadRuntime"]
  readonly skillRoot?: string
}

export interface ComputerComponent {
  readonly ownedTools: readonly OwnedEvalHostTool[]
  readonly kernelPreludes?: EvalKernelPreludes
  register(): Promise<() => Promise<void>>
}

const computerRpc = {
  id: COMPUTER_RPC_ID,
  methods: {},
  events: {
    [COMPUTER_COMMAND_OUTPUT_EVENT]: {
      schema: z.object({
        sessionID: z.string(),
        command: z.string(),
        level: z.enum(["info", "warning", "error"]),
        text: z.string(),
      }),
    },
    [COMPUTER_PERMISSION_EVENT]: {
      schema: z.object({
        sessionID: z.string(),
        permission: z.enum(["screen_recording", "accessibility"]),
        app: z.string(),
      }),
    },
  },
}

const SAFETY = computerToolDefinition.promptGuidelines.map((line) => `- ${line}`).join("\n")
const jsonParameters = (schema: unknown): unknown => JSON.parse(JSON.stringify(schema))

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function createComputerComponent(host: ComputerHost, options: ComputerComponentOptions = {}): ComputerComponent {
  const directory = host.location.directory
  const availability = loadComputerAvailability(directory, options.platform)
  const registrations: Registration[] = []
  const stop = new AbortController()
  const roots = new Map<string, Promise<boolean>>()
  const permissionLatch = new Set<string>()
  let events: RpcRegistration<typeof computerRpc>["events"] | undefined
  let skillState: ComputerSkillState | undefined
  let closed = false
  let pump: Promise<void> | undefined

  const output = (sessionID: string, level: "info" | "warning" | "error", text: string) =>
    events
      ?.emit(COMPUTER_COMMAND_OUTPUT_EVENT, {
        sessionID,
        command: COMPUTER_COMMAND_NAME,
        level,
        text: rewriteCommandMentions(text),
      })
      .catch((error: unknown) =>
        console.warn(`[oh-my-openagent/v2] /${COMPUTER_COMMAND_NAME} output was not delivered`, error),
      )
  const registerRpc = async () => {
    const registration = await host.rpc.register(computerRpc, {})
    registrations.push(registration)
    events = registration.events
  }

  if ("unavailable" in availability) {
    const text = availability.detail
      ? `${COMPUTER_UNAVAILABLE_MESSAGE[availability.unavailable]} (${availability.detail})`
      : COMPUTER_UNAVAILABLE_MESSAGE[availability.unavailable]
    return {
      ownedTools: [],
      async register() {
        await registerRpc()
        registrations.push(
          await host.command.transform((editor) => {
            editor.add({
              name: COMPUTER_COMMAND_NAME,
              description: COMPUTER_COMMAND_DESCRIPTION,
              execute: async (invocation) => {
                await output(invocation.sessionID, "warning", text)
              },
            })
          }),
        )
        return async () => {
          for (const registration of registrations.reverse()) await registration.dispose()
        }
      },
    }
  }

  const { settings } = availability
  const runtimes = createSessionRuntimes({
    settings,
    directory,
    session: host.session,
    permission: host.permission,
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.engine === undefined ? {} : { engine: options.engine }),
    ...(options.createChild === undefined ? {} : { createChild: options.createChild }),
    ...(options.loadRuntime === undefined ? {} : { loadRuntime: options.loadRuntime }),
    onPermissionRequired: (sessionID, permission) => {
      const key = `${sessionID}:${permission.permission}`
      if (permissionLatch.has(key)) return
      permissionLatch.add(key)
      void events
        ?.emit(COMPUTER_PERMISSION_EVENT, { sessionID, permission: permission.permission, app: permission.app })
        .catch((error: unknown) => console.warn("[oh-my-openagent/v2] computer permission notice failed", error))
    },
  })
  const toolNames: ToolName[] = settings.cuaAdapter
    ? [COMPUTER_TOOL_NAME, COMPUTER_ACTIONS_TOOL_NAME]
    : [COMPUTER_TOOL_NAME]

  function isRoot(sessionID: string): Promise<boolean> {
    let known = roots.get(sessionID)
    if (!known) {
      known = host.session
        .get({ sessionID })
        .then(
          (info) =>
            (info.parentID === undefined || info.parentID === null) &&
            resolve(info.location.directory) === resolve(directory),
        )
      roots.set(sessionID, known)
      known.catch(() => {
        if (roots.get(sessionID) === known) roots.delete(sessionID)
      })
    }
    return known
  }

  // The shared tool's results and errors name the Native `/computer`; the model and the user see `/omo:computer`.
  async function run(name: ToolName, input: unknown, caller: ToolContext, signal: AbortSignal) {
    try {
      const result = await runNative(name, input, caller, signal)
      return {
        ...result,
        content: result.content.map((part) =>
          part.type === "text" && typeof part.text === "string"
            ? { ...part, text: rewriteCommandMentions(part.text) }
            : part,
        ),
      }
    } catch (error) {
      if (error instanceof Error) error.message = rewriteCommandMentions(error.message)
      throw error
    }
  }

  async function runNative(name: ToolName, input: unknown, caller: ToolContext, signal: AbortSignal) {
    if (closed) throw Error("computer use is shutting down")
    if (EVAL_DENIED_AGENTS.has(caller.agent))
      throw Error(`${name} is not available to the ${caller.agent} agent: read-only roles cannot drive the desktop.`)
    if (!(await isRoot(caller.sessionID))) throw Error(`${name} is available only in root sessions of this project.`)
    const record = isRecord(input) ? input : {}
    const parse = name === COMPUTER_TOOL_NAME ? computerPermissionParser : computerActionsPermissionParser
    for (const request of parse(name, record, directory)) {
      await host.permission.assert({
        sessionID: caller.sessionID,
        agent: caller.agent,
        action: request.permission,
        resources: request.patterns,
        save: request.always,
        source: { type: "tool", messageID: caller.messageID, id: caller.id },
      })
    }
    const runtime = await runtimes.runtime(caller.sessionID)
    const context = await runtimes.context(caller.sessionID, caller)
    return name === COMPUTER_TOOL_NAME
      ? runtime.tools.computer.execute(String(caller.id), record, signal, undefined, context)
      : runtime.tools.computer_actions.execute(String(caller.id), record, signal, undefined, context)
  }

  const definitions = {
    [COMPUTER_TOOL_NAME]: computerToolDefinition,
    [COMPUTER_ACTIONS_TOOL_NAME]: computerActionsToolDefinition,
  }
  const toolInfo = (name: ToolName): Info => ({
    name,
    description: `${definitions[name].description}\n\nSafety:\n${SAFETY}`,
    input: jsonParameters(definitions[name].parameters) as Info["input"],
    options: { codemode: true, permission: COMPUTER_PERMISSION },
    async execute(input, context): Promise<Result> {
      try {
        return adaptEvalResult(await run(name, input, context, context.signal), "computer")
      } catch (error) {
        throw toToolError(error)
      }
    },
  })

  const ownedTools: OwnedEvalHostTool[] = toolNames.map((name) => ({
    name,
    description: definitions[name].description,
    parameters: jsonParameters(definitions[name].parameters),
    async execute(params, call) {
      const caller = call.caller
      if (!caller || caller.sessionID !== call.sessionID)
        throw Error(
          `tools.${name} can run only inside a running eval cell; a detached or finished cell cannot drive the desktop`,
        )
      const signal = call.signal ? AbortSignal.any([caller.signal, call.signal]) : caller.signal
      const result = await run(name, params, caller, signal)
      return { content: result.content, details: result.details }
    },
  }))

  const contribution = {
    javascript: computerPreludeAssets.javascript,
    python: computerPreludeAssets.python,
    documentation: rewriteCommandMentions(computerPreludeAssets.documentation),
    exports: [...computerPreludeAssets.exports],
  }
  const preludeActive = (sessionID: string) => !closed && runtimes.enabled(sessionID)

  async function cleanup(): Promise<void> {
    if (closed) return
    closed = true
    stop.abort(Error("computer use component disposed"))
    const results = await Promise.allSettled([
      ...registrations.reverse().map((registration) => registration.dispose()),
      runtimes.closeAll(),
    ])
    if (pump) await pump
    roots.clear()
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, "computer use cleanup incomplete")
  }

  return {
    ownedTools,
    kernelPreludes: {
      catalog: [{ name: COMPUTER_TOOL_NAME, contribution }],
      active: (sessionID) => (preludeActive(sessionID) ? [COMPUTER_TOOL_NAME] : []),
    },
    async register() {
      try {
        await registerRpc()
        let collided = false
        registrations.push(
          await host.tool.transform((editor) => {
            const infos = toolNames.map(toolInfo)
            collided = editor.list().some((entry) => toolNames.some((name) => entry.name === name))
            if (!collided) for (const info of infos) editor.add(info)
          }),
        )
        if (collided)
          console.warn("[oh-my-openagent/v2] another `computer` tool is registered; the Native computer tool stays off")
        registrations.push(
          await host.command.transform((editor) => {
            editor.add({
              name: COMPUTER_COMMAND_NAME,
              description: COMPUTER_COMMAND_DESCRIPTION,
              execute: async (invocation) => {
                const result = await runComputerSlashCommand(
                  {
                    settings,
                    runtimes,
                    preludeActive,
                    skill: () => skillState,
                    ...(options.engine && { engine: options.engine }),
                  },
                  invocation.sessionID,
                  invocation.prompt.text,
                )
                await output(invocation.sessionID, result.level, result.text)
              },
            })
          }),
        )
        if (!availability.disabledSkills.includes(COMPUTER_SKILL_NAME)) {
          registrations.push(
            await host.skill.transform((editor) => {
              const owner = editor.list().find((entry) => entry.name === COMPUTER_SKILL_NAME && entry.id !== undefined)
              if (owner !== undefined && owner.id !== COMPUTER_SKILL_ID) {
                skillState = { kind: "yielded", path: owner.path }
                return
              }
              if (owner === undefined)
                editor.add(buildComputerSkill(options.skillRoot) as Parameters<typeof editor.add>[0])
              skillState = { kind: "contributed" }
            }),
          )
        }
        registrations.push(
          await host.session.hook("experimental.idle", async (value) => {
            // Native revokes the foreground-control grant when an agent run ends (#9651 B5b).
            await runtimes
              .loaded(value.sessionID)
              ?.service.revokeControl()
              .catch((error: unknown) => {
                console.warn("[oh-my-openagent/v2] computer control revoke failed", error)
              })
          }),
        )
        pump = (async () => {
          try {
            for await (const event of host.event.subscribe({ types: ["session.deleted"], signal: stop.signal })) {
              if (closed) break
              roots.delete(event.data.sessionID)
              await runtimes
                .close(event.data.sessionID)
                .catch((error) => console.warn("[oh-my-openagent/v2] computer session cleanup failed", error))
            }
          } catch (error) {
            if (!stop.signal.aborted) console.warn("[oh-my-openagent/v2] computer session event stream failed", error)
          }
        })()
      } catch (error) {
        try {
          await cleanup()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "computer use registration and rollback failed")
        }
        throw error
      }
      return cleanup
    },
  }
}
