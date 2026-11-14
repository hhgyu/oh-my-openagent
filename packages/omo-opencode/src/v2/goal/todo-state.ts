// OpenCode 2's `todowrite` input replaces the session's whole todo list, so the last successful call is the list the
// engine's completion gate asks about (its open tasks: pending or in_progress).
const OPEN_STATUSES = new Set(["pending", "in_progress"])

export function createTodoState() {
  const open = new Map<string, readonly string[]>()
  const total = new Map<string, number>()
  return {
    observe(sessionID: string, tool: string, input: unknown): void {
      if (tool !== "todowrite" || typeof input !== "object" || input === null) return
      const todos = (input as { todos?: unknown }).todos
      if (!Array.isArray(todos)) return
      total.set(sessionID, todos.length)
      open.set(
        sessionID,
        todos.flatMap((todo: unknown) => {
          if (typeof todo !== "object" || todo === null) return []
          const { content, status } = todo as { content?: unknown; status?: unknown }
          return typeof content === "string" && typeof status === "string" && OPEN_STATUSES.has(status) ? [content] : []
        }),
      )
    },
    openTasks(sessionID: string): readonly string[] {
      return open.get(sessionID) ?? []
    },
    counts(sessionID: string): { readonly open: number; readonly total: number } {
      return { open: open.get(sessionID)?.length ?? 0, total: total.get(sessionID) ?? 0 }
    },
    forget(sessionID: string): void {
      open.delete(sessionID)
      total.delete(sessionID)
    },
  }
}
