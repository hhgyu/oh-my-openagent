import { spawn, spawnSync } from "node:child_process"

import { withTelemetryOptOut } from "./telemetry-opt-out-env.mjs"

// Spawn options for a QA driver's senpi run that must be killable as a whole tree.
//
// POSIX runs lead their own process group, so the driver can signal the whole tree at once. On win32
// `detached` means DETACHED_PROCESS: the senpi launcher starts with no console at all, so its node and
// bun children each allocate a fresh, visible console window that takes the desktop focus. There the
// run stays attached and hidden (it inherits the driver's console) and the tree is taken with
// taskkill /T instead of a process-group signal. `posixDetached: false` keeps a POSIX run in the
// driver's own group for a caller whose cleanup decides that itself.
export function senpiRunSpawnOptions(platform = process.platform, posixDetached = true) {
  return { detached: platform !== "win32" && posixDetached, windowsHide: true }
}

// pkill does not exist on win32, so a killed senpi launcher there would leave its node and bun
// children running; taskkill /T takes the whole tree.
export function senpiTreeKill(pid, platform = process.platform) {
  return platform === "win32"
    ? { command: "taskkill", args: ["/T", "/F", "/PID", String(pid)] }
    : { command: "pkill", args: ["-9", "-P", String(pid)] }
}

// How long a tree stop may take before it counts as failed; the same 10 s grace memory-core gives a git
// it stops (GIT_KILL_GRACE_MS).
export const SENPI_TREE_STOP_DEADLINE_MS = 10_000

// The group kill for a run spawned with senpiRunSpawnOptions, for cleanup paths that cannot await. POSIX
// signals the run's process group exactly as `process.kill(-pid, signal)` does (and throws as it does, so
// callers keep their single-pid fallback). A win32 run is no group leader, so its tree is taken with
// taskkill /T /F, bounded by SENPI_TREE_STOP_DEADLINE_MS so a hung taskkill cannot hang the driver. A caller
// that must know the tree is gone uses stopSenpiRunTree instead.
export function killSenpiRunTree(pid, signal = "SIGKILL", platform = process.platform) {
  if (platform === "win32") {
    spawnSync("taskkill", senpiTreeKill(pid, platform).args, {
      stdio: "ignore",
      windowsHide: true,
      timeout: SENPI_TREE_STOP_DEADLINE_MS,
    })
    return
  }
  process.kill(-pid, signal)
}

export class SenpiRunTreeStopError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = "SenpiRunTreeStopError"
  }
}

const spawnTaskkill = (executable, args) =>
  spawn(executable, [...args], { stdio: "ignore", windowsHide: true, env: withTelemetryOptOut(process.env) })

/**
 * Ends a run's whole process tree and proves it, mirroring memory-core's createWindowsGitTreeStopper.
 * win32: `taskkill /T /F` bounded by `deadlineMs`, resolved only on exit code 0; a taskkill that cannot
 * start, exits nonzero, or misses the deadline (it is then killed) rejects with SenpiRunTreeStopError.
 * POSIX: SIGKILL to the run's process group; ESRCH (no process left in the group) counts as stopped.
 * Resolves with a description of what ended the tree.
 */
export function stopSenpiRunTree(
  pid,
  { deadlineMs = SENPI_TREE_STOP_DEADLINE_MS, platform = process.platform, spawnProcess = spawnTaskkill } = {},
) {
  if (platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL")
      return Promise.resolve(`SIGKILL to process group ${pid}`)
    } catch (error) {
      if (error?.code === "ESRCH") return Promise.resolve(`process group ${pid} already gone`)
      return Promise.reject(new SenpiRunTreeStopError(`process group ${pid} could not be signalled`, { cause: error }))
    }
  }
  return new Promise((resolve, reject) => {
    let finished = false
    let deadline
    const fail = (error) => {
      if (finished) return
      finished = true
      clearTimeout(deadline)
      reject(error)
    }
    let taskkill
    try {
      taskkill = spawnProcess("taskkill", senpiTreeKill(pid, platform).args)
    } catch (error) {
      fail(new SenpiRunTreeStopError(`taskkill could not start for pid ${pid}`, { cause: error }))
      return
    }
    deadline = setTimeout(() => {
      taskkill.kill("SIGKILL")
      fail(new SenpiRunTreeStopError(`taskkill did not finish within ${deadlineMs}ms for pid ${pid}`))
    }, deadlineMs)
    taskkill.once("error", (error) => {
      fail(new SenpiRunTreeStopError(`taskkill could not start for pid ${pid}`, { cause: error }))
    })
    taskkill.once("exit", (code, signal) => {
      if (code !== 0) {
        fail(
          new SenpiRunTreeStopError(
            `taskkill exited with ${code === null ? `signal ${signal}` : `code ${code}`} for pid ${pid}`,
          ),
        )
        return
      }
      if (finished) return
      finished = true
      clearTimeout(deadline)
      resolve(`taskkill /T /F ended pid ${pid} and its descendants`)
    })
  })
}
