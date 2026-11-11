import type { OmoConfig, OmoTaskSettings } from "@oh-my-opencode/omo-config-core"
import { listActiveTeams, loadRuntimeState } from "@oh-my-opencode/team-core/team-state-store"
import { log } from "@oh-my-opencode/utils"
import type { TaskLifecycle } from "../../lifecycle"
import type { TaskManager } from "../../manager"
import { createTaskRecordStore, type PersistedTaskEvent, type StateDirConfig } from "../../store"
import type { ResolveAncestry } from "../../tools/task"
import type { ActiveTeamSummary, TeamToolsService } from "../../tools/team/types"
import {
  TEAM_LEAD_SENTINEL,
  claimTeamTask,
  createTeam,
  createTeamTask,
  deleteTeam,
  getTeamTask,
  listTeamTasks,
  reconcileTeamMailboxOnSessionStart,
  refreshTeamMemberStatuses,
  requestShutdown,
  approveShutdown,
  rejectShutdown,
  resolveTeamRuntimeDirs,
  sendTeamMessage,
  teamStorageBaseDir,
  toTeamCoreConfig,
  updateTeamTaskStatus,
  type TeamCoreConfig,
  type TeamMemberExtensionConfig,
} from "../index"
import {
  buildMemberPorts,
  makeCancelMemberTask,
  makeShutdownMessenger,
  resolveTeamSpec,
} from "./support"

const CANONICAL_TEAM_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function assertCanonicalTeamRunId(teamRunId: string): void {
  if (!CANONICAL_TEAM_RUN_ID.test(teamRunId)) {
    throw new Error(`Team run id '${teamRunId}' must be a canonical lowercase UUID v4.`)
  }
}

// A member started as a detached process: it loads the member extension (`entryPath`) ahead of the
// inherited extensions, and receives its member identity through `memberEnv`.
type ProcessMemberLaunch = TeamMemberExtensionConfig & { readonly kind: "process" }

// A member started inside the host process: the start carries the member's task_send as a
// member-scoped tool for the host to bind, with no member extension and no member environment.
type InProcessMemberLaunch = { readonly kind: "in-process" }

/** How team members are started, discriminated by `kind`. */
export type TeamMemberLaunch = ProcessMemberLaunch | InProcessMemberLaunch

function memberLaunchDeps(launch: TeamMemberLaunch): { readonly memberExtension: TeamMemberExtensionConfig } | { readonly memberMode: "in-process" } {
  if (launch.kind === "in-process") return { memberMode: "in-process" }
  return {
    memberExtension: {
      entryPath: launch.entryPath,
      ...(launch.inheritedExtensions !== undefined ? { inheritedExtensions: launch.inheritedExtensions } : {}),
    },
  }
}

export interface TeamServiceDeps {
  readonly manager: TaskManager
  // Lifecycle single-writer destruction port; team deletion needs it for terminal-resident members
  // whose terminal `cancelTask` is an intentional noop.
  readonly destruction: Pick<TaskLifecycle, "destroyResidentTask">
  // The current session, read at every call: it is the team lead, and it scopes team ownership.
  readonly leadSessionId: () => string | undefined
  // How members are started, resolved once per team_create.
  readonly memberLaunch: () => TeamMemberLaunch
  readonly settings: OmoTaskSettings
  readonly omoConfig: OmoConfig
  readonly cwd: string
  readonly agentNames: ReadonlySet<string>
  // Resolve the current lead like the task tool does, including shared in-process child sessions.
  readonly resolveAncestry?: ResolveAncestry
  readonly appendTaskEvent?: (taskId: string, event: PersistedTaskEvent) => void
  readonly now?: () => number
  readonly newMessageId?: () => string
}

function stateDirConfig(deps: Pick<TeamServiceDeps, "cwd" | "settings">): StateDirConfig {
  return {
    project_dir: deps.cwd,
    ...(deps.settings.state_dir !== undefined ? { task: { state_dir: deps.settings.state_dir } } : {}),
  }
}

