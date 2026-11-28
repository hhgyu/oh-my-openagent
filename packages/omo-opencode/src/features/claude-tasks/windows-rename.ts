import { renameSync } from "fs"

// Windows refuses a replacing rename with a sharing violation (EPERM, EBUSY or EACCES) while another handle on the
// target or the temp file is still open without FILE_SHARE_DELETE, a window that closes on its own once that handle
// does; on Windows CI a just-written task file hit it in about one run in two. This is the same bounded,
// win32-only replace the senpi task record store uses (packages/senpi-task/src/store/record-write.ts): any other
// platform, errno, or the last attempt rethrows the error unchanged.
const WINDOWS_RENAME_RETRIES = 8
const WINDOWS_RENAME_RETRY_MS = 5
const WINDOWS_TRANSIENT_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"])
const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

export function renameWithWindowsRetry(from: string, to: string, platform: NodeJS.Platform = process.platform): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      if (platform !== "win32" || attempt >= WINDOWS_RENAME_RETRIES || !isTransientWindowsError(error)) throw error
      Atomics.wait(sleeper, 0, 0, WINDOWS_RENAME_RETRY_MS)
    }
  }
}

function isTransientWindowsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    WINDOWS_TRANSIENT_CODES.has(error.code)
  )
}
