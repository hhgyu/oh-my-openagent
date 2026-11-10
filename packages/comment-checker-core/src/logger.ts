/** The logging slice Core needs; every host logger (Senpi component logger, console) satisfies it. */
export interface CommentCheckerLogger {
  info(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
}