function createTaskEventAppender(stateDir: StateDirConfig): (taskId: string, event: PersistedTaskEvent) => void {
  const store = createTaskRecordStore(stateDir)
  return (taskId, event) => {
    try {
      store.appendEvent(taskId, event)
    } catch (error) {
      log("omo-senpi task event append failed", {
        taskId,
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

// The lead is ALWAYS the current session; there is no model-supplied override (dropped per W3-V F2 so
// the "current session IS lead" sentinel cannot be spoofed by a tool argument).
function requireLeadSession(deps: TeamServiceDeps): string {
  const leadSessionId = deps.leadSessionId()
  if (leadSessionId === undefined || leadSessionId.length === 0) {
    throw new Error("team tools require an active lead session; none was captured yet")
  }
  return leadSessionId
}

function toTeams(rows: Awaited<ReturnType<typeof listActiveTeams>>): readonly ActiveTeamSummary[] {
  return rows.map((row) => ({
    teamRunId: row.teamRunId,
    teamName: row.teamName,
    status: row.status,
    memberCount: row.memberCount,
    scope: row.scope,
    ...(row.leadSessionId !== undefined ? { leadSessionId: row.leadSessionId } : {}),
  }))
}

// Scoped team surfaces must behave like team_wait: a run id owned by another session is rejected,
// never answered with misleading data (task_list once returned "0 task(s)." for a foreign team).
// Headless/uncaptured sessions stay permissive, and unknown run ids fall through to the existing
// missing-state handling downstream.
async function assertOwnedTeam(deps: TeamServiceDeps, config: TeamCoreConfig, teamRunId: string): Promise<void> {
  const leadSessionId = deps.leadSessionId()
  if (leadSessionId === undefined) return
  const rows = await listActiveTeams(config)
  const owned = rows.find((row) => row.teamRunId === teamRunId)
  if (owned === undefined || owned.leadSessionId === undefined) return
  if (owned.leadSessionId !== leadSessionId) {
    throw new Error(`Team ${teamRunId} is not owned by the current session.`)
  }
}

export function createTeamService(deps: TeamServiceDeps): TeamToolsService {
  const stateDir = stateDirConfig(deps)
  const config: TeamCoreConfig = toTeamCoreConfig(deps.settings, teamStorageBaseDir(stateDir))
  const appendTaskEvent = deps.appendTaskEvent ?? createTaskEventAppender(stateDir)
  const ports = buildMemberPorts(deps.omoConfig, deps.agentNames)
  const omoTeams = deps.omoConfig.teams as Record<string, unknown> | undefined
  const runtimeDir = (teamRunId: string) => resolveTeamRuntimeDirs(stateDir, teamRunId).runtimeDir

  const service: TeamToolsService = {
    async createTeam(input) {
      const leadSessionId = requireLeadSession(deps)
      const ancestry = deps.resolveAncestry?.(leadSessionId)
      const { spec, source } = await resolveTeamSpec(input, ports, deps.cwd, omoTeams)
      return createTeam(spec, source, {
        manager: deps.manager,
        stateDir,
        taskSettings: deps.settings,
        leadSessionId,
        rootSessionId: ancestry?.rootSessionId ?? leadSessionId,
        spawnDepth: (ancestry?.depth ?? 0) + 1,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        ...memberLaunchDeps(deps.memberLaunch()),
      })
    },
    deleteTeam: async (input) => {
      assertCanonicalTeamRunId(input.teamRunId)
      await assertOwnedTeam(deps, config, input.teamRunId)
      return deleteTeam(input.teamRunId, {
        manager: deps.manager,
        destruction: deps.destruction,
        stateDir,
        taskSettings: deps.settings,
      })
    },
    sendMessage: async (teamRunId, input) => {
      await assertOwnedTeam(deps, config, teamRunId)
      const runtimeState = await loadRuntimeState(teamRunId, config)
      return sendTeamMessage(input, {
        teamRunId,
        stateDir,
        config,
        activeMembers: runtimeState.members.map((member) => member.name),
        appendEvent: appendTaskEvent,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        ...(deps.newMessageId !== undefined ? { newMessageId: deps.newMessageId } : {}),
      })
    },
    status: async (teamRunId) => {
      await assertOwnedTeam(deps, config, teamRunId)
      return refreshTeamMemberStatuses(teamRunId, { manager: deps.manager, config, runtimeDir: runtimeDir(teamRunId) })
    },
    listTeams: async () => toTeams(await listActiveTeams(config)),
    createTask: async (teamRunId, input) => {
      await assertOwnedTeam(deps, config, teamRunId)
      return createTeamTask({ teamRunId, config }, {
        subject: input.subject,
        description: input.description,
        status: input.status,
        ...(input.owner !== undefined ? { owner: input.owner } : {}),
        ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy } : {}),
      })
    },
    listTasks: async (teamRunId, filter) => {
      await assertOwnedTeam(deps, config, teamRunId)
      return listTeamTasks({ teamRunId, config }, filter)
    },
    updateTask: async (input) => {
      await assertOwnedTeam(deps, config, input.teamRunId)
      const ctx = { teamRunId: input.teamRunId, config }
      const owner = input.owner ?? TEAM_LEAD_SENTINEL
      return input.status === "claimed"
        ? claimTeamTask(ctx, input.taskId, owner)
        : updateTeamTaskStatus(ctx, input.taskId, input.status, owner)
    },
    getTask: async (teamRunId, taskId) => {
      await assertOwnedTeam(deps, config, teamRunId)
      return getTeamTask({ teamRunId, config }, taskId)
    },
    requestShutdown: async (teamRunId, member) => {
      await assertOwnedTeam(deps, config, teamRunId)
      return requestShutdown(teamRunId, member, {
        config,
        sendMessage: makeShutdownMessenger(deps.manager, stateDir, teamRunId),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      })
    },
    approveShutdown: async (teamRunId, member) => {
      await assertOwnedTeam(deps, config, teamRunId)
      return approveShutdown(teamRunId, member, {
        config,
        sendMessage: makeShutdownMessenger(deps.manager, stateDir, teamRunId),
        cancelMemberTask: makeCancelMemberTask(deps.manager, stateDir, teamRunId),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      })
    },
    rejectShutdown: async (teamRunId, member, reason) => {
      await assertOwnedTeam(deps, config, teamRunId)
      return rejectShutdown(teamRunId, member, reason, {
        config,
        sendMessage: makeShutdownMessenger(deps.manager, stateDir, teamRunId),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      })
    },
  }
  return service
}

/**
 * The component `session_start` mailbox reconciler bound to the same state dir + team-core config as the
 * live service: on process start it restores any delivery reservation left dangling by a crash back to
 * unread (across every active team run) so the on-revive injection fallback can redeliver it (W3-V F1a).
 */
export function createTeamMailboxReconciler(
  deps: Pick<TeamServiceDeps, "cwd" | "settings" | "leadSessionId">,
): () => Promise<void> {
  const stateDir = stateDirConfig(deps)
  const config: TeamCoreConfig = toTeamCoreConfig(deps.settings, teamStorageBaseDir(stateDir))
  return () => reconcileTeamMailboxOnSessionStart({
    stateDir,
    config,
    currentLeadSessionId: deps.leadSessionId(),
  })
}
