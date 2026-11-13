import { createToolArgumentValidator } from "@oh-my-opencode/senpi-task/task-operations"
import {
  TeamCreateParams,
  TeamDeleteParams,
  TeamTaskCreateParams,
  TeamTaskGetParams,
  TeamTaskListParams,
  TeamTaskUpdateParams,
} from "@oh-my-opencode/senpi-task/team-operations"
import type { ListedTool } from "../host/tool-registry"
import { issueToolValueCodec, type ToolCodecAssociation } from "../host/tool-value-codec"

/** Canonical Native lead team INPUT schemas; no lead team tool declares an output schema. */
export const nativeTeamInputSchemas = Object.freeze({
  team_create: TeamCreateParams,
  team_delete: TeamDeleteParams,
  task_create: TeamTaskCreateParams,
  task_list: TeamTaskListParams,
  task_get: TeamTaskGetParams,
  task_update: TeamTaskUpdateParams,
})
export type NativeTeamToolName = keyof typeof nativeTeamInputSchemas
/** The 6 Native lead team tool names, in the order `buildLeadTeamTools` composes them. */
export const NATIVE_TEAM_TOOL_NAMES: readonly NativeTeamToolName[] = Object.freeze([
  "team_create",
  "team_delete",
  "task_create",
  "task_get",
  "task_list",
  "task_update",
])

export function isNativeTeamToolName(name: string): name is NativeTeamToolName {
  return (NATIVE_TEAM_TOOL_NAMES as readonly string[]).includes(name)
}

/** Trusted assembly only, before registry cloning. The issued strict decoder checks and returns its
 * ORIGINAL input value; lead team inputs need no argument normalizer. */
export function issueNativeTeamCodec(tool: ListedTool, name: NativeTeamToolName): ToolCodecAssociation {
  const schema = nativeTeamInputSchemas[name]
  if (!schema || (tool.input as unknown) !== schema)
    throw Error("Native team input schema does not match tool definition")
  const input = issueToolValueCodec(tool, "input", { schema, decodeUnknown: createToolArgumentValidator(schema) })
  return Object.freeze({ tool, input })
}
