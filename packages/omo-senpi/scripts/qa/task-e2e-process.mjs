import { spawnSync } from "node:child_process"
import { senpiTreeKill } from "./senpi-run-spawn.mjs"

export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isMissingProcess(error)) return false
    throw error
  }
}

export function killTree(pid, platform = process.platform) {
  const { args } = senpiTreeKill(pid, platform)
  if (platform === "win32") {
    spawnSync("taskkill", args, { stdio: "ignore", windowsHide: true })
    return
  }
  spawnSync("pkill", args, { stdio: "ignore", windowsHide: true })
  try {
    process.kill(pid, 9)
  } catch (error) {
    if (!isMissingProcess(error)) throw error
  }
}

function isMissingProcess(error) {
  return error instanceof Error && "code" in error && error.code === "ESRCH"
}
