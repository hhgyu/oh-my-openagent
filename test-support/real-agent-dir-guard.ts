import { readdirSync, statSync } from "node:fs"
import { join, relative, isAbsolute } from "node:path"
import { projectStateKey } from "../packages/senpi-task/src/store/project-state-directory"

// A project state folder is named `<project basename>-<12 hex of the project path's sha256>`. A folder in
// the real agent dir whose name hashes back to a directory under a test temp root was written for a test
// project. Only folders created since this process started count, so an older leak (or a live session's
// own project) never fails a later run.
const PROJECT_KEY = /^(.+)-[0-9a-f]{12}$/

export function testProjectStateCreatedIn(
  projectsDir: string,
  tempRoots: readonly string[],
  startedAt: number = Date.now() - process.uptime() * 1000,
): string[] {
  let names: string[]
  try {
    names = readdirSync(projectsDir)
  } catch {
    return []
  }
  return names
    .filter((name) => {
      const projectBasename = PROJECT_KEY.exec(name)?.[1]
      if (!projectBasename) return false
      return tempRoots.some((root) => projectStateKey(join(root, projectBasename)) === name)
    })
    .filter((name) => createdAt(join(projectsDir, name)) >= startedAt)
    .map((name) => join(projectsDir, name))
}

function createdAt(path: string): number {
  try {
    const stat = statSync(path)
    return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs
  } catch {
    return Number.NEGATIVE_INFINITY
  }
}

export function isInside(root: string, path: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot)
}
