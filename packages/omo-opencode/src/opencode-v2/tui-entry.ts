import * as Plugin from "@opencode/plugin/tui/plugin"

import {
  COMPUTER_COMMAND_OUTPUT_EVENT_TYPE,
  COMPUTER_PERMISSION_EVENT_TYPE,
  readComputerPermissionEvent,
} from "../v2/computer/command-output-event"
import { GOAL_COMMAND_OUTPUT_EVENT_TYPE } from "../v2/goal/command-output-event"
import { MEMORY_COMMAND_OUTPUT_EVENT_TYPE, readMemoryCommandOutputEvent } from "../v2/memory/command-output-event"
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

type CommandOutputEventType =
  | typeof MEMORY_COMMAND_OUTPUT_EVENT_TYPE
  | typeof GOAL_COMMAND_OUTPUT_EVENT_TYPE
  | typeof COMPUTER_COMMAND_OUTPUT_EVENT_TYPE

type OutputEventType = CommandOutputEventType | typeof COMPUTER_PERMISSION_EVENT_TYPE

/** The TUI slice the memory command output needs; `data` is absent in contexts without a live client. */
export interface MemoryOutputTui {
  readonly data?: {
    readonly on: (type: OutputEventType, handler: (event: { readonly data: unknown }) => void) => () => void
  }
  readonly ui: {
    readonly dialog: {
      readonly alert: (options: { readonly title: string; readonly message: string }) => Promise<void>
    }
    readonly toast: {
      readonly show: (options: {
        readonly title: string
        readonly message: string
        readonly variant: "error" | "warning"
        readonly sessionID: string
      }) => void
    }
  }
}

/**
 * Shows memory and goal slash-command output the moment the server emits it (`rpc.omo-memory.command.output`,
 * `rpc.omo-goal.command.output`): a dialog for a result, an error toast for a failure. This is the only OpenCode
 * 2.2.6 surface that is visible right away and never part of the model context. Returns the unsubscribe function.
 */
export function showMemoryCommandOutput(context: MemoryOutputTui): () => void {
  const closeMemory = showCommandOutput(context, MEMORY_COMMAND_OUTPUT_EVENT_TYPE)
  const closeGoal = showCommandOutput(context, GOAL_COMMAND_OUTPUT_EVENT_TYPE)
  return () => {
    try {
      closeGoal()
    } finally {
      closeMemory()
    }
  }
}

const PERMISSION_LABEL = { screen_recording: "Screen Recording", accessibility: "Accessibility" } as const

export function showComputerEvents(context: MemoryOutputTui): () => void {
  if (context.data === undefined) return () => undefined
  const closeOutput = showCommandOutput(context, COMPUTER_COMMAND_OUTPUT_EVENT_TYPE)
  const closePermission = context.data.on(COMPUTER_PERMISSION_EVENT_TYPE, (event) => {
    const notice = readComputerPermissionEvent(event.data)
    if (notice === undefined) return
    context.ui.toast.show({
      title: "Computer use",
      message: `${notice.app} needs the ${PERMISSION_LABEL[notice.permission]} permission (System Settings > Privacy & Security); grant it, then fully quit and relaunch ${notice.app}.`,
      variant: "warning",
      sessionID: notice.sessionID,
    })
  })
  return () => {
    try {
      closeOutput()
    } finally {
      closePermission()
    }
  }
}

function showCommandOutput(context: MemoryOutputTui, type: CommandOutputEventType): () => void {
  if (context.data === undefined) return () => undefined
  return context.data.on(type, (event) => {
    const output = readMemoryCommandOutputEvent(event.data)
    if (output === undefined) return
    if (output.level === "error") {
      context.ui.toast.show({
        title: `/${output.command}`,
        message: output.text,
        variant: "error",
        sessionID: output.sessionID,
      })
      return
    }
    void context.ui.dialog.alert({ title: `/${output.command}`, message: output.text }).catch((error: unknown) => {
      context.ui.toast.show({
        title: `/${output.command}`,
        message: `${output.text} (dialog failed: ${String(error)})`,
        variant: "error",
        sessionID: output.sessionID,
      })
    })
  })
}

export const opencodeV2Tui = Plugin.define({
  id: "oh-my-openagent:tui",
  setup: (context) => {
    showOpenCodeV2Notice(context)
    // A context without the dialog surface (the notice-only test double) shows no command output.
    if ("dialog" in context.ui) {
      const closeMemoryOnly = showMemoryCommandOutput(context)
      const closeComputer = showComputerEvents(context)
      const closeMemory = () => {
        try {
          closeComputer()
        } finally {
          closeMemoryOnly()
        }
      }
      if (!("slot" in context.ui)) return closeMemory
      return Promise.all([import("../v2/tui/dag-panel"), import("../v2/tui/ulw-loop-footer")])
        .then(([{ registerDagStatusPanel }, { registerUlwLoopFooter }]) => {
          const closeDag = registerDagStatusPanel(context)
          let closeFooter: () => void
          try {
            closeFooter = registerUlwLoopFooter(context)
          } catch (error) {
            closeDag()
            throw error
          }
          return () => {
            try {
              closeFooter()
            } finally {
              try {
                closeDag()
              } finally {
                closeMemory()
              }
            }
          }
        })
        .catch((error: unknown) => {
          closeMemory()
          throw error
        })
    }
    return undefined
  },
})
