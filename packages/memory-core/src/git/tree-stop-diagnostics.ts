import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { GIT_TIMEOUT_DIAGNOSTICS_ENV } from "./timeout-diagnostics"

// DIAGNOSTIC ONLY (draft PR, never merged): records whether `taskkill /PID <pid> /T /F` can target a launcher
// that has already exited, or a process that reused its pid.

export interface TreeStopDiagnostic {
  readonly onTaskkillSpawned: (taskkill: ChildProcess) => void
}

function queryHolder(pid: number): Promise<string> {
  return new Promise((resolve) => {
    const query = spawn(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ForEach-Object { "$($_.Name)|$($_.ParentProcessId)|$($_.CreationDate.ToString('o'))" }`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    )
    let out = ""
    query.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")))
    query.stderr?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")))
    query.once("error", (error) => resolve(`query failed: ${error.message}`))
    query.once("close", () => resolve(out.trim() || "<no process holds this pid>"))
  })
}

export function startTreeStopDiagnostic(
  environment: NodeJS.ProcessEnv,
  child: ChildProcess,
  pid: number,
): TreeStopDiagnostic | undefined {
  const directory = environment[GIT_TIMEOUT_DIAGNOSTICS_ENV]
  if (!directory || process.platform !== "win32") return undefined
  const t0 = performance.now()
  const at = () => Math.round((performance.now() - t0) * 10) / 10
  const record: Record<string, unknown> = {
    at: new Date().toISOString(),
    nodePid: process.pid,
    pid,
    spawnfile: child.spawnfile,
    spawnargs: child.spawnargs.slice(0, 8),
    exitCodeAtStop: child.exitCode,
    signalCodeAtStop: child.signalCode,
  }
  const holderAtStop = queryHolder(pid)
  let launcherExit: { code: number | null; signal: string | null; atMs: number } | undefined
  if (child.exitCode === null && child.signalCode === null) {
    child.once("exit", (code, signal) => {
      launcherExit = { code, signal, atMs: at() }
    })
  }
  return {
    onTaskkillSpawned(taskkill) {
      record.taskkillSpawnedAtMs = at()
      let out = ""
      taskkill.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")))
      taskkill.stderr?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")))
      taskkill.once("close", async (code, signal) => {
        record.taskkill = { code, signal, atMs: at(), output: out.trim() }
        record.launcherExit = launcherExit ?? "not observed before taskkill closed"
        record.launcherExitedBeforeTaskkillClosed = launcherExit !== undefined
        const rootLine = new RegExp(`PID ${pid} \\(child process of PID (\\d+)\\)`).exec(out)
        record.killedRootParent = rootLine ? Number(rootLine[1]) : null
        // taskkill ended a process at our pid whose parent is not this process: the pid was reused.
        record.killedForeignProcess = rootLine !== null && Number(rootLine[1]) !== process.pid
        record.staleAtStop = record.exitCodeAtStop !== null || record.signalCodeAtStop !== null
        record.holderAtStop = await holderAtStop
        try {
          mkdirSync(directory, { recursive: true })
          writeFileSync(join(directory, `tree-stop-${pid}-${Date.now()}.json`), `${JSON.stringify(record, null, 2)}\n`)
        } catch (error) {
          process.stderr.write(`tree-stop diagnostic not written: ${String(error)}\n`)
        }
      })
    },
  }
}
