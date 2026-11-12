import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { nativeTaskStateDir } from "../native-task/component"

function recordedParent(path: string): string | undefined {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || !("parentSessionId" in value)) return undefined
  return typeof value.parentSessionId === "string" ? value.parentSessionId : undefined
}

/** Root sessions with a DAG store in this project's Native state, so a new plugin generation's wake
 * owner can watch their runs after a reload (un-ACKed wakes re-posted with the same id). Each
 * candidate comes from a run record and must hash to the very state directory it was read from, so
 * a record cannot name a root whose storage lives elsewhere. Reads only; never scans when the
 * project directory is $HOME (there `.omo` is the OmO home). */
export function discoverDagRoots(projectDirectory: string): string[] {
  if (resolve(projectDirectory) === resolve(homedir())) return []
  const base = join(projectDirectory, ".omo", "tasks", "opencode-v2")
  if (!existsSync(base)) return []
  const roots: string[] = []
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue
    const stateDir = join(base, entry.name),
      runs = join(stateDir, "dag", "runs")
    if (!existsSync(runs)) continue
    for (const file of readdirSync(runs)) {
      const parent = file.endsWith(".json") ? recordedParent(join(runs, file)) : undefined
      if (parent !== undefined && nativeTaskStateDir(projectDirectory, parent) === stateDir) {
        roots.push(parent)
        break
      }
    }
  }
  return roots
}
