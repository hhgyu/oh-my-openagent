// `/dream [--auto | --recent N | --conversation <ids>] [--to <doc>] [focus text]` (plan S7h), porting
// omo-senpi `commands/dream.ts`: a manual dream bypasses every automatic gate and goes through the
// reflection component's `requestDream` (reservation store, then the detached run). Modes are exclusive;
// `--recent N` takes the N most recently active journals through the dream selector; `--conversation`
// takes explicit journal ids; `--to` limits the run to one memory-repo-relative `.md` document (the runner
// fails a dream that changes anything else with `invalid_target`). Not ported: `--from transcript:<path>`,
// which stages a Senpi session JSONL file into a journal (refused with its own text). Added: explicit
// conversation ids must be plain journal names, so no id can address a directory outside the transcripts.

import { validateMemoryPath } from "@oh-my-opencode/memory-core"
import { parseCommandArgs } from "@oh-my-opencode/memory-core/commands/args"
import { isAbsolute, relative, sep } from "node:path"
import { v2CommandName, v2Slash } from "../commands/namespace"
import type { BoundMemorySession } from "./binding"
import type { DreamFireOutcome, DreamRequest } from "./dream-fire"
import type { DreamTriggerSettings } from "@oh-my-opencode/memory-core/dream-gates"
import { selectRecentDreamConversations } from "@oh-my-opencode/memory-core/dream-selection"
import type { ExtraMemoryCommand } from "./reflect-command"

/** Registered name of the dream command, kept apart from the core `MEMORY_COMMAND_NAMES` record. */
const DREAM_COMMAND_NAMES: Readonly<Record<"dream", string>> = { dream: v2CommandName("dream") }

const MODE_FLAGS = ["auto", "recent", "conversation", "from"] as const
const JOURNAL_ID = /^[A-Za-z0-9._-]+$/

interface DreamCommandDeps {
  readonly request: (bound: BoundMemorySession, request: DreamRequest) => Promise<DreamFireOutcome>
  readonly settings: (bound: BoundMemorySession) => DreamTriggerSettings
  readonly now?: () => number
}

function requiredValue(value: string | true | undefined, flag: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${flag} requires a value`)
  return value.trim()
}

function resolveTargetDoc(repoDir: string, value: string | true | undefined): string | undefined {
  if (value === undefined) return undefined
  const raw = requiredValue(value, "--to")
  if (isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw))
    throw new TypeError("--to must be a memory-repo-relative document path")
  let absolute: string
  try {
    absolute = validateMemoryPath(repoDir, raw, { fieldName: "--to", toolPath: false })
  } catch {
    throw new TypeError("--to must be a memory-repo-relative document path without traversal")
  }
  const path = relative(repoDir, absolute).split(sep).join("/")
  if (!path.endsWith(".md")) throw new TypeError("--to must target a .md document in the memory repo")
  return path
}

function conversationList(value: string | true | undefined): string[] {
  const ids = requiredValue(value, "--conversation")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
  if (ids.length === 0) throw new TypeError("--conversation expects one or more comma-separated ids")
  if (ids.some((id) => !JOURNAL_ID.test(id) || id === "." || id === ".."))
    throw new TypeError("--conversation ids must be plain conversation ids")
  return [...new Set(ids)]
}

function dreamRejection(rejection: string): string {
  if (rejection === "no_unreflected_content") return "dream found no unreflected content to process"
  if (rejection === "no_session") return "dreaming is not available without a bound memory session"
  if (rejection === "parked")
    return `automatic memory reflection is paused after repeated failures; run ${v2Slash("reflect")} to retry now`
  return `dream request was not started: ${rejection}`
}

async function conversationScope(
  bound: BoundMemorySession,
  flags: ReadonlyMap<string, string | true>,
  focus: string,
  deps: DreamCommandDeps,
): Promise<readonly string[] | undefined> {
  if (flags.has("from"))
    throw new TypeError(
      "--from transcript:<path> stages Senpi session JSONL and is not available on OpenCode; use --conversation or --recent",
    )
  if (flags.has("conversation")) return conversationList(flags.get("conversation"))
  if (!flags.has("recent")) return undefined
  const recentN = Number(requiredValue(flags.get("recent"), "--recent"))
  if (!Number.isInteger(recentN) || recentN <= 0) throw new TypeError("--recent expects a positive integer")
  const settings = deps.settings(bound)
  const selected = await selectRecentDreamConversations(
    {
      transcriptsDir: bound.paths.transcripts,
      currentConversationId: bound.sessionID,
      autoSelectMax: settings.autoSelectMax,
      autoSelectMaxBytes: settings.autoSelectMaxChars,
      now: () => new Date(deps.now?.() ?? Date.now()),
    },
    recentN,
    focus.length === 0 ? {} : { focus },
  )
  if (selected.conversationIds.length === 0) throw new TypeError("--recent found no unreflected conversations")
  return selected.conversationIds
}

export function createDreamCommand(deps: DreamCommandDeps): ExtraMemoryCommand {
  return {
    name: DREAM_COMMAND_NAMES.dream,
    description:
      "Request a memory dream: consolidate memory across conversations, optionally scoped, focused or limited to one document.",
    async run(bound, args) {
      if (bound === undefined) return { text: dreamRejection("no_session"), level: "error" }
      const parsed = parseCommandArgs(args, { booleans: ["auto"] })
      if (MODE_FLAGS.filter((flag) => parsed.flags.has(flag)).length > 1) {
        return { text: "choose exactly one of --auto, --recent, --conversation, or --from", level: "error" }
      }
      const focus = parsed.positionals.join(" ").trim()
      let targetDoc: string | undefined
      let conversationIds: readonly string[] | undefined
      try {
        targetDoc = resolveTargetDoc(bound.paths.repo, parsed.flags.get("to"))
        conversationIds = await conversationScope(bound, parsed.flags, focus, deps)
      } catch (error) {
        return { text: error instanceof Error ? error.message : String(error), level: "error" }
      }
      const outcome = await deps.request(bound, {
        ...(focus.length === 0 ? {} : { focus }),
        ...(conversationIds === undefined ? {} : { conversationIds }),
        ...(targetDoc === undefined ? {} : { targetDoc }),
      })
      if (!outcome.fired) return { text: dreamRejection(outcome.rejection), level: "error" }
      return outcome.status === "active"
        ? { text: `dream run ${outcome.runId} reserved`, level: "info" }
        : { text: `dream request queued as ${outcome.runId}; another memory run is active`, level: "info" }
    },
  }
}
