import { runTaskOutput, type TaskManager, type TaskOutputInput } from "@oh-my-opencode/senpi-task/manager-kernel"
import { readEventLogTranscriptResult } from "@oh-my-opencode/orchestration-core/transcript/event-log"

/** Existing Native output operation with an explicit own-log-only reader. */
export function readOwnedTaskOutput(
  manager: TaskManager,
  stateDir: string,
  callerSessionID: string,
  input: TaskOutputInput,
) {
  return runTaskOutput(
    { manager, stateDir, transcriptReader: ({ stateDir, taskId }) => readEventLogTranscriptResult(stateDir, taskId) },
    input,
    callerSessionID,
  )
}
