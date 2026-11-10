import type { ExecutionMode, ManagedRunner, TaskManagerOptions } from "./types"

export class ExecutionModeUnavailable extends Error {
  readonly code = "execution_mode_unavailable"
  constructor(readonly mode: ExecutionMode) { super(`Execution mode ${mode} is unavailable on this host`) }
}
export interface ManagedRunnerPort {
  resolve(mode: ExecutionMode): ManagedRunner | undefined
  all(): readonly ManagedRunner[]
}
export function managedRunnerFor(options: Pick<TaskManagerOptions, "runners" | "runnerPort">, mode: ExecutionMode): ManagedRunner {
  const runner = options.runnerPort ? options.runnerPort.resolve(mode) : options.runners?.[mode]
  if (!runner || typeof runner.start !== "function") throw new ExecutionModeUnavailable(mode)
  return runner
}
export function managedRunners(options: Pick<TaskManagerOptions, "runners" | "runnerPort">): readonly ManagedRunner[] {
  return options.runnerPort ? options.runnerPort.all() : Object.values(options.runners ?? {})
}
