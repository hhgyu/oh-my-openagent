import { createHash } from "node:crypto"
import { join } from "node:path"

export function nativeTaskStateDir(projectDirectory: string, parentSessionID: string): string {
  return join(
    projectDirectory,
    ".omo",
    "tasks",
    "opencode-v2",
    createHash("sha256").update(parentSessionID).digest("hex"),
  )
}
