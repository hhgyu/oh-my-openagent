// Spawn options for a QA driver's senpi run that must be killable as a whole tree.
//
// POSIX runs lead their own process group, so the driver can signal the whole tree at once. On win32
// `detached` means DETACHED_PROCESS: the senpi launcher starts with no console at all, so its node and
// bun children each allocate a fresh, visible console window that takes the desktop focus. There the
// run stays attached and hidden (it inherits the driver's console) and the tree is taken with
// taskkill /T instead of a process-group signal.
export function senpiRunSpawnOptions(platform = process.platform) {
  return { detached: platform !== "win32", windowsHide: true }
}

// pkill does not exist on win32, so a killed senpi launcher there would leave its node and bun
// children running; taskkill /T takes the whole tree.
export function senpiTreeKill(pid, platform = process.platform) {
  return platform === "win32"
    ? { command: "taskkill", args: ["/T", "/F", "/PID", String(pid)] }
    : { command: "pkill", args: ["-9", "-P", String(pid)] }
}
