import { readFileSync } from "node:fs"

import { runOwnedProcess } from "./owned-process"
import { parsePosixProcessTable, parseWindowsProcessTable, type ProcessInfo } from "./process-table"

export interface ProcessKiller {
  readonly isAlive: (pid: number) => boolean | Promise<boolean>
  readonly kill: (pid: number, signal?: AbortSignal) => Promise<void>
  readonly terminate: (pid: number, signal?: AbortSignal) => Promise<void>
}

export function enumerateProcesses(
  platform: NodeJS.Platform = process.platform,
  signal?: AbortSignal,
): Promise<ProcessInfo[]> {
  return platform === "win32" ? enumerateWindowsProcesses(signal) : enumeratePosixProcesses(signal)
}

export function createDefaultProcessKiller(platform: NodeJS.Platform = process.platform): ProcessKiller {
  return platform === "win32" ? createWindowsKiller() : createPosixKiller()
}

/**
 * A zombie is dead: it already exited and only waits for its reaper (init or a subreaper) to collect its
 * status, which can take arbitrarily long. `kill(pid, 0)` still succeeds for it, so on Linux the
 * process state in `/proc/<pid>/stat` decides.
 */
export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return processKillErrorMeansAlive(error)
  }
  return process.platform !== "linux" || !isLinuxZombie(pid)
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

function enumeratePosixProcesses(signal: AbortSignal | undefined): Promise<ProcessInfo[]> {
  return runOwnedProcess("ps", ["-eo", "pid=,ppid=,command="], signal === undefined ? {} : { signal }).then(
    parsePosixProcessTable,
  )
}

function enumerateWindowsProcesses(signal: AbortSignal | undefined): Promise<ProcessInfo[]> {
  const command = [
    "Get-CimInstance Win32_Process",
    "Select-Object ProcessId,ParentProcessId,CommandLine",
    "ConvertTo-Json -Compress -Depth 2",
  ].join(" | ")
  return runOwnedProcess(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    signal === undefined ? {} : { signal },
  ).then(parseWindowsProcessTable)
}

function createPosixKiller(): ProcessKiller {
  return {
    isAlive: defaultIsProcessAlive,
    kill: (pid) => {
      process.kill(pid, "SIGKILL")
      return Promise.resolve()
    },
    terminate: (pid) => {
      process.kill(pid, "SIGTERM")
      return Promise.resolve()
    },
  }
}

function createWindowsKiller(): ProcessKiller {
  return {
    isAlive: defaultIsProcessAlive,
    kill: (pid, signal) => taskkill(["/PID", String(pid), "/T", "/F"], signal),
    terminate: (pid, signal) => taskkill(["/PID", String(pid), "/T"], signal),
  }
}

function taskkill(args: readonly string[], signal: AbortSignal | undefined): Promise<void> {
  return runOwnedProcess("taskkill.exe", args, signal === undefined ? {} : { signal }).then(() => undefined)
}

function processKillErrorMeansAlive(error: Error): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
  if (code === "ESRCH") return false
  if (code === "EPERM") return true
  return false
}
