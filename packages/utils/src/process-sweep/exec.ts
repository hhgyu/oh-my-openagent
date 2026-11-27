import { runOwnedProcess } from "./owned-process"
import { defaultIsProcessAlive } from "./process-liveness"
import { parsePosixProcessTable, parseWindowsProcessTable, type ProcessInfo } from "./process-table"

export interface ProcessKiller {
  readonly isAlive: (pid: number, signal?: AbortSignal) => boolean | Promise<boolean>
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

function isAliveWithin(pid: number, signal?: AbortSignal): Promise<boolean> {
  return defaultIsProcessAlive(pid, signal === undefined ? {} : { signal })
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
    isAlive: isAliveWithin,
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
    isAlive: isAliveWithin,
    kill: (pid, signal) => taskkill(["/PID", String(pid), "/T", "/F"], signal),
    terminate: (pid, signal) => taskkill(["/PID", String(pid), "/T"], signal),
  }
}

function taskkill(args: readonly string[], signal: AbortSignal | undefined): Promise<void> {
  return runOwnedProcess("taskkill.exe", args, signal === undefined ? {} : { signal }).then(() => undefined)
}
