import type * as Plugin from "@opencode/plugin/promise/plugin"
import {
  createCommentCheckerSession,
  runCommentCheckerWithNodeSpawn,
  type CheckResult,
  type CommentCheckerLogger,
  type CommentCheckerSession,
  type RunCommentCheckerInput,
} from "@oh-my-opencode/comment-checker-core"
import { downloadV2CommentCheckerBinary, resolveV2CommentCheckerBinary, V2_COMMENT_CHECKER_LOG_LABEL } from "./binary"
import { createConsoleCommentCheckerLogger } from "./console-logger"
import { toCheckerToolResult, withFeedback } from "./event-translation"

type Host = Pick<Plugin.Context, "tool" | "location" | "options">

/** The checker payload names the post-tool event the Claude Code way, as every other edition does. */
const HOOK_EVENT_NAME = "PostToolUse"

export interface CommentCheckerSeams {
  readonly resolveBinary?: () => string | null
  /** Runs once per session when `resolveBinary` finds nothing; null keeps that session inert. */
  readonly downloadBinary?: (logger: CommentCheckerLogger) => Promise<string | null>
  readonly runCommentChecker?: (input: RunCommentCheckerInput) => Promise<CheckResult>
}

export interface CommentCheckerRegistrationOptions {
  /** Seams of the shared checker session (binary resolution, download, checker run). */
  readonly component?: CommentCheckerSeams
  readonly logger?: CommentCheckerLogger
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Checker state is kept per session; idle sessions beyond this bound are forgotten oldest-first. */
  readonly maxSessions?: number
}

interface SessionSlot {
  readonly checker: CommentCheckerSession
  messageID: string | undefined
}

/** Same opt-outs as the Native component: its own flag, the adapter-wide flag, and OMO_SENPI_DISABLED=1. */
function isDisabled(host: Host, env: Readonly<Record<string, string | undefined>>): boolean {
  return host.options?.["omo-senpi-comment-checker-disabled"] === true ||
    host.options?.["omo-senpi-disabled"] === true || env.OMO_SENPI_DISABLED === "1"
}

export async function registerCommentChecker(context: Host, options: CommentCheckerRegistrationOptions = {}): Promise<() => Promise<void>> {
  if (isDisabled(context, options.env ?? process.env)) return async () => {}
  const cwd = context.location.directory
  const logger = options.logger ?? createConsoleCommentCheckerLogger()
  const seams = options.component ?? {}
  const maxSessions = Math.max(1, options.maxSessions ?? 64)
  const sessions = new Map<string, SessionSlot>()
  const active = new Set<Promise<void>>()
  let closed = false

  function slotFor(sessionID: string): SessionSlot {
    const existing = sessions.get(sessionID)
    if (existing) { sessions.delete(sessionID); sessions.set(sessionID, existing); return existing }
    const checker = createCommentCheckerSession({
      logger,
      logLabel: V2_COMMENT_CHECKER_LOG_LABEL,
      hookEventName: HOOK_EVENT_NAME,
      resolveBinary: seams.resolveBinary ?? resolveV2CommentCheckerBinary,
      downloadBinary: seams.downloadBinary ?? downloadV2CommentCheckerBinary,
      runCommentChecker: seams.runCommentChecker ?? runCommentCheckerWithNodeSpawn,
    })
    const slot: SessionSlot = { checker, messageID: undefined }
    sessions.set(sessionID, slot)
    for (const oldest of sessions.keys()) { if (sessions.size <= maxSessions) break; sessions.delete(oldest) }
    return slot
  }

  // The checker runs on OpenCode 2 `tool.hook("execute.after")` with status "completed": the warning
  // is appended to the tool result the model reads. OpenCode 2 has no turn-start hook; a new
  // assistant `messageID` within a session is the turn boundary that resets per-turn dedupe.
  const registration = await context.tool.hook("execute.after", event => {
    if (closed || event.status !== "completed") return
    const delivered = toCheckerToolResult({ tool: event.tool, sessionID: event.sessionID, id: event.id, input: event.input, result: event.result }, cwd)
    if (!delivered) return
    const slot = slotFor(event.sessionID)
    if (slot.messageID !== event.messageID) slot.checker.startTurn()
    slot.messageID = event.messageID
    const work = (async () => {
      const feedback = await slot.checker.checkToolResult(delivered.event, delivered.context)
      if (closed) return
      if (feedback.length > 0) event.result = withFeedback(event.result, feedback)
    })()
    active.add(work)
    return work.finally(() => { active.delete(work) })
  })

  let disposal: Promise<void> | undefined
  return () => {
    disposal ??= (async () => {
      closed = true
      try { await registration.dispose() }
      finally { await Promise.allSettled([...active]); sessions.clear() }
    })()
    return disposal
  }
}
