import type * as Plugin from "@opencode/plugin/promise/plugin"
import { log } from "../shared/logger"
import { OPENCODE_V2_NOTICE_MESSAGE } from "./startup-notice"

// Plugin.define is an identity function. Keep this compatibility entry type-only:
// V1 hosts can import the normal root without installing the optional V2 SDK.
export const opencodeV2Server = {
  id: "oh-my-openagent",
  setup: async (context: Plugin.Context) => {
    const { setupV2Host } = await import("../v2")
    const cleanup = await setupV2Host(context)
    log("[opencode-v2] native agents registered", { notice: OPENCODE_V2_NOTICE_MESSAGE })
    return cleanup
  },
} satisfies Plugin.Plugin
