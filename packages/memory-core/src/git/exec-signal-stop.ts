import { spawn, type ChildProcess } from "node:child_process"

import { existsSync } from "../fs/resilient"
import { GitAbortedError, GitNotFoundError, GitTimeoutError } from "./errors"
import type { GitExecOptions, GitExecResult } from "./exec"
import { describeStdinError, GIT_EXIT_DRAIN_MS, GIT_KILL_GRACE_MS } from "./exec-constants"
import { recordGitTimeout } from "./timeout-diagnostics"
import { publishVolumeSnapshotEvidence } from "./volume-snapshot-diagnostics"

// The git run used when no process-tree stopper is configured (POSIX): git is signalled directly, SIGTERM and
// then SIGKILL after the grace on timeout. This is the long-standing body, kept as it was: #127's settlement
// rewrite of this path made ubuntu shard 1 stall intermittently on CI even when it matched it by every test.

export function spawnGitWithSignalStop(
  executable: string,
  argv: readonly string[],
  options: GitExecOptions,
  environment: NodeJS.ProcessEnv,
  activityFd: number | undefined,
  onSpawn?: (child: ChildProcess) => void,
): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const hasStdin = options.stdin !== undefined
    // git.exe is a console-subsystem binary: without windowsHide every memory auto-commit and
    // sync allocates a fresh console window that Windows foregrounds, stealing the user's focus
    // (#8501). Inert on posix, load-bearing on win32 - do not drop it.
    const child = spawn(executable, [...argv], {
      cwd: options.cwd,
      env: environment,
      shell: false,
      // fd 3 carries the git-activity lock into git and every process it starts (omo #10322).
      stdio: [hasStdin ? "pipe" : "ignore", "pipe", "pipe", ...(activityFd === undefined ? [] : [activityFd])],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    let timedOut = false
    let exitDrain: ReturnType<typeof setTimeout> | undefined

    let killTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      const timeoutRecord = recordGitTimeout(environment, child.pid, argv, options.cwd, options.timeoutMs)
      child.kill("SIGTERM")
      killTimer = setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? GIT_KILL_GRACE_MS)
      if (timeoutRecord !== undefined) void publishVolumeSnapshotEvidence(timeoutRecord)
    }, options.timeoutMs)
    let aborted = false
    const onAbort = () => {
      aborted = true
      child.kill("SIGTERM")
    }
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener("abort", onAbort, { once: true })

    child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk))
    // An unlistened stdin 'error' would crash the process (#11129). EPIPE means git exited before
    // reading all of its stdin (a bad path, a held index.lock), which git's own exit code already
    // reports. Any other stdin error is recorded and reported in the result's stderr.
    let stdinError: NodeJS.ErrnoException | undefined
    const stdin = hasStdin ? child.stdin : null
    if (stdin) {
      stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") stdinError = error
      })
      stdin.end(options.stdin)
    }
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(exitDrain)
      options.signal?.removeEventListener("abort", onAbort)
      if (error.code === "ENOENT") {
        // spawn reports ENOENT for a missing cwd as much as for a missing git binary. A fresh
        // memory identity has no repo dir yet, and calling that "git not found on PATH" surfaced a
        // bogus extension error on every first session. Behave like git itself: report the absent
        // cwd as exit 128 so head() reads it as no-repo-yet, and reserve GitNotFoundError for a cwd
        // that exists while the binary genuinely cannot spawn.
        if (!existsSync(options.cwd)) {
          resolve({
            code: 128,
            stdout: "",
            stderr: `fatal: cannot change to '${options.cwd}': No such file or directory`,
          })
          return
        }
        reject(new GitNotFoundError({ cause: error }))
      } else reject(error)
    })
    const settleWithResult = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(exitDrain)
      options.signal?.removeEventListener("abort", onAbort)
      if (aborted) {
        reject(new GitAbortedError(argv))
        return
      }
      if (timedOut) {
        reject(new GitTimeoutError(argv, options.timeoutMs))
        return
      }
      const stdoutBytes = Buffer.concat(stdout)
      resolve({
        code: code ?? 1,
        stdout: stdoutBytes.toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8") + describeStdinError(stdinError),
        stdoutBytes,
        termination: { signal, elapsedMs: Date.now() - startedAt },
      })
    }
    // Git has exited even while a hook it started still holds its stdout/stderr open, so `close`
    // may never come. A stopped git (timeout or abort) settles at once; a git that finished
    // normally settles on `close`, or with what it wrote once the bounded drain runs out.
    child.on("exit", (code, signal) => {
      if (settled) return
      if (timedOut || aborted) {
        settled = true
        clearTimeout(timer)
        clearTimeout(killTimer)
        options.signal?.removeEventListener("abort", onAbort)
        reject(aborted ? new GitAbortedError(argv) : new GitTimeoutError(argv, options.timeoutMs))
        return
      }
      clearTimeout(timer)
      exitDrain = setTimeout(() => {
        // Still open past the drain: a hook child holds them. Destroy them so it cannot keep us.
        child.stdout!.destroy()
        child.stderr!.destroy()
        settleWithResult(code, signal)
      }, options.exitDrainMs ?? GIT_EXIT_DRAIN_MS)
    })
    child.on("close", (code, signal) => settleWithResult(code, signal))
    onSpawn?.(child)
  })
}
