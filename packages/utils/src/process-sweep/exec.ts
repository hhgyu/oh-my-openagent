import { execFile } from "node:child_process"

import { parsePosixProcessTable, parseWindowsProcessTable, type ProcessInfo } from "./process-table"

export interface ProcessKiller {
  readonly isAlive: (pid: number) => boolean | Promise<boolean>
  readonly kill: (pid: number) => Promise<void>
  readonly terminate: (pid: number) => Promise<void>
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

export function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (!(error instanceof Error)) throw error
    return processKillErrorMeansAlive(error)
  }
}

function enumeratePosixProcesses(signal: AbortSignal | undefined): Promise<ProcessInfo[]> {
  return execFileText("ps", ["-eo", "pid=,ppid=,command="], signal).then(parsePosixProcessTable)
}

function enumerateWindowsProcesses(signal: AbortSignal | undefined): Promise<ProcessInfo[]> {
  const command = [
    "Get-CimInstance Win32_Process",
    "Select-Object ProcessId,ParentProcessId,CommandLine",
    "ConvertTo-Json -Compress -Depth 2",
  ].join(" | ")
  return execFileText("powershell.exe", ["-NoProfile", "-Command", command], signal).then(parseWindowsProcessTable)
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
    kill: (pid) => execFileVoid("taskkill.exe", ["/PID", String(pid), "/T", "/F"]),
    terminate: (pid) => execFileVoid("taskkill.exe", ["/PID", String(pid), "/T"]),
  }
}

function execFileText(command: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      command,
      [...args],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...(signal === undefined ? {} : { signal }) },
      (error, stdout) => {
        if (error === null) {
          resolvePromise(stdout)
          return
        }
        // An abort reports before the killed child has exited; settle only once it is gone.
        if (signal?.aborted === true && child.pid !== undefined && child.exitCode === null && child.signalCode === null)
          child.once("exit", () => reject(error))
        else reject(error)
      },
    )
  })
}

function execFileVoid(command: string, args: readonly string[]): Promise<void> {
  return execFileText(command, args).then(() => undefined)
}

function processKillErrorMeansAlive(error: Error): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
  if (code === "ESRCH") return false
  if (code === "EPERM") return true
  return false
}
