// One entry point per host-neutral command name, so a harness registers the whole table in a loop.

import { runAgreementsCommand } from "./agreements"
import { runFactsCommand } from "./facts"
import { runInitCommand } from "./init"
import { runMemfsCommand } from "./memfs"
import { runMemoryViewCommand } from "./memory"
import { runMemoryRepositoryCommand } from "./memory-repository"
import type { CoreMemoryCommandName } from "./metadata"
import { runRecompileCommand } from "./recompile"
import { runRememberCommand } from "./remember"
import { runSearchCommand } from "./search"
import type { MemoryCommandContext, MemoryCommandDeps } from "./types"

type CoreCommandRunner = (deps: MemoryCommandDeps, args: string, ctx: MemoryCommandContext) => Promise<string>

const RUNNERS: Readonly<Record<CoreMemoryCommandName, CoreCommandRunner>> = {
  memory: runMemoryViewCommand,
  memfs: runMemfsCommand,
  remember: runRememberCommand,
  init: runInitCommand,
  recompile: runRecompileCommand,
  "memory-repository": runMemoryRepositoryCommand,
  search: runSearchCommand,
  facts: runFactsCommand,
  agreements: runAgreementsCommand,
}

export function runCoreMemoryCommand(
  name: CoreMemoryCommandName,
  deps: MemoryCommandDeps,
  args: string,
  ctx: MemoryCommandContext,
): Promise<string> {
  return RUNNERS[name](deps, args, ctx)
}
