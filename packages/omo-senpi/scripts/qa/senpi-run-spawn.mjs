import { spawnSync } from "node:child_process"

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

// The group kill for a run spawned with senpiRunSpawnOptions. POSIX signals the run's process group
// exactly as `process.kill(-pid, signal)` does (and throws as it does, so callers keep their single-pid
// fallback). A win32 run is no group leader, so its tree is taken with taskkill /T /F.
export function killSenpiRunTree(pid, signal = "SIGKILL", platform = process.platform) {
  if (platform === "win32") {
    spawnSync("taskkill", senpiTreeKill(pid, platform).args, { stdio: "ignore", windowsHide: true })
    return
  }
  process.kill(-pid, signal)
}
