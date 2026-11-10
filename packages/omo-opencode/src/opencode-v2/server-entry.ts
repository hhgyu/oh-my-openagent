import type * as Plugin from "@opencode/plugin/promise/plugin"
import type * as EffectPlugin from "@opencode/plugin/effect/plugin"
import { log } from "../shared/logger"
import { OPENCODE_V2_NOTICE_MESSAGE } from "./startup-notice"

// Plugin.define is an identity function. Keep this compatibility entry type-only:
// V1 hosts can import the normal root without installing the optional V2 SDK.
export const opencodeV2Server = {
  id: "oh-my-openagent",
  setup: async (context: Plugin.Context) => {
    const { setupV2Host } = await import("../v2")
    const cleanup = await setupV2Host(context)
    log("[opencode-v2] native agent and runtime setup complete", { notice: OPENCODE_V2_NOTICE_MESSAGE })
    return cleanup
  },
  effect: (context: EffectPlugin.Context) => {
    // V1 never invokes this thunk. Keep optional Effect/SDK runtime loads behind V2 selection.
    const { Effect } = require("effect") as typeof import("effect")
    return Effect.flatMap(
      Effect.promise(() => import("../v2")),
      ({ setupV2EffectHost }) => setupV2EffectHost(context),
    )
  },
} satisfies Plugin.Plugin & Pick<EffectPlugin.Plugin, "effect">
