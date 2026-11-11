// Team operations shared with explicit host adapters: the lead-side team service, its mailbox
// reconciler, the lead team tools and the lead poller, without the engine barrel.
export { createTeamService, createTeamMailboxReconciler } from "../../team/service/team-service"
export type { TeamMemberLaunch, TeamServiceDeps } from "../../team/service/team-service"
export { TEAM_LEAD_SENTINEL, createLeadPoller } from "../../team"
export { buildLeadTeamTools } from "./index"
// The operations behind the lead team tools `buildLeadTeamTools` composes, with their canonical input
// schemas, for host adapters that publish each tool under their own tool API.
export { TeamCreateParams, TeamDeleteParams, runTeamCreate, runTeamDelete } from "./lifecycle"
export {
  TeamTaskCreateParams,
  TeamTaskGetParams,
  TeamTaskListParams,
  TeamTaskUpdateParams,
  runTeamTaskCreate,
  runTeamTaskGet,
  runTeamTaskList,
  runTeamTaskUpdate,
} from "./tasks"
export type { TeamToolsService } from "./types"
// The team-core config and storage root a host adapter needs to read the same team state the
// service writes, without the engine barrel.
export { toTeamCoreConfig } from "../../team/runtime-config"
export { teamStorageBaseDir } from "../../team/storage"
