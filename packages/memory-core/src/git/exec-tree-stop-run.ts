import { spawn, type ChildProcess } from "node:child_process"

import { existsSync } from "../fs/resilient"
import { GitAbortedError, GitNotFoundError, GitTimeoutError } from "./errors"
import { GIT_EXIT_DRAIN_MS, GIT_KILL_GRACE_MS, type GitExecOptions, type GitExecResult } from "./exec"
import { holdGitActivityShared } from "./git-activity-lock"
import { GitStopFailedError, GitTreeStopError, type GitTreeStopper } from "./stop-git-tree"
import { recordGitTimeout } from "./timeout-diagnostics"
import { publishVolumeSnapshotEvidence } from "./volume-snapshot-diagnostics"

// The git run used where a stopped git must be ended with its whole process tree (Windows, where `git` is a
// launcher that starts the real git; also any caller that injects a tree stopper). exec.ts loads this module
// only then, so every other host keeps running git exactly as before.

interface GitChildHooks {
  readonly treeStopper: GitTreeStopper | undefined
  readonly onSpawn: ((child: ChildProcess) => void) | undefined
}

type ChildEnd = { readonly code: number | null; readonly signal: NodeJS.Signals | null }

function spawnGitWithTreeStop(
  executable: string,
  argv: readonly string[],
  options: GitExecOptions,
  environment: NodeJS.ProcessEnv,
  activityFd: number | undefined,
  { treeStopper, onSpawn }: GitChildHooks & { readonly treeStopper: GitTreeStopper },
): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now()
    const hasStdin = options.stdin !== undefined
    const killGraceMs = options.killGraceMs ?? GIT_KILL_GRACE_MS
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
    const stdoutPipe = child.stdout
    const stderrPipe = child.stderr
    if (stdoutPipe === null || stderrPipe === null) {
      child.kill("SIGKILL")
      reject(new Error("git was spawned without stdout and stderr pipes"))
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    let timedOut = false
    let aborted = false
    let exitDrain: ReturnType<typeof setTimeout> | undefined
    let exited: ChildEnd | undefined
    let closed: ChildEnd | undefined
    // "none": no stop was needed. Once a stop starts, the call settles only after it has ended git's whole
    // process tree, or with GitStopFailedError when that could not be proven.
    let treeStop: "none" | "pending" | "done" | GitTreeStopError = "none"

    const finish = (outcome: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(exitDrain)
      options.signal?.removeEventListener("abort", onAbort)
      outcome()
    }
    const stoppedError = () => (aborted ? new GitAbortedError(argv) : new GitTimeoutError(argv, options.timeoutMs))
    const settleWith = (end: ChildEnd) =>
      finish(() => {
        if (aborted || timedOut) {
          reject(stoppedError())
          return
        }
        const stdoutBytes = Buffer.concat(stdout)
        resolve({
          code: end.code ?? 1,
          stdout: stdoutBytes.toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8") + describeStdinError(stdinError),
          stdoutBytes,
          termination: { signal: end.signal, elapsedMs: Date.now() - startedAt },
        })
      })
    // The one settlement path: every completion signal (exit, close, the drain, the tree stop) lands here.
    // Git has exited even while a hook it started still holds its stdout/stderr open, so `close` may never
    // come: a git that finished normally settles on `close`, or with what it wrote once the bounded drain
    // runs out. A stopped git settles only once its tree stop has finished.
    const advance = () => {
      if (settled || treeStop === "pending") return
      if (treeStop instanceof GitTreeStopError) {
        const cause = treeStop
        finish(() => reject(new GitStopFailedError(argv, aborted ? "aborted" : "timed out", { cause })))
        return
      }
      if (closed !== undefined) {
        settleWith(closed)
        return
      }
      if (exited === undefined) return
      if ((aborted || timedOut) && treeStop === "none") {
        settleWith(exited)
        return
      }
      const end = exited
      exitDrain ??= setTimeout(() => {
        // Still open past the drain: a hook child holds them. Destroy them so it cannot keep us.
        stdoutPipe.destroy()
        stderrPipe.destroy()
        settleWith(end)
      }, options.exitDrainMs ?? GIT_EXIT_DRAIN_MS)
    }
    /** Ends a git that is still running, with its whole process tree; bounded by the stopper's own deadline. */
    const stop = (): void => {
      if (exited !== undefined || child.exitCode !== null || child.signalCode !== null || treeStop !== "none") return
      treeStop = "pending"
      treeStopper(child, killGraceMs).then(
        () => {
          treeStop = "done"
          advance()
        },
        (error: unknown) => {
          treeStop =
            error instanceof GitTreeStopError
              ? error
              : new GitTreeStopError(error instanceof Error ? error.message : String(error), { cause: error })
          advance()
        },
      )
    }
    const timer = setTimeout(() => {
      timedOut = true
      const timeoutRecord = recordGitTimeout(environment, child.pid, argv, options.cwd, options.timeoutMs)
      stop()
      if (timeoutRecord !== undefined) void publishVolumeSnapshotEvidence(timeoutRecord)
    }, options.timeoutMs)
    // An abort before settlement always yields GitAbortedError, through the same close/drain settlement as any
    // exit, so a hook child still holding git's stdio keeps its bounded drain. A git that already exited is
    // never signalled: its pid may be reused.
    function onAbort() {
      aborted = true
      if (exited === undefined) stop()
    }
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener("abort", onAbort, { once: true })

    stdoutPipe.on("data", (chunk: Buffer) => stdout.push(chunk))
    stderrPipe.on("data", (chunk: Buffer) => stderr.push(chunk))
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
      finish(() => {
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
    })
    child.on("exit", (code, signal) => {
      exited = { code, signal }
      clearTimeout(timer)
      advance()
    })
    child.on("close", (code, signal) => {
      closed = { code, signal }
      advance()
    })
    onSpawn?.(child)
  })
}

/** One git run under the identity's git-activity lock, stopped through `hooks.treeStopper`. */
export async function runGitWithTreeStop(
  executable: string,
  argv: readonly string[],
  options: GitExecOptions,
  environment: NodeJS.ProcessEnv,
  hooks: GitChildHooks & { readonly treeStopper: GitTreeStopper },
): Promise<GitExecResult> {
  const activity = await holdGitActivityShared(options.cwd)
  try {
    return await spawnGitWithTreeStop(executable, argv, options, environment, activity?.fd, hooks)
  } finally {
    await activity?.release()
  }
}

function describeStdinError(error: NodeJS.ErrnoException | undefined): string {
  return error === undefined ? "" : `\nomo: git stdin was not fully delivered (${error.code ?? error.message})\n`
}
