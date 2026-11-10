import type { CheckFailure } from "./types"

export const COMMENT_CHECKER_FEEDBACK_HEADER = "comment-checker found issues in"

export function normalizeFeedbackText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
}

/** The text block appended to a mutation tool result for one file with findings. */
export function formatCommentCheckerFeedback(filePath: string, message: string): string {
  return `${COMMENT_CHECKER_FEEDBACK_HEADER} ${filePath}:\n${message}`
}

export function commentCheckerFailureNotice(binaryPath: string, failure: CheckFailure): string {
  const cause = failure.exitCode === null ? "it failed to start" : `it exited with code ${failure.exitCode}`
  const detail = failure.stderr.split("\n")[0]?.trim() ?? ""
  return `OmO comment checker could not run, so it is off for the rest of this session: ${cause}${detail.length > 0 ? ` (${detail})` : ""}. Checker: ${binaryPath}`
}
