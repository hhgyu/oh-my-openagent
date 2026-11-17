import type { BigIntStats } from "node:fs"
import { open, readdir, readFile, realpath, stat } from "node:fs/promises"

export interface SessionHistoryFileStats {
  readonly type: "File" | "Directory" | "Other"
  readonly size: number
  readonly mtimeMs: number | null
  readonly dev: number
  readonly ino: number | null
  readonly birthtimeMs: number | null
  /**
   * Exact `<dev>:<ino>`, read as bigints. NTFS file IDs often exceed 2^53, where `ino` is null, so two directories
   * would otherwise lose their identity and be compared by path instead.
   */
  readonly identity?: string | null
}

export interface SessionHistoryFile {
  /** Reads up to `size` bytes; `null` at end of file. */
  read(size: number): Promise<Uint8Array | null>
  stat(): Promise<SessionHistoryFileStats>
  close(): Promise<void>
}

/** The only filesystem surface session discovery uses; tests wrap it to count and fault operations. */
export interface SessionHistoryFs {
  readDirectory(path: string): Promise<ReadonlyArray<string>>
  stat(path: string): Promise<SessionHistoryFileStats>
  realPath(path: string): Promise<string>
  readFileString(path: string): Promise<string>
  open(path: string): Promise<SessionHistoryFile>
}

export function toFileStats(stats: BigIntStats): SessionHistoryFileStats {
  const ino = Number(stats.ino)
  return {
    type: stats.isFile() ? "File" : stats.isDirectory() ? "Directory" : "Other",
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
    dev: Number(stats.dev),
    ino: Number.isSafeInteger(ino) && ino > 0 ? ino : null,
    birthtimeMs: stats.birthtimeMs > 0n ? Number(stats.birthtimeMs) : null,
    identity: stats.ino > 0n ? `${stats.dev}:${stats.ino}` : null,
  }
}

export const nodeSessionHistoryFs: SessionHistoryFs = {
  readDirectory: (path) => readdir(path),
  stat: async (path) => toFileStats(await stat(path, { bigint: true })),
  realPath: (path) => realpath(path),
  readFileString: (path) => readFile(path, "utf8"),
  async open(path) {
    const handle = await open(path, "r")
    return {
      async read(size) {
        const buffer = new Uint8Array(size)
        const { bytesRead } = await handle.read(buffer, 0, size, null)
        return bytesRead === 0 ? null : buffer.subarray(0, bytesRead)
      },
      stat: async () => toFileStats(await handle.stat({ bigint: true })),
      close: () => handle.close(),
    }
  },
}

export async function statOrNull(fs: SessionHistoryFs, path: string): Promise<SessionHistoryFileStats | null> {
  try {
    return await fs.stat(path)
  } catch {
    return null
  }
}

export async function listDirectoryOrEmpty(fs: SessionHistoryFs, path: string): Promise<ReadonlyArray<string>> {
  try {
    return await fs.readDirectory(path)
  } catch {
    return []
  }
}

export async function realPathOr(fs: SessionHistoryFs, path: string): Promise<string> {
  try {
    return await fs.realPath(path)
  } catch {
    return path
  }
}

export async function readFileStringOrEmpty(fs: SessionHistoryFs, path: string): Promise<string> {
  try {
    return await fs.readFileString(path)
  } catch {
    return ""
  }
}
