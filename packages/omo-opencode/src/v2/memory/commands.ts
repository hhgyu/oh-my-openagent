import { redactSecretLikeMaterial } from "@oh-my-opencode/memory-core"
import {
  CORE_MEMORY_COMMANDS, journalTranscriptSource, runCoreMemoryCommand,
  type CoreMemoryCommandName, type MemoryCommandContext, type MemoryCommandDeps, type MemoryCommandIdentity, type NotifyLevel,
} from "@oh-my-opencode/memory-core/commands"
import type { CommandDefinition, CommandInvocation } from "@opencode/plugin/promise/command"
import type * as Plugin from "@opencode/plugin/promise/plugin"
import { randomUUID } from "node:crypto"
import { describeError, type MemoryBinder } from "./binding"
import type { MemoryCommandOutputEvent } from "./command-output-event"
import { MEMORY_COMMAND_OUTPUT_ID_PREFIX } from "./command-output"
import type { MemoryLogger } from "./config"
import type { ExtraMemoryCommand } from "./reflect-command"

/** Synthetic-message metadata key naming the memory command whose output the message carries. */
export const MEMORY_COMMAND_OUTPUT_KEY = "omo.memory.command"

/**
 * Registered names. OpenCode 2.2.6 ships its own `init` command (guided AGENTS.md setup) through the
 * same `command.transform` surface, so the memory initializer registers as `memory-init` instead.
 */
export const MEMORY_COMMAND_NAMES: Readonly<Record<CoreMemoryCommandName, string>> = {
  memory: "memory",
  memfs: "memfs",
  remember: "remember",
  init: "memory-init",
  recompile: "recompile",
  "memory-repository": "memory-repository",
  search: "search",
  facts: "facts",
  agreements: "agreements",
}

type SyntheticPort = Pick<Plugin.Context["session"], "synthetic">

export interface MemoryCommandsDeps {
  readonly binder: MemoryBinder
  readonly session: SyntheticPort
  readonly logger: MemoryLogger
  /** `/recompile`: the next model request of this session repins the memory block at HEAD. */
  readonly bustPromptCache: (sessionID: string) => void
  readonly isClosed: () => boolean
  /** Shows the output right away (the `omo-memory` RPC event the OmO TUI plugin renders). */
  readonly display?: (output: MemoryCommandOutputEvent) => Promise<void>
  /** `/facts retry`: one launch attempt of the facts extractor for this session's identity. */
  readonly factsRetry?: (sessionID: string) => Promise<void>
  /** Commands outside the memory-core suite (`/reflect`); their output takes the same display + record route. */
  readonly extraCommands?: readonly ExtraMemoryCommand[]
  /** Session message IDs of output records; defaults to `msg_omo_memory_output_<uuid>`. */
  readonly newOutputID?: () => string
}

export interface MemoryCommands {
  readonly definitions: readonly CommandDefinition[]
  /** Resolves once every command output started so far has been posted (or dropped). */
  settled(): Promise<void>
}

interface Output {
  readonly sessionID: string
  readonly command: string
  readonly text: string
  readonly level: NotifyLevel
}

/**
 * OpenCode 2 surface for the host-neutral memory-core slash commands (Senpi `commands/register.ts`).
 * Senpi shows read-only output through `ctx.ui.notify`, outside model context. OpenCode 2.2.6 has no
 * such server-side surface: a command's `execute` returns void, and every session message kind a plugin
 * can create (`session.synthetic`) is sent to the model as a user message. So each output goes two ways:
 * - shown now: `display` emits the ephemeral `rpc.omo-memory.command.output` event, which the OmO TUI
 *   plugin renders as a dialog (or an error toast); nothing is written to the session;
 * - recorded: a `session.synthetic` with `resume: false` (no model turn; the host queues it and delivers
 *   it with the next turn) under a `msg_omo_memory_output_` ID, which the memory component's `context`
 *   and `compaction` hooks strip from every model request, so the dump never reaches the model.
 * `/remember` and `/memory-init` start their model turn with `resume: true`; that message is meant for
 * the model and keeps a host-assigned ID. Posts for one session are serialized; a failed display or
 * post is logged and never thrown into the host.
 */
