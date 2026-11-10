import * as Plugin from "@opencode/plugin/tui/plugin"

import {
  MEMORY_COMMAND_OUTPUT_EVENT_TYPE, readMemoryCommandOutputEvent,
} from "../v2/memory/command-output-event"
import { OPENCODE_V2_NOTICE_DURATION_MS, OPENCODE_V2_NOTICE_MESSAGE, OPENCODE_V2_NOTICE_TITLE } from "./startup-notice"

type NoticeToast = {
  readonly ui: {
    readonly toast: {
      readonly show: (options: {
        readonly title: string
        readonly message: string
        readonly variant: "warning"
        readonly duration: number
      }) => void
    }
  }
}

export function showOpenCodeV2Notice(context: NoticeToast): void {
  context.ui.toast.show({
    title: OPENCODE_V2_NOTICE_TITLE,
    message: OPENCODE_V2_NOTICE_MESSAGE,
    variant: "warning",
    duration: OPENCODE_V2_NOTICE_DURATION_MS,
  })
}

/** The TUI slice the memory command output needs; `data` is absent in contexts without a live client. */
export interface MemoryOutputTui {
  readonly data?: { readonly on: (type: typeof MEMORY_COMMAND_OUTPUT_EVENT_TYPE, handler: (event: { readonly data: unknown }) => void) => () => void }
  readonly ui: {
    readonly dialog: { readonly alert: (options: { readonly title: string; readonly message: string }) => Promise<void> }
    readonly toast: { readonly show: (options: { readonly title: string; readonly message: string; readonly variant: "error"; readonly sessionID: string }) => void }
  }
}

/**
 * Shows memory slash-command output the moment the server emits it (`rpc.omo-memory.command.output`):
 * a dialog for a result, an error toast for a failure. This is the only OpenCode 2.2.6 surface that is
 * visible right away and never part of the model context. Returns the unsubscribe function.
 */
export function showMemoryCommandOutput(context: MemoryOutputTui): () => void {
  if (context.data === undefined) return () => undefined
  return context.data.on(MEMORY_COMMAND_OUTPUT_EVENT_TYPE, event => {
    const output = readMemoryCommandOutputEvent(event.data)
    if (output === undefined) return
    if (output.level === "error") {
      context.ui.toast.show({ title: `/${output.command}`, message: output.text, variant: "error", sessionID: output.sessionID })
      return
    }
    void context.ui.dialog.alert({ title: `/${output.command}`, message: output.text }).catch((error: unknown) => {
      context.ui.toast.show({ title: `/${output.command}`, message: `${output.text} (dialog failed: ${String(error)})`, variant: "error", sessionID: output.sessionID })
    })
  })
}

export const opencodeV2Tui = Plugin.define({
  id: "oh-my-openagent:tui",
  setup: (context) => {
    showOpenCodeV2Notice(context)
    // A context without the dialog surface (the notice-only test double) shows no command output.
    if ("dialog" in context.ui) return showMemoryCommandOutput(context)
    return undefined
  },
})
