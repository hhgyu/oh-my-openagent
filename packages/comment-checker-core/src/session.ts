import { isAbsolute, resolve } from "node:path"

import { formatCommentCheckerFeedback, normalizeFeedbackText } from "./feedback"
import type { CommentCheckerLogger } from "./logger"
import {
  stringValue,
  toApplyPatchHookInputs,
  toHookInput,
  type ToolResultContextLike,
  type ToolResultEventLike,
} from "./tool-result-input"
import type { CheckFailure, CheckResult, RunCommentCheckerInput } from "./types"

export interface CommentCheckerSessionOptions<L extends CommentCheckerLogger> {
  readonly logger: L
  /** Prefix of every log message, e.g. "omo-senpi comment-checker". */
  readonly logLabel: string
  /** `hook_event_name` written into the checker's stdin payload (the post-tool event of the host). */
  readonly hookEventName: string
  readonly resolveBinary: () => string | null
  /** Runs once per session when {@link resolveBinary} finds nothing; null keeps the session inert. */
  readonly downloadBinary: (logger: L) => Promise<string | null>
  readonly runCommentChecker: (input: RunCommentCheckerInput) => Promise<CheckResult>
}

export interface CommentCheckerToolResultHooks {
  /** Fires right before the checker runs, after the binary is known to be available. */
  onCheckStart?(): void
  /** Replaces the default warning when the checker cannot run; the session goes inert either way. */
  onCheckFailure?(binaryPath: string, failure: CheckFailure): void
}

/**
 * Per-session checker state: binary resolution runs once, a checker that cannot start disables the
 * session (#8850), and a file reported once is not reported again until {@link startTurn}.
 */
export interface CommentCheckerSession {
  startTurn(): void
  /** Feedback text blocks to append to the tool result; empty when nothing should be appended. */
  checkToolResult(
    event: ToolResultEventLike,
    context: ToolResultContextLike,
    hooks?: CommentCheckerToolResultHooks,
  ): Promise<string[]>
}

function isCommentCheckerMutationTool(toolName: string): toolName is "edit" | "write" | "apply_patch" {
  return toolName === "edit" || toolName === "write" || toolName === "apply_patch"
}

export function createCommentCheckerSession<L extends CommentCheckerLogger>(
  options: CommentCheckerSessionOptions<L>,
): CommentCheckerSession {
  const { logger, logLabel } = options
  let binaryPath: string | null | undefined
  let ensuring: Promise<string | null> | undefined
  let inertForSession = false
  let missingBinaryNoticeLogged = false
  const reportedFilesThisTurn = new Set<string>()

  async function ensureBinaryPath(): Promise<string | null> {
    if (inertForSession) {
      return null
    }
    if (binaryPath !== undefined) {
      return binaryPath
    }

    let nextBinaryPath: string | null
    try {
      nextBinaryPath = options.resolveBinary() ?? (await options.downloadBinary(logger))
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error
      }
      logger.warn(`${logLabel} binary resolution failed; component disabled for this session`, { error })
      nextBinaryPath = null
    }

    binaryPath = nextBinaryPath
    if (nextBinaryPath === null) {
      inertForSession = true
      if (!missingBinaryNoticeLogged) {
        logger.warn(`${logLabel} binary unavailable; component disabled for this session`)
        missingBinaryNoticeLogged = true
      }
    }
    return nextBinaryPath
  }

  return {
    startTurn() {
      reportedFilesThisTurn.clear()
    },
    async checkToolResult(event, context, hooks = {}) {
      if (event.isError || !isCommentCheckerMutationTool(event.toolName)) return []

      const rawPath = stringValue(event.input.path)
      const patchInputs =
        event.toolName === "apply_patch" ? toApplyPatchHookInputs(event, context, options.hookEventName) : []
      if (rawPath === undefined && patchInputs.length === 0) return []
      const absolutePath =
        rawPath === undefined ? undefined : isAbsolute(rawPath) ? rawPath : resolve(context.cwd, rawPath)
      const paths =
        patchInputs.length > 0
          ? patchInputs
              .map((input) => input.tool_input.file_path)
              .filter((path): path is string => typeof path === "string")
          : absolutePath
            ? [absolutePath]
            : []
      const uniquePaths = paths
        .filter((path, index) => paths.indexOf(path) === index)
        .filter((path) => !reportedFilesThisTurn.has(path))
      if (uniquePaths.length === 0) return []

      ensuring ??= ensureBinaryPath()
      const resolvedBinaryPath = await ensuring
      if (resolvedBinaryPath === null || inertForSession) {
        return []
      }

      hooks.onCheckStart?.()
      const inputs =
        event.toolName === "apply_patch"
          ? patchInputs
          : [toHookInput(event, context, uniquePaths[0], options.hookEventName)]
      const feedback: string[] = []
      for (const hookInput of inputs) {
        const path = hookInput.tool_input.file_path
        if (typeof path !== "string" || !uniquePaths.includes(path)) continue
        const result = await options.runCommentChecker({ binaryPath: resolvedBinaryPath, hookInput })
        if (result.failure !== undefined) {
          // A checker that cannot start fails the same way on every edit; stop re-running it (#8850).
          inertForSession = true
          if (hooks.onCheckFailure) {
            hooks.onCheckFailure(resolvedBinaryPath, result.failure)
          } else {
            logger.warn(`${logLabel} could not run; component disabled for this session`, {
              binaryPath: resolvedBinaryPath,
              exitCode: result.failure.exitCode,
              stderr: result.failure.stderr,
            })
          }
          break
        }
        const message = normalizeFeedbackText(result.message)
        if (result.hasComments && message.length > 0) {
          reportedFilesThisTurn.add(path)
          feedback.push(formatCommentCheckerFeedback(path, message))
        }
      }
      return feedback
    },
  }
}
