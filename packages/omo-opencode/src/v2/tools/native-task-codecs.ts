import {
  TaskToolParams, TaskSendParams, TaskCancelParams, TaskOutputParams, normalizeTaskToolArguments, createToolArgumentValidator,
} from "@oh-my-opencode/senpi-task/task-operations"
import type { ListedTool } from "../host/tool-registry"
import { issueToolValueCodec, type ToolCodecAssociation } from "../host/tool-value-codec"
import { issueToolArgumentNormalizer, type ToolNormalizerAssociation } from "../host/tool-argument-normalizer"

/** Canonical Native INPUT schemas; no Native operation declares an output schema. */
export const nativeTaskInputSchemas = Object.freeze({
  task: TaskToolParams, task_send: TaskSendParams, task_cancel: TaskCancelParams, task_output: TaskOutputParams,
})
export type NativeTaskToolName = keyof typeof nativeTaskInputSchemas

/** Trusted assembly only, before registry cloning. Compilation and preparation stay
 * separate: the issued strict decoder checks and returns its ORIGINAL input value. */
export function issueNativeTaskCodecs(tool: ListedTool, name: NativeTaskToolName): {
  readonly codec: ToolCodecAssociation; readonly normalizer?: ToolNormalizerAssociation
} {
  const schema = nativeTaskInputSchemas[name]
  if (!schema || (tool.input as unknown) !== schema) throw Error("Native input schema does not match tool definition")
  const input = issueToolValueCodec(tool, "input", { schema, decodeUnknown: createToolArgumentValidator(schema) })
  const normalizer = name === "task" ? {
    tool, input: issueToolArgumentNormalizer(tool, { schema, normalizeUnknown: normalizeTaskToolArguments }),
  } : undefined
  return Object.freeze({ codec: Object.freeze({ tool, input }), ...(normalizer && { normalizer: Object.freeze(normalizer) }) })
}
