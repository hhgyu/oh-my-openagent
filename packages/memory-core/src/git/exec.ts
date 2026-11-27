import { spawn, type ChildProcess } from "node:child_process"
import { existsSync } from "../fs/resilient"
import { win32 } from "node:path"
import { GitAbortedError, GitNotFoundError, GitStopFailedError, GitTimeoutError } from "./errors"
import { describeStdinError, GIT_EXIT_DRAIN_MS, GIT_KILL_GRACE_MS } from "./exec-constants"
import { memoryGitEnvironment } from "./exec-environment"
import { spawnGitWithSignalStop } from "./exec-signal-stop"
import { holdGitActivityShared } from "./git-activity-lock"
import { createWindowsGitTreeStopper, GitTreeStopError, type GitTreeStopper } from "./stop-git-tree"
import { recordGitTimeout } from "./timeout-diagnostics"
import { publishVolumeSnapshotEvidence } from "./volume-snapshot-diagnostics"

export interface GitExecOptions {
  cwd: string
  timeoutMs: number
  env?: NodeJS.ProcessEnv
  stdin?: string | Buffer
  /** Stops the git process (SIGTERM, so git removes its own lock and temp files) and rejects. */
  signal?: AbortSignal
  /** After a timeout's SIGTERM, how long git gets to exit before SIGKILL (default GIT_KILL_GRACE_MS). */
  killGraceMs?: number
  /** After git exits normally, how long to wait for its pipes to close (default GIT_EXIT_DRAIN_MS). */
  exitDrainMs?: number
}

export { GIT_EXIT_DRAIN_MS, GIT_KILL_GRACE_MS } from "./exec-constants"

export interface GitExecResult {
  code: number
  stdout: string
  stderr: string
  /** Raw stdout for byte-framed output (`git cat-file --batch`); injected execs may omit it. */
  stdoutBytes?: Buffer
  /** How the child ended, so a silent non-zero exit can be told apart from an external kill (#11943). */
  termination?: GitTermination
}

export interface GitTermination {
  readonly signal: NodeJS.Signals | null
  readonly elapsedMs: number
}

export interface GitExec {
  run(argv: readonly string[], options: GitExecOptions): Promise<GitExecResult>
}

export interface NodeGitExecRuntime {
  platform?: NodeJS.Platform
  /** How a stopped git's process tree is ended; defaults to taskkill on win32 and none (SIGTERM to git) elsewhere. */
  treeStopper?: GitTreeStopper
  /** Observes each spawned git child once every exec listener is attached (tests order events against it). */
  onSpawn?: (child: ChildProcess) => void
  runCommand?: (
    executable: string,
    argv: readonly string[],
    options: GitExecOptions,
    environment: NodeJS.ProcessEnv,
  ) => Promise<GitExecResult>
}

const WINDOWS_GIT_CANDIDATES = [
  ["ProgramFiles", ["Git", "cmd", "git.exe"]],
  ["ProgramW6432", ["Git", "cmd", "git.exe"]],
  ["ProgramFiles(x86)", ["Git", "cmd", "git.exe"]],
  ["LOCALAPPDATA", ["Programs", "Git", "cmd", "git.exe"]],
] as const

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() !== name.toLowerCase() || value === undefined) continue
    const trimmed = value.trim()
    if (trimmed.length > 0) return trimmed
  }
  return undefined
}

function windowsGitExecutables(environment: NodeJS.ProcessEnv): string[] {
  const seen = new Set<string>()
  const candidates: string[] = []

  for (const [environmentName, pathParts] of WINDOWS_GIT_CANDIDATES) {
    const root = environmentValue(environment, environmentName)
    if (root === undefined || !/^[A-Za-z]:[\\/]/.test(root)) continue

    const candidate = win32.join(root, ...pathParts)
    const normalizedCandidate = win32.normalize(candidate).toLowerCase()
    if (seen.has(normalizedCandidate)) continue
    seen.add(normalizedCandidate)
    candidates.push(candidate)
  }

  return candidates
}

function isGitNotFoundFromEnoent(error: unknown): error is GitNotFoundError {
  if (!(error instanceof GitNotFoundError) || !(error.cause instanceof Error)) return false
  return (error.cause as NodeJS.ErrnoException).code === "ENOENT"
}

async function runGitCommand(
  executable: string,
  argv: readonly string[],
  options: GitExecOptions,
  environment: NodeJS.ProcessEnv,
  hooks: GitChildHooks,
): Promise<GitExecResult> {
  const activity = await holdGitActivityShared(options.cwd)
  try {
    return hooks.treeStopper === undefined
      ? await spawnGitWithSignalStop(executable, argv, options, environment, activity?.fd, hooks.onSpawn)
      : await spawnGitWithTreeStop(executable, argv, options, environment, activity?.fd, {
          treeStopper: hooks.treeStopper,
          onSpawn: hooks.onSpawn,
        })
  } finally {
    await activity?.release()
  }
}

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
        child.stdout!.destroy()
        child.stderr!.destroy()
        settleWith(end)
      }, options.exitDrainMs ?? GIT_EXIT_DRAIN_MS)
    }
    /** Ends a git that is still running, with its whole process tree; bounded by the stopper's own deadline. */
    const stop = (): void => {
      if (exited !== undefined || treeStop !== "none") return
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

// Any index-reading command (`status`, `add`, `diff`), not only commit, starts the builtin fsmonitor
// daemon when a user's config enables it; the daemon then outlives git, holds the activity fd and
// keeps the repo busy (#10391). Command-line `-c` outranks every config file and reaches hooks too.
const NO_FSMONITOR = ["-c", "core.fsmonitor=false"] as const

export function createNodeGitExec(runtime: NodeGitExecRuntime = {}): GitExec {
  const platform = runtime.platform ?? process.platform
  const runCommand =
    runtime.runCommand ??
    ((executable: string, argv: readonly string[], options: GitExecOptions, environment: NodeJS.ProcessEnv) =>
      runGitCommand(executable, argv, options, environment, {
        treeStopper:
          runtime.treeStopper ?? (platform === "win32" ? createWindowsGitTreeStopper(environment) : undefined),
        onSpawn: runtime.onSpawn,
      }))

  return {
    async run(callerArgv, options) {
      const argv = [...NO_FSMONITOR, ...callerArgv]
      // Never the caller's raw environment: an inherited GIT_CONFIG_* or GIT_DIR would redirect this git (#12354).
      const environment = memoryGitEnvironment(options.env ?? process.env, platform)
      try {
        return await runCommand("git", argv, options, environment)
      } catch (error) {
        if (platform !== "win32" || !isGitNotFoundFromEnoent(error)) throw error

        for (const fallback of windowsGitExecutables(environment)) {
          try {
            return await runCommand(fallback, argv, options, environment)
          } catch (fallbackError) {
            if (isGitNotFoundFromEnoent(fallbackError)) continue
            throw fallbackError
          }
        }

        throw error
      }
    },
  }
}