export function createMemoryCommands(deps: MemoryCommandsDeps): MemoryCommands {
  const chains = new Map<string, Promise<void>>()

  function post(sessionID: string, run: () => Promise<unknown>): Promise<void> {
    const previous = chains.get(sessionID) ?? Promise.resolve()
    const next = previous.then(run).then(() => undefined, (error: unknown) => {
      deps.logger.warn("memory command output was not posted", { sessionID, error: describeError(error) })
    })
    chains.set(sessionID, next)
    void next.finally(() => { if (chains.get(sessionID) === next) chains.delete(sessionID) })
    return next
  }

  const newOutputID = deps.newOutputID ?? (() => `${MEMORY_COMMAND_OUTPUT_ID_PREFIX}${randomUUID().replaceAll("-", "")}`)

  async function display(output: Output, text: string): Promise<void> {
    if (deps.display === undefined) return
    try {
      await deps.display({ sessionID: output.sessionID, command: output.command, level: output.level, text })
    } catch (error) {
      deps.logger.warn("memory command output was not displayed", { sessionID: output.sessionID, error: describeError(error) })
    }
  }

  async function postOutput(output: Output): Promise<void> {
    if (deps.isClosed()) return
    const text = output.level === "error" ? `/${output.command} failed: ${output.text}` : output.text
    await display(output, text)
    // The ID is chosen before the call so the record is strippable from the first request that could see it.
    const id = newOutputID()
    await post(output.sessionID, () => deps.session.synthetic({
      sessionID: output.sessionID,
      id,
      text,
      description: `/${output.command}`,
      metadata: { [MEMORY_COMMAND_OUTPUT_KEY]: output.command, level: output.level },
      resume: false,
    }))
  }

  const retry = deps.factsRetry

  async function execute(name: CoreMemoryCommandName, invocation: CommandInvocation): Promise<void> {
    if (deps.isClosed()) return
    const command = MEMORY_COMMAND_NAMES[name]
    const { sessionID } = invocation
    let output: Output
    let turnSent = false
    try {
      const bound = await deps.binder.resolve(sessionID)
      const identity: MemoryCommandIdentity | undefined = bound === undefined ? undefined : { identity: bound.identity, identityPaths: bound.paths }
      let level: NotifyLevel = "info"
      const ctx: MemoryCommandContext = {
        mode: "opencode",
        hasUI: false,
        ...(bound === undefined ? {} : { cwd: bound.directory }),
        sessionManager: { getSessionId: () => sessionID },
        ui: { notify: (_message, notified = "info") => { level = notified } },
      }
      const commandDeps: MemoryCommandDeps = {
        contextForSession: id => (id === sessionID ? identity : undefined),
        resolveIdentity: () => identity,
        bustPromptCache: () => { deps.bustPromptCache(sessionID) },
        transcriptSource: () => journalTranscriptSource(identity),
        commandNames: MEMORY_COMMAND_NAMES,
        ...(retry === undefined ? {} : { factsSink: { reconcile: () => retry(sessionID) } }),
        sendUserMessage: async text => {
          if (deps.isClosed()) throw new Error("memory component is closed")
          await deps.session.synthetic({
            sessionID, text, description: `/${command}`, metadata: { [MEMORY_COMMAND_OUTPUT_KEY]: command },
            delivery: invocation.delivery, resume: true,
          })
          turnSent = true
        },
      }
      const text = await runCoreMemoryCommand(name, commandDeps, invocation.prompt.text, ctx)
      output = { sessionID, command, text, level }
    } catch (error) {
      output = { sessionID, command, text: redactSecretLikeMaterial(describeError(error)), level: "error" }
    }
    // The model turn a command started is its visible result; only a failure is posted beside it.
    if (turnSent && output.level !== "error") return
    await postOutput(output)
  }

  async function executeExtra(command: ExtraMemoryCommand, invocation: CommandInvocation): Promise<void> {
    if (deps.isClosed()) return
    const { sessionID } = invocation
    let output: Output
    try {
      const result = await command.run(await deps.binder.resolve(sessionID), invocation.prompt.text)
      output = { sessionID, command: command.name, ...result }
    } catch (error) {
      output = { sessionID, command: command.name, text: redactSecretLikeMaterial(describeError(error)), level: "error" }
    }
    await postOutput(output)
  }

  const definitions = [
    ...(Object.keys(CORE_MEMORY_COMMANDS) as CoreMemoryCommandName[]).map((name): CommandDefinition => ({
      name: MEMORY_COMMAND_NAMES[name],
      description: CORE_MEMORY_COMMANDS[name].description,
      execute: invocation => execute(name, invocation),
    })),
    ...(deps.extraCommands ?? []).map((command): CommandDefinition => ({
      name: command.name,
      description: command.description,
      execute: invocation => executeExtra(command, invocation),
    })),
  ]

  return {
    definitions,
    async settled() {
      await Promise.allSettled([...chains.values()])
    },
  }
}
