// OpenCode 2's `todowrite` input replaces the session's whole todo list, so the last successful call is the list the
// engine's completion gate asks about (its open tasks: pending or in_progress).
const OPEN_STATUSES = new Set(["pending", "in_progress"])

export function createTodoState() {
  const open = new Map<string, readonly string[]>()
  return {
    observe(sessionID: string, tool: string, input: unknown): void {
      if (tool !== "todowrite" || typeof input !== "object" || input === null) return
      const todos = (input as { todos?: unknown }).todos
      if (!Array.isArray(todos)) return
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
    forget(sessionID: string): void {
      open.delete(sessionID)
    },
  }
}
