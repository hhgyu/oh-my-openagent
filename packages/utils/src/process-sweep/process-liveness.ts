import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"

export interface PsResult {
  /** The exit code; null when `ps` could not run or did not finish (spawn error, timeout, signal). */
  readonly status: number | null
  readonly stdout: string
}

export type PsRunner = (args: readonly string[], signal: AbortSignal | undefined) => Promise<PsResult>

export interface ProcessLivenessOptions {
  readonly platform?: NodeJS.Platform
  readonly runPs?: PsRunner
  readonly signal?: AbortSignal
}

const PS_PROBE_TIMEOUT_MS = 5_000

/**
 * A zombie is dead: it already exited and only waits for its reaper (init or a subreaper) to collect its
 * status, which can take arbitrarily long. On POSIX `kill(pid, 0)` still succeeds for it, so the process
 * state decides: `/proc/<pid>/stat` on Linux, an abortable `ps` elsewhere. A `ps` that reports nothing
 * proves the process gone only when `kill(pid, 0)` then fails with ESRCH; any other failed observation
 * keeps the conservative answer, alive. Windows has no such state for this check: `kill(pid, 0)` fails
 * with ESRCH once the process stopped running, even while a handle keeps it around.
 */
export async function defaultIsProcessAlive(pid: number, options: ProcessLivenessOptions = {}): Promise<boolean> {
  if (!signalZeroFindsProcess(pid)) return false
  const platform = options.platform ?? process.platform
  if (platform === "win32") return true
  if (platform === "linux") return !isLinuxZombie(pid)
  return !(await isPosixZombie(pid, options))
}

async function isPosixZombie(pid: number, options: ProcessLivenessOptions): Promise<boolean> {
  options.signal?.throwIfAborted()
  const probe = options.runPs ?? runPsCommand
  const result = await probe(["-o", "stat=", "-p", String(pid)], options.signal)
  options.signal?.throwIfAborted()
  const state = result.stdout.trim()
  if (result.status === 0 && state !== "") return state.startsWith("Z")
  return !signalZeroFindsProcess(pid)
}

function signalZeroFindsProcess(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return "code" in error && error.code === "EPERM"
  }
}

function isLinuxZombie(pid: number): boolean {
  let stat: string
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8")
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined
    return code === "ENOENT" || code === "ESRCH"
  }
  // The command name in parentheses may contain spaces or parentheses; the state follows the last ")".
  const state = stat.charAt(stat.lastIndexOf(")") + 2)
  return state === "Z" || state === "X"
}

export function createPsRunner(executable: string): PsRunner {
  return (args, signal) => runPs(executable, args, signal)
}

const runPsCommand = createPsRunner("ps")

function runPs(executable: string, args: readonly string[], signal: AbortSignal | undefined): Promise<PsResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        killSignal: "SIGKILL",
        timeout: PS_PROBE_TIMEOUT_MS,
        windowsHide: true,
        ...(signal === undefined ? {} : { signal }),
      },
      (error, stdout) => {
        if (signal?.aborted === true) {
          // An abort reports before the killed child exits; settle only once it is gone.
          if (child.exitCode !== null || child.signalCode !== null) reject(signal.reason)
          else child.once("exit", () => reject(signal.reason))
          return
        }
        if (error === null) {
          resolve({ status: 0, stdout })
          return
        }
        resolve({ status: typeof error.code === "number" ? error.code : null, stdout })
      },
    )
  })
}
