// The Native `thread_*` tools in OpenCode Code Mode (D-034 amendment). Native keeps them eval-only, which in Senpi means
// "withheld from the direct tool list, called from a code cell". OpenCode 2 has its own code cell, Code Mode
// (`execute`), next to the omo `eval` kernel; a `codemode: true` tool stays out of the direct tool list and is called as
// `tools.thread_*()` inside `execute`, so the same fourteen tools are offered there too. Both surfaces run the one
// owned tool body, so gateway state, receipts, permission prompts and reply allowance are shared.

import type * as Plugin from "@opencode/plugin/promise/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { Info, Result } from "@opencode/plugin/promise/tool"
import { THREAD_TOOL_METADATA } from "@oh-my-opencode/thread-core/metadata"
import type { OwnedEvalHostTool } from "../tools/codemode-host-tools"
import { adaptEvalResult } from "../tools/native-eval-result"

export const THREAD_CODEMODE_METADATA_KEY = "omoThread"

const LIST_GUIDANCE =
  "Thread tools address peer sessions, not child tasks. In Code Mode, call tools.thread_list() first and use the returned thread value, an alias, or a unique name. For thread_rename and thread_close, omit thread or pass self to act on this session. Leave all_scope unset unless the user asks to search every workspace. When mentioning a thread, use its returned link; if the client cannot open it, give the thread title and suggest /sessions."

function codeModeExamples(text: string): string {
  return text
    .replaceAll("(in an eval cell:", "(in Code Mode:")
    .replace(/\btool\.(thread_\w+)\(\) in an eval cell\b/g, "tools.$1() in Code Mode")
    .replace(/\btool\.(thread_\w+)\(\)/g, "tools.$1()")
}

function codeModeDescription(owned: OwnedEvalHostTool): string {
  if (owned.name !== "thread_list") return codeModeExamples(owned.description)
  const shared = THREAD_TOOL_METADATA.find(({ name }) => name === owned.name)
  return `${shared?.description ?? ""} ${LIST_GUIDANCE}`.trimStart()
}

function threadCodemodeTool(owned: OwnedEvalHostTool): Info {
  return {
    name: owned.name,
    description: codeModeDescription(owned),
    input: JSON.parse(
      JSON.stringify(owned.parameters, (key, value: unknown) =>
        key === "description" && typeof value === "string" ? codeModeExamples(value) : value,
      ),
    ) as Info["input"],
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
