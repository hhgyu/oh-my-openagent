// One bounded senpi launch for the live drivers. `spawnSync`'s timeout signals only the process it
// started: on Windows that is the package-manager shim (`senpi.exe` -> node -> bun), so a run past its
// budget left the engine alive in the sandbox, holding it open, and the driver's own cleanup failed with
// EPERM. This launch owns the whole tree: its own process group on POSIX, taskkill /T on Windows while the
// shim is still alive. A run past its budget is ended entirely and reported as timed out, never leaked.
import { execFileSync, spawn } from "node:child_process"

// Windows keeps a dead parent's pid in its children's ParentProcessId, so a shim that already exited still
// names the engine it left behind.
function windowsChildren(pid) {
  return execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${pid}' | ForEach-Object { $_.ProcessId }`,
    ],
    { encoding: "utf8", windowsHide: true },
  )
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((child) => Number.isInteger(child) && child > 0)
}

function stopTree(child, platform) {
  try {
    if (platform !== "win32") {
      process.kill(-child.pid, "SIGKILL")
      return `SIGKILL to process group ${child.pid}`
    }
    const roots = child.exitCode === null && child.signalCode === null ? [child.pid] : windowsChildren(child.pid)
    for (const pid of roots)
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    return `taskkill /T ended ${roots.length === 0 ? "nothing (no live tree)" : `pid ${roots.join(", ")} and descendants`}`
  } catch (error) {
    return `tree stop FAILED: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Resolves `{ status, signal, stdout, stderr, timedOut, treeStop }` once the launched tree's stdio has
 * closed. On timeout `status` is null, `timedOut` true and `treeStop` names what ended the tree.
 */
export function runBoundedSenpi(file, args, { cwd, env, timeoutMs, platform = process.platform }) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Without it every senpi launch opens a visible console window on win32 when the driver has none.
      windowsHide: true,
      detached: platform !== "win32",
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let treeStop
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      timedOut = true
      treeStop = stopTree(child, platform)
    }, timeoutMs)
    child.once("error", (error) => {
      clearTimeout(timer)
      resolve({
        status: null,
        signal: null,
        stdout,
        stderr: `${stderr}\n[spawn error] ${error.message}`,
        timedOut,
        treeStop,
      })
    })
    child.once("close", (status, signal) => {
      clearTimeout(timer)
      resolve({ status: timedOut ? null : status, signal, stdout, stderr, timedOut, treeStop })
    })
  })
}
