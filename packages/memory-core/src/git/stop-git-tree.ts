import { spawn, type ChildProcess } from "node:child_process"
import { win32 } from "node:path"

import { GitError } from "./errors"
import { startTreeStopDiagnostic } from "./tree-stop-diagnostics"

// On Windows `git` is the Git for Windows launcher (`cmd\git.exe`), which starts the real git as its own
// child; git then starts pack-objects, hooks and the like. Terminating the launcher alone leaves all of
// them running in the repository after the call has settled (measured: the real git and pack-objects
// kept a maintenance pass going for seconds), so a caller that removes or rewrites the repository on
// abort races them. Windows has no SIGTERM to forward anyway: a stop there ends the whole tree.

/** Ends a still-running git launcher and every process it started; rejects when that cannot be proven. */
export type GitTreeStopper = (child: ChildProcess, deadlineMs: number) => Promise<void>

export type TaskkillSpawner = (executable: string, args: readonly string[]) => ChildProcess

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

const spawnTaskkill: TaskkillSpawner = (executable, args) =>
  spawn(executable, [...args], { stdio: "ignore", windowsHide: true })

/**
 * `taskkill /T /F` over the launcher's tree, bounded by `deadlineMs` (the caller's kill-grace budget).
 * Resolves only on exit code 0. A taskkill that cannot start, exits nonzero, or outlives the deadline
 * rejects with a GitTreeStopError; the launcher itself is then killed so it cannot linger, but its
 * descendants are not proven gone and the caller must report that.
 */
export function createWindowsGitTreeStopper(
  environment: NodeJS.ProcessEnv = process.env,
  spawnProcess: TaskkillSpawner = spawnTaskkill,
): GitTreeStopper {
  return (child, deadlineMs) =>
    new Promise<void>((resolve, reject) => {
      const pid = child.pid
      if (pid === undefined) {
        reject(new GitTreeStopError("git has no process id to stop"))
        return
      }
      let finished = false
      let deadline: ReturnType<typeof setTimeout> | undefined
      const fail = (error: GitTreeStopError) => {
        if (finished) return
        finished = true
        clearTimeout(deadline)
        child.kill("SIGKILL")
        reject(error)
      }
      let taskkill: ChildProcess
      const diagnostic = startTreeStopDiagnostic(environment, child, pid)
      try {
        taskkill =
          diagnostic === undefined
            ? spawnProcess(taskkillPath(environment), ["/PID", String(pid), "/T", "/F"])
            : spawn(taskkillPath(environment), ["/PID", String(pid), "/T", "/F"], {
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
              })
        diagnostic?.onTaskkillSpawned(taskkill)
      } catch (error) {
        fail(new GitTreeStopError(`taskkill could not start for git pid ${pid}`, { cause: error }))
        return
      }
      deadline = setTimeout(() => {
        taskkill.kill("SIGKILL")
        fail(new GitTreeStopError(`taskkill did not finish within ${deadlineMs}ms for git pid ${pid}`))
      }, deadlineMs)
      taskkill.once("error", (error) => {
        fail(new GitTreeStopError(`taskkill could not start for git pid ${pid}`, { cause: error }))
      })
      taskkill.once("exit", (code, signal) => {
        if (code === 0) {
          if (finished) return
          finished = true
          clearTimeout(deadline)
          resolve()
          return
        }
        fail(
          new GitTreeStopError(
            `taskkill exited with ${code === null ? `signal ${signal}` : `code ${code}`} for git pid ${pid}`,
          ),
        )
      })
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
