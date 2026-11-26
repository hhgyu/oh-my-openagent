import { spawn, type ChildProcess } from "node:child_process"
import { win32 } from "node:path"

// On Windows `git` is the Git for Windows launcher (`cmd\git.exe`), which starts the real git as its own
// child; git then starts pack-objects, hooks and the like. Terminating the launcher alone leaves all of
// them running in the repository after the call has settled (measured: the real git and pack-objects
// kept a maintenance pass going for seconds), so a caller that removes or rewrites the repository on
// abort races them. Windows has no SIGTERM to forward anyway: a stop there ends the whole tree.

function taskkillPath(environment: NodeJS.ProcessEnv): string {
  const root = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.windir
  return root === undefined || root.trim() === "" ? "taskkill.exe" : win32.join(root, "System32", "taskkill.exe")
}

/**
 * Stops a git child. POSIX: `signal` goes to git, which removes its own lock and temp files, and the
 * call returns undefined. Windows: the launcher's whole process tree is terminated, and the promise
 * resolves once taskkill has finished; the child's stdio `close` then marks the last holder gone.
 */
export function stopGitProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> | undefined {
  if (platform !== "win32" || child.pid === undefined) {
    child.kill(signal)
    return undefined
  }
  const pid = child.pid
  return new Promise<void>((resolve) => {
    const taskkill = spawn(taskkillPath(environment), ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    })
    taskkill.once("error", () => {
      child.kill(signal)
      resolve()
    })
    taskkill.once("exit", () => resolve())
  })
}
