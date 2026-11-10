import type { CommentCheckerLogger } from "@oh-my-opencode/comment-checker-core"

/** V2 diagnostics go to the console with the shared V2 prefix (see v2/hooks/runtime.ts). */
export function createConsoleCommentCheckerLogger(): CommentCheckerLogger {
  const prefix = "[oh-my-openagent/v2]"
  return {
    info(message, details) { console.info(`${prefix} ${message}`, ...(details === undefined ? [] : [details])) },
    warn(message, details) { console.warn(`${prefix} ${message}`, ...(details === undefined ? [] : [details])) },
  }
}
