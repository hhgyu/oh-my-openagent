import type { Context } from "@opencode/plugin/tui/context"
import { createElement, insert, setProp } from "@opentui/solid"
import { ULW_LOOP_UPDATED_EVENT_TYPE, ulwLoopStatusRpc } from "../rpc/ulw-loop"
import { createUlwLoopFooterView } from "./ulw-loop-status"

export function registerUlwLoopFooter(context: Context): () => void {
  const [state, update] = context.storage.memory("omo.ulw-loop.footer", { initial: { revision: 0 } })
  const view = createUlwLoopFooterView({
    load: (sessionID, signal) =>
      context.client.rpc(ulwLoopStatusRpc).status({ sessionID }, { signal, location: context.location }),
    subscribe: (handler) => context.data.on(ULW_LOOP_UPDATED_EVENT_TYPE, (event) => handler(event.data)),
    changed: () =>
      update((draft) => {
        draft.revision++
      }),
  })
  let release: () => void
  try {
    release = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => () => {
        if (input.sessionID === undefined) return undefined
        view.select(input.sessionID)
        void state.revision
        const frame = view.frame()
        if (frame === undefined) return undefined
        const text = createElement("text")
        setProp(text, "fg", context.theme.text.base)
        insert(text, frame)
        return text
      },
    })
  } catch (error) {
    view.close()
    throw error
  }
  return () => {
    try {
      release()
    } finally {
      view.close()
    }
  }
}
