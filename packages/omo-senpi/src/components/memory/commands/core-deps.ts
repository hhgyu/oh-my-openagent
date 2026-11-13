// Adapts senpi's command deps onto the host-neutral memory-core handlers: the memory git hooks run
// the staged-commit checker through the engine's supervisor entry, and a command that needs a model
// turn sends it as a senpi user message.

import type { MemoryCommandDeps as CoreMemoryCommandDeps } from "@oh-my-opencode/memory-core/commands"

import { memoryHookChecker } from "../worker/spawn-supervisor-support"
import type { MemoryCommandPort } from "./metadata"
import type { MemoryCommandDeps } from "./types"

export function senpiCommandDeps(
  deps: MemoryCommandDeps,
  pi?: Pick<MemoryCommandPort, "sendUserMessage">,
): CoreMemoryCommandDeps {
  return {
    ...deps,
    hookChecker: deps.hookChecker ?? memoryHookChecker,
    ...(pi === undefined
      ? {}
      : {
          sendUserMessage: (text: string) => {
            pi.sendUserMessage(text)
          },
        }),
  }
}
