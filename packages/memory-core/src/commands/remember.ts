// /remember <text> - durable memory request turn.
//
// Port of letta src/agent/prompts/remember.md semantics: the main agent owns the
// memory write through its memory tools; the command only delivers an instruction
// turn at a clean idle boundary. Read-only command output never enters the model
// context, but this command's whole purpose is to create a model turn.

import { requireIdentity, respond, type MemoryCommandContext, type MemoryCommandDeps } from "./types"

export const REMEMBER_INSTRUCTION =
  "[MEMORY REQUEST] Persist this as long-term memory if appropriate. Use your memory tools: " +
  "choose the most appropriate memory file (create one if no relevant file exists), avoid " +
  "duplicates, match the existing formatting of the file, then briefly confirm what you " +
  "remembered and where you stored it."

export const NO_MEMORY_TURN_TEXT = "this host cannot start a memory turn from a command; nothing was sent"

export async function runRememberCommand(
  deps: MemoryCommandDeps,
  args: string,
  ctx: MemoryCommandContext,
): Promise<string> {
  const identity = requireIdentity(deps, ctx)
  if (typeof identity === "string") return respond(ctx, identity, "error")

  const text = args.trim()
  if (text.length === 0) return respond(ctx, "usage: /remember <text>", "error")
  const send = deps.sendUserMessage
  if (send === undefined) return respond(ctx, NO_MEMORY_TURN_TEXT, "error")

  await ctx.waitForIdle?.()
  await send(`${REMEMBER_INSTRUCTION}\n\n${text}`)
  return respond(ctx, `memory request sent for ${identity.identity}`)
}
