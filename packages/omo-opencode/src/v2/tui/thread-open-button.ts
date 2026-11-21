import type { Context } from "@opencode/plugin/tui/context"
import { MouseButton, TextRenderable } from "@opentui/core"
import { parseThreadLinkUrl, threadLinkUrl } from "@oh-my-opencode/thread-core/thread-link"
import { THREAD_OPEN_BLOCK } from "../threads/open-button-markdown"

export function registerThreadOpenButton(context: Pick<Context, "markdown" | "renderer" | "theme" | "ui">): () => void {
  return context.markdown.registerCodeBlockRenderer(THREAD_OPEN_BLOCK, ({ text }) => {
    const url = text.trim()
    const sessionID = parseThreadLinkUrl(url)?.threadId
    if (sessionID === undefined || !/^ses_[A-Za-z0-9_-]+$/.test(sessionID) || threadLinkUrl(sessionID) !== url)
      return undefined

    const label = "[ Open session ]"
    return new TextRenderable(context.renderer, {
      content: label,
      width: label.length,
      height: 1,
      selectable: false,
      fg: context.theme.text.base,
      onMouseUp(event) {
        if (
          event.button !== MouseButton.LEFT ||
          event.isDragging ||
          event.modifiers.ctrl ||
          event.modifiers.alt ||
          event.modifiers.shift
        )
          return
        event.preventDefault()
        event.stopPropagation()
        context.ui.router.navigate({ type: "session", sessionID })
      },
    })
  })
}
