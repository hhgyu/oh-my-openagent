import { describe, expect, it } from "bun:test"

import { NATIVE_EDITION_GUIDE_URL, NATIVE_EDITION_INSTALL_COMMAND } from "../cli/native-edition-hint"
import tuiModule from "../tui"
import { MEMORY_COMMAND_OUTPUT_EVENT_TYPE } from "../v2/memory/command-output-event"
import { showMemoryCommandOutput, showOpenCodeV2Notice, type MemoryOutputTui } from "./tui-entry"

type ShownToast = { readonly title: string; readonly message: string; readonly variant: string }

function recordingContext(): {
  readonly shown: ShownToast[]
  readonly context: Parameters<typeof showOpenCodeV2Notice>[0]
} {
  const shown: ShownToast[] = []
  return { shown, context: { ui: { toast: { show: (options) => shown.push(options) } } } }
}

describe("OpenCode 2 TUI notice", () => {
  it("shows one warning toast that points to OmO Native", () => {
    // given
    const { shown, context } = recordingContext()

    // when
    showOpenCodeV2Notice(context)

    // then
    expect(shown).toHaveLength(1)
    expect(shown[0]?.variant).toBe("warning")
    expect(shown[0]?.message).toContain(NATIVE_EDITION_INSTALL_COMMAND)
    expect(shown[0]?.message).toContain(NATIVE_EDITION_GUIDE_URL)
    expect(shown[0]?.message).toContain("native OmO agents, Native LSP tools")
    expect(shown[0]?.message).toContain("Remaining Native tools, hooks and orchestration")
    expect(shown[0]?.message).not.toContain("agents, tools and hooks are not active")
  })

  it("keeps the V1 tui entry and adds a V2 setup that shows the notice on every start", async () => {
    // given
    const definition: Record<string, unknown> = tuiModule
    const { shown, context } = recordingContext()
    const setup = definition["setup"]

    // when
    if (typeof setup !== "function") throw new Error("setup missing")
    await setup(context)
    await setup(context)

    // then
    expect(definition["id"]).toBe("oh-my-openagent:tui")
    expect(typeof definition["tui"]).toBe("function")
    expect(shown).toHaveLength(2)
  })
})

describe("OpenCode 2 TUI memory command output", () => {
  type Handler = (event: { readonly data: unknown }) => void
  function outputContext() {
    const handlers = new Map<string, Handler>()
    const dialogs: { title: string; message: string }[] = []
    const toasts: { title: string; message: string; variant: string; sessionID: string }[] = []
    const context: MemoryOutputTui = {
      data: {
        on: (type, handler) => {
          handlers.set(type, handler)
          return () => {
            handlers.delete(type)
          }
        },
      },
      ui: {
        dialog: {
          alert: async (options) => {
            dialogs.push(options)
          },
        },
        toast: {
          show: (options) => {
            toasts.push(options)
          },
        },
      },
    }
    return { handlers, dialogs, toasts, context }
  }

  it("#given a subscribed TUI #when the server emits a result and a failure #then the result opens a dialog and the failure an error toast", async () => {
    // given
    const t = outputContext()
    showMemoryCommandOutput(t.context)
    const emit = t.handlers.get(MEMORY_COMMAND_OUTPUT_EVENT_TYPE)
    if (emit === undefined) throw new Error("not subscribed")
    // when
    emit({ data: { sessionID: "ses_1", command: "memory", level: "info", text: "# Memory: me" } })
    emit({ data: { sessionID: "ses_1", command: "search", level: "error", text: "/search failed: boom" } })
    emit({ data: { unrelated: true } })
    await Promise.resolve()
    // then
    expect(t.dialogs).toEqual([{ title: "/memory", message: "# Memory: me" }])
    expect(t.toasts).toEqual([
      { title: "/search", message: "/search failed: boom", variant: "error", sessionID: "ses_1" },
    ])
  })

  it("#given a subscription #when it is disposed #then the handler is removed", () => {
    // given
    const t = outputContext()
    const unsubscribe = showMemoryCommandOutput(t.context)
    // when
    unsubscribe()
    // then
    expect(t.handlers.size).toBe(0)
  })
})
