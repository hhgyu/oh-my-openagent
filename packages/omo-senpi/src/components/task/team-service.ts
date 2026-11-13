import {
  parseExtensionEntries,
  resolveMemberExtensionEntryPath,
  type TeamToolsService,
} from "@oh-my-opencode/senpi-task"
import {
  createTeamMailboxReconciler as createSharedTeamMailboxReconciler,
  createTeamService as createSharedTeamService,
  type TeamMemberLaunch,
  type TeamServiceDeps as SharedTeamServiceDeps,
} from "@oh-my-opencode/senpi-task/team-operations"

import type { TaskRuntimeContext } from "./runtime-context"

// The Senpi adapter over the shared team service: the lead is this session's captured runtime
// session, and members start as processes loading the Senpi member extension.
export interface TeamServiceDeps extends Omit<SharedTeamServiceDeps, "leadSessionId" | "memberLaunch"> {
  readonly runtime: TaskRuntimeContext
  // The session's package-aware inherited list, so a team member reproduces the same providers an
  // ordinary child gets (#8492). Absent, member launches fall back to the parent's argv entries.
  readonly resolveInheritedExtensions?: () => Promise<readonly string[]>
}

function toSharedDeps(deps: TeamServiceDeps): SharedTeamServiceDeps {
  const { runtime, resolveInheritedExtensions, ...shared } = deps
  const memberExtensionEntryPath = resolveMemberExtensionEntryPath()
  return {
    ...shared,
    leadSessionId: () => runtime.sessionId(),
    memberLaunch: (): TeamMemberLaunch => ({
      kind: "process",
      entryPath: memberExtensionEntryPath,
      inheritedExtensions: resolveInheritedExtensions ?? parseExtensionEntries(process.argv),
    }),
  }
}

export function createTeamService(deps: TeamServiceDeps): TeamToolsService {
  return createSharedTeamService(toSharedDeps(deps))
}

export function createTeamMailboxReconciler(deps: TeamServiceDeps): () => Promise<void> {
  return createSharedTeamMailboxReconciler({
    cwd: deps.cwd,
    settings: deps.settings,
    leadSessionId: () => deps.runtime.sessionId(),
  })
}
