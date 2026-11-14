import type { ThreadToolResult } from "./contracts"
import { threadToolFailure, type ThreadErrorCode } from "./errors"

/** A tool's failure as data: `{ kind: "error", error }` with the recovery step the model reads. */
export function failure(
  code: ThreadErrorCode,
  message: string,
  next: string,
  details?: Readonly<Record<string, unknown>>,
): ThreadToolResult {
  return { kind: "error", error: threadToolFailure(code, message, next, details) }
}
