// /init - initialize the memory repository and send a standardized init turn.
//
// Port of letta's initializing-memory skill trigger: only runs when no repo
// exists yet, and NEVER overwrites an existing repository.

import { NO_MEMORY_TURN_TEXT } from "./remember"
import { hasGitRepo, openRepo, shortSha } from "./repo"
import { requireIdentity, respond, slashCommand, type MemoryCommandContext, type MemoryCommandDeps } from "./types"

function initInstruction(repoPath: string, command: string): string {
  return [
    "[MEMORY INITIALIZATION]",
    `The user invoked ${command}. Your memory repository was just initialized at ${repoPath} and is projected on the local filesystem. Inspect it before writing.`,
    "",
    "Create your initial memory now:",
    "- system/persona.md: who you are (identity, communication style, durable behavioral rules). This file compiles into every future system prompt; keep it curated.",
    "- system/human.md: what you know about the user (goals, preferences, collaboration style).",
    "- Additional system/ index files when useful: compact summaries with [[path]] discovery links into external memory.",
    "",
    "Every memory file uses this format:",
    "---",
    "description: <single-line purpose>",
    "---",
    "<body>",
    "",
    "Store durable, generalizable knowledge, not transient session state. Do not overwrite existing files; extend them.",
  ].join("\n")
}

export async function runInitCommand(deps: MemoryCommandDeps, _args: string, ctx: MemoryCommandContext): Promise<string> {
  const identity = requireIdentity(deps, ctx)
  if (typeof identity === "string") return respond(ctx, identity, "error")

  const repo = openRepo(deps, identity)
  const head = hasGitRepo(identity) ? await repo.head() : null
  if (head !== null) {
    return respond(
      ctx,
      `memory already initialized for ${identity.identity} (HEAD ${shortSha(head)}); use /memory to view or /doctor to audit`,
      "error",
    )
  }
  const send = deps.sendUserMessage
  if (send === undefined) return respond(ctx, NO_MEMORY_TURN_TEXT, "error")

  await repo.init()
  await ctx.waitForIdle?.()
  await send(initInstruction(identity.identityPaths.repo, slashCommand(deps, "init")))
  return respond(ctx, `initialized memory repository at ${identity.identityPaths.repo}; initialization turn sent`)
}
