// Main-thread last resort for subprocess kernels (py/rb/jl) at process exit. A Worker cannot run cleanup
// once the process is exiting, so the worker reports the pids of its live kernels (codemode's kernel
// registry) and the main thread's synchronous `exit` hook kills those trees here.
//
// Windows: one `taskkill /T /F` over every pid (tree kill; the S9c exit probe also saw the Python kernel
// gone within 4 s after the worker died). POSIX: codemode spawns kernels as group leaders, so the group
// goes first, then the pid itself. Pids are only those reported live moments before; errors (already
// gone, permission) are ignored because nothing can be done about them during exit.

import { spawnSync } from "node:child_process"

export interface KernelReaperDeps {
  readonly platform?: NodeJS.Platform
  readonly spawnSync?: (
    command: string,
    args: readonly string[],
    options: { readonly stdio: "ignore"; readonly windowsHide: boolean; readonly timeout: number },
  ) => unknown
  readonly kill?: (pid: number, signal: NodeJS.Signals) => unknown
}

const TASKKILL_TIMEOUT_MS = 5_000

export function killKernelTreesSync(pids: readonly number[], deps: KernelReaperDeps = {}): void {
  const live = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  if (live.length === 0) return
  const platform = deps.platform ?? process.platform
  if (platform === "win32") {
    const args = ["/T", "/F", ...live.flatMap((pid) => ["/PID", String(pid)])]
    try {
      ;(deps.spawnSync ?? spawnSync)("taskkill", args, {
        stdio: "ignore",
        windowsHide: true,
        timeout: TASKKILL_TIMEOUT_MS,
      })
    } catch {
      /* Exiting anyway: a kernel that survives is reported by the real-host QA, not here. */
    }
    return
  }
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
  for (const pid of live) {
    try {
      kill(-pid, "SIGKILL")
    } catch {
      /* Not a group leader or already gone. */
    }
    try {
      kill(pid, "SIGKILL")
    } catch {
      /* Already gone. */
    }
  }
}
