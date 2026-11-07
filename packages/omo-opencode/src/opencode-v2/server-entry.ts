import { setupV2Host } from "../v2"
import * as Plugin from "@opencode/plugin/promise/plugin"
import { log } from "../shared/logger"
import { OPENCODE_V2_NOTICE_MESSAGE } from "./startup-notice"

// The normal package entry and explicit ./v2 entry share native registration.
// The neighboring V1 `server` export remains independent.
export const opencodeV2Server = Plugin.define({
  id: "oh-my-openagent",
  setup: async (context) => {
    const cleanup = await setupV2Host(context)
    log("[opencode-v2] native agents registered", { notice: OPENCODE_V2_NOTICE_MESSAGE })
    return cleanup
  },
})
