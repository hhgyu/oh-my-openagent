import { execFile, spawn, type ChildProcess } from "node:child_process"

export interface OwnedProcessOptions {
  readonly signal?: AbortSignal
  readonly platform?: NodeJS.Platform
  readonly termGraceMs?: number
  readonly reapWaitMs?: number
}

const DEFAULT_TERM_GRACE_MS = 1_000
const DEFAULT_REAP_WAIT_MS = 5_000
const TASKKILL_TIMEOUT_MS = 5_000
const MAX_STDOUT_BYTES = 16 * 1024 * 1024

export const OWNED_PROCESS_STOP_BOUND_MS = TASKKILL_TIMEOUT_MS + DEFAULT_TERM_GRACE_MS + DEFAULT_REAP_WAIT_MS + 1_000

/**
 * Runs a command whose whole process tree belongs to the caller. An abort stops that tree within a bound:
 * on POSIX the child leads its own process group, which gets SIGTERM, then SIGKILL after the grace (always,
 * so a descendant that outlived the child goes too); on Windows `taskkill /T /F` ends the tree at once.
 * The promise settles only after the forced kill had its chance to be reaped, and never later than the bound.
 */
export function runOwnedProcess(
  command: string,
  args: readonly string[],
  options: OwnedProcessOptions = {},
): Promise<string> {
  const { signal } = options
  if (signal?.aborted === true) return Promise.reject(abortError(signal))
  const platform = options.platform ?? process.platform
  return new Promise((resolvePromise, reject) => {
    let aborted = false
    let finished = false
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: platform !== "win32",
    })
    const finish = (settle: () => void): void => {
      if (finished) return
      finished = true
      signal?.removeEventListener("abort", onAbort)
      if (!aborted) settle()
    }
    const onAbort = (): void => {
      if (finished) return
      aborted = true
      void stopOwnedTree(child, platform, options).then(() => reject(abortError(signal)))
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        child.kill()
        finish(() => reject(new Error(`${command} wrote more than ${MAX_STDOUT_BYTES} bytes`)))
        return
      }
      stdout.push(chunk)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk)
    })
    child.once("error", (error) => finish(() => reject(error)))
    child.once("close", (code, closeSignal) =>
      finish(() => {
        if (code === 0) resolvePromise(Buffer.concat(stdout).toString("utf8"))
        else
          reject(
            new Error(
              `${command} exited ${code ?? closeSignal}: ${Buffer.concat(stderr).toString("utf8").trim().slice(-2000)}`,
            ),
          )
      }),
    )
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

async function stopOwnedTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
  options: OwnedProcessOptions,
): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  const exit = exited(child)
    ? Promise.resolve(true)
    : new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)))
  const reapWaitMs = options.reapWaitMs ?? DEFAULT_REAP_WAIT_MS
  if (platform === "win32") {
    if (!exited(child)) await taskkillTree(pid)
    if (!exited(child)) child.kill()
    await within(exit, reapWaitMs)
    return
  }
  signalGroup(pid, "SIGTERM")
  await within(exit, options.termGraceMs ?? DEFAULT_TERM_GRACE_MS)
  signalGroup(pid, "SIGKILL")
  await within(exit, reapWaitMs)
}

function taskkillTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS },
      () => resolve(),
    )
  })
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    // ESRCH: the group is already gone.
    return
  }
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function within(work: Promise<boolean>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    work,
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason
  return reason instanceof Error
    ? reason
    : Object.assign(new Error("The operation was aborted"), { name: "AbortError" })
}

/**
 * Waits for `work`, but once `signal` aborts gives it at most `boundMs` more: owned processes stop within
 * that bound through their own signal, and a promise that ignores the abort is no longer waited for.
 */
export function settleWithinAbortBound<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  boundMs: number,
): Promise<T> {
  if (signal === undefined) return work
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      timer = setTimeout(() => reject(abortError(signal)), boundMs)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
    }
    work.then(
      (value) => {
        done()
        resolve(value)
      },
      (error: unknown) => {
        done()
        reject(error)
      },
    )
  })
}
