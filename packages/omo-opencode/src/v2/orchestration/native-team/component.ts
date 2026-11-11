import type { ToolContext, ToolDomain } from "@opencode/plugin/promise/tool"
import type { TaskSendTeamRouting } from "@oh-my-opencode/senpi-task/task-operations"
import { TEAM_LEAD_SENTINEL, createTeamService, type TeamToolsService } from "@oh-my-opencode/senpi-task/team-operations"
import type { OmoConfig } from "@oh-my-opencode/omo-config-core"
import type { createToolKernel } from "../../host/tool-kernel"
import type { ToolRegistry } from "../../host/tool-registry"
import type { NativeTaskOperationCall } from "../../tools/native-task"
import { createNativeTeamBridge, type NativeTeamTargets } from "../../tools/native-team"
import { nativeTeamSettings } from "../native-task/component"
import type { NativeTaskTargetPermissionAssociation, createNativeTaskService } from "../native-task/service"

type Service = ReturnType<typeof createNativeTaskService>
type DefaultTeamRunIdResolution = Awaited<ReturnType<NonNullable<TaskSendTeamRouting["resolveDefaultTeamRunId"]>>>

/** The Native task component's shared owner, handed to the team component during its assembly. */
export interface NativeTeamHost {
  readonly tool: ToolDomain
  readonly directory: string
  readonly prepared: { readonly config: OmoConfig; readonly agents: Readonly<Record<string, unknown>> }
  readonly registry: ToolRegistry
  readonly kernel: ReturnType<typeof createToolKernel>
  readonly service: Service
  readonly assertCurrent: () => void
  /** Hands the team targets to the shared registry; resolves with their issued permissions once the
   * registry owns them together with the task targets. */
  register(targets: NativeTeamTargets): Promise<readonly NativeTaskTargetPermissionAssociation[]>
}

export interface NativeTeamComponent {
  readonly ready: Promise<void>
  /** Lead team routing for one root call's public `task_send`; undefined for a non-lead caller. */
  teamRouting(caller: Pick<ToolContext, "sessionID">, call: NativeTaskOperationCall): TaskSendTeamRouting | undefined
  close(): Promise<void>
}

/** A lead is a root session: the team tools and lead routing never act for an owned child. */
function isRootLead(sessionID: string, call: Pick<NativeTaskOperationCall, "resolveAncestry">): boolean {
  const ancestry = call.resolveAncestry(sessionID)
  return ancestry !== undefined && ancestry.rootSessionId === sessionID && ancestry.depth === 0
}

export function assertRootLead(sessionID: string, call: Pick<NativeTaskOperationCall, "resolveAncestry">): void {
  if (!isRootLead(sessionID, call)) throw Error("Team tools are available only to a root lead session")
}

/** The Native team service of ONE lead call, over that call's manager, ancestry and destruction port.
 * Members start in-process inside this call; team storage is the lead's own Native state directory. */
export function createLeadTeamService(host: Pick<NativeTeamHost, "directory" | "prepared">, leadSessionID: string, call: NativeTaskOperationCall): TeamToolsService {
  assertRootLead(leadSessionID, call)
  return createTeamService({
    manager: call.manager,
    destruction: call.operation.destruction,
    leadSessionId: () => leadSessionID,
    memberLaunch: () => ({ kind: "in-process" }),
    settings: nativeTeamSettings(host.directory, leadSessionID, host.prepared.config),
    omoConfig: host.prepared.config,
    cwd: host.directory,
    agentNames: new Set(Object.keys(host.prepared.agents)),
    resolveAncestry: call.resolveAncestry,
  })
}

/** The Native single-owned-team default for a lead message that names no team run. */
export async function resolveOwnedTeamRunId(service: Pick<TeamToolsService, "listTeams">, leadSessionID: string): Promise<DefaultTeamRunIdResolution> {
  const owned = (await service.listTeams()).filter(team => team.leadSessionId === leadSessionID)
  const only = owned[0]
  if (owned.length === 1 && only !== undefined) return { kind: "resolved", teamRunId: only.teamRunId }
  if (owned.length === 0) return { kind: "none" }
  const listed = owned.map(team => `${team.teamRunId} ('${team.teamName}')`).join(", ")
  return { kind: "ambiguous", reason: `Multiple teams are owned by the current session: ${listed}. Pass team_run_id.` }
}

/** Publishes the 6 Native lead team tools over the Native task component's SAME registry, kernel and
 * service. Every call runs inside that service's per-call operation, so member starts use THAT
 * call's host authority; no authority is stored for later initiations. */
export function registerNativeTeamComponent(host: NativeTeamHost): NativeTeamComponent {
  const bridge = createNativeTeamBridge({
    tool: host.tool,
    async rollbackAcquisition() { await host.service.close() },
    async acquire(targets) {
      host.assertCurrent()
      const targetPermissions = await host.register(targets)
      host.assertCurrent()
      return { registry: host.registry, kernel: host.kernel, service: host.service, targetPermissions,
        teamService: (caller, call) => createLeadTeamService(host, caller.sessionID, call),
        // The registry, scopes and service are released by the Native task component.
        async release() {} }
    },
  })
  return Object.freeze({
    ready: bridge.ready,
    teamRouting(caller: Pick<ToolContext, "sessionID">, call: NativeTaskOperationCall): TaskSendTeamRouting | undefined {
      if (!isRootLead(caller.sessionID, call)) return undefined
      const service = createLeadTeamService(host, caller.sessionID, call)
      return { service, from: TEAM_LEAD_SENTINEL, resolveDefaultTeamRunId: () => resolveOwnedTeamRunId(service, caller.sessionID) }
    },
    close: () => bridge.close(),
  })
}
