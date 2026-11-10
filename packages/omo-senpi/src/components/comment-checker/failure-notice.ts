import { commentCheckerFailureNotice, type CheckFailure } from "@oh-my-opencode/comment-checker-core"

import type { ComponentLogger } from "../../extension/types"
import { COMMENT_CHECKER_LOG_LABEL } from "./constants"

type NotificationUi = { notify(message: string, level: "info" | "warning" | "error"): void }

export const COMMENT_CHECKER_COULD_NOT_RUN = `${COMMENT_CHECKER_LOG_LABEL} could not run; component disabled for this session`

// The logger alone is not enough: the interactive TUI diverts console output to the debug log, so the
// session UI is the only place a user sees that edits are no longer checked (#8850).
export function reportCommentCheckerFailure(
  logger: ComponentLogger,
  eventContext: unknown,
  binaryPath: string,
  failure: CheckFailure,
): void {
  logger.warn(COMMENT_CHECKER_COULD_NOT_RUN, { binaryPath, exitCode: failure.exitCode, stderr: failure.stderr })
  notificationUi(eventContext)?.notify(commentCheckerFailureNotice(binaryPath, failure), "warning")
}

function notificationUi(eventContext: unknown): NotificationUi | undefined {
  if (typeof eventContext !== "object" || eventContext === null) return undefined
  const ui: unknown = Reflect.get(eventContext, "ui")
  if (typeof ui !== "object" || ui === null || typeof Reflect.get(ui, "notify") !== "function") return undefined
  return {
    notify: (message, level) => {
      Reflect.apply(Reflect.get(ui, "notify"), ui, [message, level])
    },
  }
}
