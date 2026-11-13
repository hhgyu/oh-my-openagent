// Git repo helpers shared by the memory commands: construction with the host's
// hook checker, raw read-only git, and formatting.

import { join } from "node:path"

import { existsSync } from "../fs/resilient"
import { GitMemoryRepo, createNodeGitExec, installHooks, type GitExec, type GitExecResult } from "../index"

import type { MemoryCommandDeps, MemoryCommandIdentity } from "./types"

const RAW_GIT_TIMEOUT_MS = 30_000

type RepoDeps = Pick<MemoryCommandDeps, "exec" | "hookChecker">

export function openRepo(deps: RepoDeps, identity: MemoryCommandIdentity): GitMemoryRepo {
  const hookChecker = deps.hookChecker
  return new GitMemoryRepo({
    dir: identity.identityPaths.repo,
    agentId: identity.identity,
    // installHooks returns the installed hook list; the repo option expects void.
    ...(hookChecker === undefined
      ? {}
      : {
          installHooks: (dir: string) => {
            installHooks(dir, { checker: hookChecker() })
          },
        }),
    ...(deps.exec === undefined ? {} : { exec: deps.exec }),
  })
}

/** Raw git for read-only queries GitMemoryRepo does not expose (diff, worktree list). */
export function runGit(
  deps: Pick<MemoryCommandDeps, "exec">,
  dir: string,
  argv: readonly string[],
): Promise<GitExecResult> {
  const exec: GitExec = deps.exec ?? createNodeGitExec()
  return exec.run(argv, {
    cwd: dir,
    timeoutMs: RAW_GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  })
}

export function shortSha(sha: string): string {
  return sha.slice(0, 8)
}

/** True only when an initialized git repo exists; shelling out otherwise throws ENOENT. */
export function hasGitRepo(identity: MemoryCommandIdentity): boolean {
  return existsSync(join(identity.identityPaths.repo, ".git"))
}
