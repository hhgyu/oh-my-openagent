// The Native `thread_*` tools in OpenCode Code Mode (D-034 amendment). Native keeps them eval-only, which in Senpi means
// "withheld from the direct tool list, called from a code cell". OpenCode 2 has its own code cell, Code Mode
// (`execute`), next to the omo `eval` kernel; a `codemode: true` tool stays out of the direct tool list and is called as
// `tools.thread_*()` inside `execute`, so the same eighteen tools are offered there too. Both surfaces run the one
// owned tool body, so gateway state, receipts, permission prompts and reply allowance are shared.

import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { Info, Result } from "@opencode/plugin/promise/tool"
import type { OwnedEvalHostTool } from "../tools/codemode-host-tools"
import { adaptEvalResult } from "../tools/native-eval-result"

export const THREAD_CODEMODE_METADATA_KEY = "omoThread"

export function threadCodemodeTool(owned: OwnedEvalHostTool): Info {
  return {
    name: owned.name,
    description: owned.description,
    input: owned.parameters as Info["input"],
    options: { codemode: true },
    async execute(input, context): Promise<Result> {
      // A permission verdict (thread_send) is rethrown untouched: OpenCode needs its own error to end the step.
      const result = await owned.execute(input, {
        sessionID: context.sessionID,
        signal: context.signal,
        caller: context,
      })
      return adaptEvalResult(result, THREAD_CODEMODE_METADATA_KEY)
    },
  }
}

export async function registerThreadCodemodeTools(
  tool: Plugin.Context["tool"],
  owned: readonly OwnedEvalHostTool[],
  log: (line: string) => void,
): Promise<Registration> {
  return tool.transform((editor) => {
    const taken = owned.filter((entry) => editor.list().some((existing) => existing.name === entry.name))
    if (taken.length > 0) {
      log(`Code Mode thread tools stay off: ${taken.map((entry) => entry.name).join(", ")} already registered`)
      return
    }
    for (const entry of owned) editor.add(threadCodemodeTool(entry))
  })
}
