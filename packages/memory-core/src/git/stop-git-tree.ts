import { spawnSync, type ChildProcess } from "node:child_process"
import { win32 } from "node:path"

import { GitError } from "./errors"

// On Windows `git` is the Git for Windows launcher (`cmd\git.exe`), which starts the real git as its own
// child; git then starts pack-objects, hooks and the like. Terminating the launcher alone leaves all of
// them running in the repository after the call has settled (measured: the real git and pack-objects
// kept a maintenance pass going for seconds), so a caller that removes or rewrites the repository on
// abort races them. Windows has no SIGTERM to forward anyway: a stop there ends the whole tree.

/** Ends a still-running git launcher and every process it started; rejects when that cannot be proven. */
export type GitTreeStopper = (child: ChildProcess, deadlineMs: number) => Promise<void>

export interface TaskkillResult {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly error?: Error
}

/** Runs taskkill to completion before returning, killing it once `timeoutMs` passes. */
export type TaskkillRunner = (executable: string, args: readonly string[], timeoutMs: number) => TaskkillResult

// taskkill's exit code when no running process has the given pid.
const TASKKILL_PROCESS_NOT_FOUND = 128

export class GitTreeStopError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "GitTreeStopError"
  }
}

function taskkillPath(environment: NodeJS.ProcessEnv): string {
  const root = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.windir
  return root === undefined || root.trim() === "" ? "taskkill.exe" : win32.join(root, "System32", "taskkill.exe")
}

const runTaskkill: TaskkillRunner = (executable, args, timeoutMs) =>
  spawnSync(executable, [...args], { stdio: "ignore", windowsHide: true, timeout: timeoutMs, killSignal: "SIGKILL" })

/** Whether the process with this pid is still running; asked only while its pid cannot be reused. */
export type ProcessRunningProbe = (pid: number) => boolean

// On Windows a zero signal asks for the exit status through a process handle: ESRCH once the process has exited,
// even before the event loop reaps it.
const isProcessRunning: ProcessRunningProbe = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

const hasEnded = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

/**
 * `taskkill /T /F` over the launcher's tree, bounded as a whole by `deadlineMs` (the caller's kill-grace
 * budget): taskkill and any wait for the launcher's exit afterwards share that one budget.
 * Resolves on exit code 0, and without any taskkill for a launcher that has already exited. A taskkill
 * that cannot start, fails, or outlives the deadline rejects with a GitTreeStopError; the launcher
 * itself is then killed so it cannot linger, but its descendants are not proven gone and the caller
 * must report that.
 */
export function createWindowsGitTreeStopper(
  environment: NodeJS.ProcessEnv = process.env,
  runProcess: TaskkillRunner = runTaskkill,
  isRunning: ProcessRunningProbe = isProcessRunning,
  now: () => number = Date.now,
): GitTreeStopper {
  return (child, deadlineMs) =>
    new Promise<void>((resolve, reject) => {
      const deadlineAt = now() + deadlineMs
      const pid = child.pid
      if (pid === undefined || pid <= 0) {
        reject(new GitTreeStopError("git has no process id to stop"))
        return
      }
      // A reaped launcher's pid is free for any new process to take.
      if (hasEnded(child)) {
        resolve()
        return
      }
      const fail = (error: GitTreeStopError) => {
        child.kill("SIGKILL")
        reject(error)
      }
      const settleOnLauncherEnd = (failure: GitTreeStopError) =>
        awaitLauncherEnd(child, Math.max(0, deadlineAt - now())).then((ended) => (ended ? resolve() : fail(failure)))
      // Not yet reaped, so the runtime still holds the launcher's handle and its pid is ours. A launcher that
      // exited on its own already waited for the git it started; only its exit event is still to come.
      if (!isRunning(pid)) {
        settleOnLauncherEnd(new GitTreeStopError(`git pid ${pid} exited, but its exit was never reported`))
        return
      }
      // taskkill finds its target by pid, hundreds of milliseconds after it starts. The runtime keeps the
      // launcher's process handle open, which keeps Windows from reusing the pid, until the event loop
      // reaps the launcher's exit. Running taskkill synchronously holds the loop, so even a launcher that
      // exits on its own meanwhile keeps its pid, and taskkill can never end an unrelated process tree.
      let result: TaskkillResult
      try {
        result = runProcess(taskkillPath(environment), ["/PID", String(pid), "/T", "/F"], deadlineMs)
      } catch (error) {
        fail(new GitTreeStopError(`taskkill could not start for git pid ${pid}`, { cause: error }))
        return
      }
      if (result.error !== undefined) {
        const timedOut = "code" in result.error && result.error.code === "ETIMEDOUT"
        fail(
          new GitTreeStopError(
            timedOut
              ? `taskkill did not finish within ${deadlineMs}ms for git pid ${pid}`
              : `taskkill could not start for git pid ${pid}`,
            { cause: result.error },
          ),
        )
        return
      }
      if (result.status === 0) {
        resolve()
        return
      }
      const failure = new GitTreeStopError(
        `taskkill exited with ${result.status === null ? `signal ${result.signal}` : `code ${result.status}`} for git pid ${pid}`,
      )
      if (result.status !== TASKKILL_PROCESS_NOT_FOUND) {
        fail(failure)
        return
      }
      // The pid was held, so "not found" means the launcher ended on its own before taskkill looked; its
      // exit is waiting in the event loop. Anything else within the deadline is a real failure.
      settleOnLauncherEnd(failure)
    })
}

function awaitLauncherEnd(child: ChildProcess, deadlineMs: number): Promise<boolean> {
  if (hasEnded(child)) return Promise.resolve(true)
  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      child.off("exit", onExit)
      resolve(false)
    }, deadlineMs)
    function onExit() {
      clearTimeout(deadline)
      resolve(true)
    }
    child.once("exit", onExit)
  })
}

/** A stopped git (abort or timeout) whose process tree could not be proven ended; descendants may still run. */
export class GitStopFailedError extends GitError {
  constructor(
    readonly argv: readonly string[],
    readonly stopReason: "aborted" | "timed out",
    options?: ErrorOptions,
  ) {
    const detail = options?.cause instanceof Error ? `: ${options.cause.message}` : ""
    super(`git ${argv.join(" ")} ${stopReason}, but its process tree could not be stopped${detail}`, options)
  }
}
