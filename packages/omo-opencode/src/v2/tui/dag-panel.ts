import type { Context } from "@opencode/plugin/tui/context"
import { createElement, insert, setProp } from "@opentui/solid"
import { DAG_UPDATED_EVENT_TYPE, dagStatusRpc } from "../rpc/dag"
import { createDagStatusView, dagStatusLines } from "./dag-status"

export function registerDagStatusPanel(context: Context): () => void {
  const [state, update] = context.storage.memory("omo.dag.panel", { initial: { revision: 0 } })
  const view = createDagStatusView({
    load: (sessionID, signal) => context.client.rpc(dagStatusRpc).status({ sessionID }, { signal, location: context.location }),
    subscribe: handler => context.data.on(DAG_UPDATED_EVENT_TYPE, event => handler(event.data)),
    changed: () => update(draft => { draft.revision++ }),
  })
  let release: () => void
  try {
    release = context.ui.slot({ append: "session.composer.top", render: input => () => {
      view.select(input.sessionID)
      void state.revision
      const lines = dagStatusLines(view.snapshot())
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
    } })
  } catch (error) {
    view.close()
    throw error
  }
  return () => { try { release() } finally { view.close() } }
}
