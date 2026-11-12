import {
  createCommentCheckerSession,
  parseToolResultContext,
  parseToolResultEvent,
  type CommentCheckerSession,
} from "@oh-my-opencode/comment-checker-core"

import { reportToolHookStatus } from "../../extension/tool-hook-status"
import type { ComponentContext, ComponentLogger, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"
import { COMMENT_CHECKER_LOG_LABEL, SENPI_COMMENT_CHECKER_HOOK_EVENT } from "./constants"
import { downloadSenpiCommentCheckerBinary } from "./downloader"
import { reportCommentCheckerFailure } from "./failure-notice"
import { resolveSenpiCommentCheckerBinary } from "./resolver"
import { defaultRunCommentChecker } from "./runner"
import type { CommentCheckerComponentOptions } from "./types"

export function createCommentCheckerComponent(options: CommentCheckerComponentOptions = {}): OmoSenpiComponent {
  const resolveBinary = options.resolveBinary ?? defaultResolveBinary
  const downloadBinary = options.downloadBinary ?? defaultDownloadBinary
  const check = options.runCommentChecker ?? defaultRunCommentChecker
  // Checker state belongs to the component instance, so a re-registration keeps the resolved binary,
  // the inert flag and the per-turn dedupe exactly as before.
  let session: CommentCheckerSession | undefined

  return {
    name: "comment-checker",
    register(pi: SenpiExtensionAPI, ctx: ComponentContext): void {
      const checker = (session ??= createCommentCheckerSession({
        logger: ctx.logger,
        logLabel: COMMENT_CHECKER_LOG_LABEL,
        hookEventName: SENPI_COMMENT_CHECKER_HOOK_EVENT,
        resolveBinary,
        downloadBinary,
        runCommentChecker: check,
      }))

      pi.on("turn_start", () => {
        checker.startTurn()
        return undefined
      })

      pi.on("tool_result", async (payload, eventContext) => {
        const event = parseToolResultEvent(payload)
        if (event === undefined) return undefined

        const feedback = await checker.checkToolResult(event, parseToolResultContext(eventContext), {
          onCheckStart: () => reportToolHookStatus(eventContext, "(OmO) Checking Comments"),
          onCheckFailure: (binaryPath, failure) =>
            reportCommentCheckerFailure(ctx.logger, eventContext, binaryPath, failure),
        })
        if (feedback.length === 0) return undefined
        return { content: [...event.content, ...feedback.map((text) => ({ type: "text", text }))] }
      })
    },
  }
}

function defaultResolveBinary(): string | null {
  return resolveSenpiCommentCheckerBinary()
}

function defaultDownloadBinary(logger: ComponentLogger): Promise<string | null> {
  return downloadSenpiCommentCheckerBinary({ logger })
}
