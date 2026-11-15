import type { Context } from "@opencode/plugin/tui/context"
import { createElement, insert, setProp } from "@opentui/solid"
import { TASK_UPDATED_EVENT_TYPE, taskStatusRpc } from "../rpc/task"
import { createTaskStatusView, taskStatusLines, visibleTasks } from "./task-status"

const TICK_MS = 1_000

export function registerTaskStatusPanel(context: Context): () => void {
  const [state, update] = context.storage.memory("omo.task.panel", { initial: { revision: 0 } })
  const bump = () =>
    update((draft) => {
      draft.revision++
    })
  const view = createTaskStatusView({
    load: (sessionID, signal) =>
      context.client.rpc(taskStatusRpc).status({ sessionID }, { signal, location: context.location }),
    subscribe: (handler) => context.data.on(TASK_UPDATED_EVENT_TYPE, (event) => handler(event.data)),
    changed: bump,
  })
  // Elapsed clocks and the linger of a finished task advance without any server event.
  const tick = setInterval(() => {
    if (visibleTasks(view.snapshot(), Date.now()).length > 0) bump()
  }, TICK_MS)
  let release: () => void
  try {
    release = context.ui.slot({
      append: "session.composer.top",
      render: (input) => () => {
        view.select(input.sessionID)
        void state.revision
        const lines = taskStatusLines(view.snapshot(), Date.now())
        if (lines.length === 0) return undefined
        const box = createElement("box")
        setProp(box, "flexDirection", "column")
        setProp(box, "marginTop", 1)
        for (const line of lines) {
          const text = createElement("text")
          setProp(text, "fg", context.theme.text.base)
          insert(text, line)
          insert(box, text)
        }
        return box
      },
    })
  } catch (error) {
    clearInterval(tick)
    view.close()
    throw error
  }
  return () => {
    clearInterval(tick)
    try {
      release()
    } finally {
      view.close()
    }
  }
}
