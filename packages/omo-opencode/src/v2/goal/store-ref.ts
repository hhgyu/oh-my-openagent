import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { GoalStoreRef } from "./engine"

// The project's `.omo/goal` is also the cwd candidate the agent-toolkit SDK reads a driver goal from. When the project
// directory is the home directory, `<project>/.omo` is the OmO home, which no project state may write into.
export function goalStoreDir(projectDirectory: string, home: string = homedir()): string {
  if (resolve(projectDirectory) === resolve(home)) {
    const key = createHash("sha256").update(resolve(projectDirectory)).digest("hex").slice(0, 24)
    return join(tmpdir(), "omo-opencode-v2-goal", key)
  }
  return join(projectDirectory, ".omo", "goal")
}

export function goalStoreRef(projectDirectory: string, sessionID: string, home?: string): GoalStoreRef {
  return { baseDir: goalStoreDir(projectDirectory, home), threadId: sessionID }
}

export function goalStoreFile(ref: GoalStoreRef): string {
  return join(ref.baseDir, `${encodeURIComponent(ref.threadId)}.json`)
}
