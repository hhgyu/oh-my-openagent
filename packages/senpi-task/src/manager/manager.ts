import { createTaskManagerImplementation, type ReattachingTaskManager } from "./manager-implementation"
import { prepareNativeTaskPlanning } from "./plan-warm"
import { createNativeTaskRecoveryRuntime, type TaskManagerImplOptions } from "./recovery-runtime"

export { START_REPORT_WINDOW_MS } from "./manager-implementation"

/** Native composition supplies the real engine preparation; callers keep the original surface. */
export function createTaskManager(options: TaskManagerImplOptions): ReattachingTaskManager {
  return createTaskManagerImplementation(options, {
    preparePlanning: prepareNativeTaskPlanning,
    createRecoveryRuntime: createNativeTaskRecoveryRuntime,
  })
}
