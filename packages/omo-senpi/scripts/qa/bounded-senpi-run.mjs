// One bounded senpi launch for the live drivers. `spawnSync`'s timeout signals only the process it
// started: on Windows that is the package-manager shim (`senpi.exe` -> node -> bun), so a run past its
// budget left the engine alive in the sandbox, holding it open, and the driver's own cleanup failed with
// EPERM. This launch owns the whole tree: its own process group on POSIX, taskkill /T on Windows. A run
// past its budget is stopped through stopSenpiRunTree, which proves the stop or fails it explicitly, and
// every wait after that is bounded, so the launch always resolves and says what happened to the tree.
import { execFileSync, spawn } from "node:child_process"

import { SENPI_TREE_STOP_DEADLINE_MS, senpiRunSpawnOptions, stopSenpiRunTree } from "./senpi-run-spawn.mjs"
import { withTelemetryOptOut } from "./telemetry-opt-out-env.mjs"

// After a proven tree stop, how long the launch's stdio may stay open before it is destroyed.
const POST_STOP_DRAIN_MS = 2_000

// Windows keeps a dead parent's pid in its children's ParentProcessId, so a shim that already exited still
// names the engine it left behind. Bounded and checked: a failed lookup throws.
function windowsChildren(pid) {
  return execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { $_.ProcessId }`,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: SENPI_TREE_STOP_DEADLINE_MS,
      env: withTelemetryOptOut(process.env),
    },
  )
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((child) => Number.isInteger(child) && child > 0)
}

async function stopTree(child, platform, stopTreeOf) {
  const shimAlive = child.exitCode === null && child.signalCode === null
  const roots = platform !== "win32" || shimAlive ? [child.pid] : windowsChildren(child.pid)
  const details = []
  for (const pid of roots) details.push(await stopTreeOf(pid, { platform }))
  return details.length === 0 ? "no live tree left to stop" : details.join("; ")
}

/**
 * Resolves `{ status, signal, stdout, stderr, timedOut, treeStop }`. Within the budget it resolves when the
 * launch's stdio closes. Past it, `status` is null, `timedOut` true, and the tree is stopped: `treeStop` is
 * `{ ok: true, detail }` once the stop is proven and stdio has closed (or the bounded drain after the stop
 * ran out, then `detail` says so), and `{ ok: false, detail }` when the stop failed (the result says which
 * descendants may still be alive). Every wait is bounded by `timeoutMs` plus the stop deadline and drain.
 */
export function runBoundedSenpi(
  file,
  args,
  { cwd, env, timeoutMs, platform = process.platform, stopTreeOf = stopSenpiRunTree },
) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      ...senpiRunSpawnOptions(platform),
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let treeStop
    let settled = false
    let drain
    let closed
    const finish = (status, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(drain)
      resolve({ status: timedOut ? null : status, signal, stdout, stderr, timedOut, treeStop })
    }
    const abandonStdio = (status, signal) => {
      child.stdout.destroy()
      child.stderr.destroy()
      finish(status, signal)
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      timedOut = true
      stopTree(child, platform, stopTreeOf).then(
        (detail) => {
          treeStop = { ok: true, detail }
          if (closed !== undefined) {
            finish(closed.status, closed.signal)
            return
          }
          drain = setTimeout(() => {
            treeStop = { ok: true, detail: `${detail}; stdio still open ${POST_STOP_DRAIN_MS}ms after the stop` }
            abandonStdio(null, null)
          }, POST_STOP_DRAIN_MS)
        },
        (error) => {
          treeStop = {
            ok: false,
            detail: `tree stop FAILED, descendants may still be alive: ${error instanceof Error ? error.message : String(error)}`,
          }
          abandonStdio(null, null)
        },
      )
    }, timeoutMs)
    child.once("error", (error) => {
      stderr += `\n[spawn error] ${error.message}`
      finish(null, null)
    })
    child.once("close", (status, signal) => {
      closed = { status, signal }
      // A timed-out launch settles only once its stop has resolved: the stop's outcome is part of the result.
      if (timedOut && treeStop === undefined) return
      finish(status, signal)
    })
  })
}
