// Git repo helpers for the senpi-only memory commands. The implementation lives in memory-core;
// senpi always installs the hooks with the engine's own staged-commit checker.

import type { GitMemoryRepo } from "@oh-my-opencode/memory-core"
import { openRepo as openCoreRepo } from "@oh-my-opencode/memory-core/commands/repo"
import type { MemoryCommandIdentity } from "@oh-my-opencode/memory-core/commands/types"

import { senpiCommandDeps } from "./core-deps"
import type { MemoryCommandDeps } from "./types"

export function openRepo(deps: MemoryCommandDeps, identity: MemoryCommandIdentity): GitMemoryRepo {
  return openCoreRepo(senpiCommandDeps(deps), identity)
}
