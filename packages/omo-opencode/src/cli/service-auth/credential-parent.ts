import { lstatSync, mkdirSync } from "node:fs"
import { join } from "node:path"

export class CredentialParentError extends Error {}

/**
 * A host with no POSIX owner to compare (no process.getuid, as on Windows) is `undefined`: the directory must still be
 * a real directory, but owner and mode are not judged, since that host cannot answer them.
 */
export function checkCredentialDirectory(path: string, uid: number | undefined): boolean {
  const st = lstatSync(path, { throwIfNoEntry: false })
  if (!st) return false
  const reason = st.isSymbolicLink()
    ? "symlink"
    : !st.isDirectory()
      ? "not a directory"
      : uid === undefined
        ? null
        : st.uid !== uid
          ? "foreign owner"
          : (st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0
            ? "writable by other users"
            : null
  if (reason) {
    const mode = (st.mode & 0o7777).toString(8).padStart(4, "0")
    throw new CredentialParentError(
      uid === undefined
        ? `Refused credential directory ${path} (${reason}). Inspect the path; use a real directory.`
        : `Refused credential directory ${path} (${reason}, mode ${mode}, owner ${st.uid}). Inspect the path; use a real directory owned by UID ${uid}, and remove group/other write permission with chmod go-w on that directory.`,
    )
  }
  return true
}

export function checkCredentialParents(home: string, uid: number | undefined): boolean {
  return checkCredentialDirectory(home, uid) && checkCredentialDirectory(join(home, ".omo"), uid)
}

export function prepareLinuxLockDirectory(home: string, uid: number): void {
  if (!checkCredentialDirectory(home, uid)) {
    mkdirSync(home, { recursive: true, mode: 0o700 })
    if (!checkCredentialDirectory(home, uid))
      throw new CredentialParentError(`Credential home ${home} disappeared. Inspect its path and ownership.`)
  }
  for (const path of [join(home, ".omo"), join(home, ".omo", "session-locks")]) {
    if (checkCredentialDirectory(path, uid)) continue
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
    }
    if (!checkCredentialDirectory(path, uid))
      throw new CredentialParentError(
        `Credential directory ${path} disappeared. Inspect the directory and its ownership.`,
      )
  }
}
