import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// A port of the senpi 2026.11.5-1 `ls` tool (`core/tools/ls.js` over the local machine, no
// filesystem policy). The senpi runtime is never bundled into V2, so its value code is mirrored here.
const DEFAULT_LIMIT = 500
const MAX_BYTES = 50 * 1024
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

/** The ORIGINAL Native `ls` description text. */
export const NATIVE_LS_DESCRIPTION = `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${MAX_BYTES / 1024}KB (whichever is hit first).`

export interface NativeLsInput {
  readonly path?: string
  readonly limit?: number
}
export interface NativeLsOutput {
  readonly text: string
  readonly details?: { readonly entryLimitReached?: number; readonly truncated?: true }
}

function windowsShellPath(path: string): string {
  if (process.platform !== "win32" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path
  const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i)
  const drive = match?.[1]
  if (!drive) return path
  return `${drive.toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`
}

function normalize(path: string, model: boolean): string {
  let value = model ? path.replace(UNICODE_SPACES, " ") : path
  if (model && value.startsWith("@")) value = value.slice(1)
  value = windowsShellPath(value)
  if (value === "~") return homedir()
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\")))
    return join(homedir(), value.slice(2))
  return /^file:\/\//.test(value) ? fileURLToPath(value) : value
}

/** Native `resolveToCwd`: unicode spaces, `@` prefix, shell drive paths, `~` and file URLs. */
export function resolveNativeLsPath(path: string | undefined, cwd: string): string {
  const target = normalize(path || ".", true)
  return isAbsolute(target) ? resolve(target) : resolve(normalize(cwd, false), target)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)}KB` : `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** Native head truncation with no line limit: whole lines until the byte cap. */
function truncateHead(content: string): { readonly content: string; readonly truncated: boolean } {
  if (Buffer.byteLength(content, "utf-8") <= MAX_BYTES) return { content, truncated: false }
  const kept: string[] = []
  let bytes = 0
  for (const [index, line] of content.split("\n").entries()) {
    const size = Buffer.byteLength(line, "utf-8") + (index > 0 ? 1 : 0)
    if (bytes + size > MAX_BYTES) break
    kept.push(line)
    bytes += size
  }
  return { content: kept.join("\n"), truncated: true }
}

async function isDirectory(path: string): Promise<boolean | undefined> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return undefined
  }
}

/** The SAME listing, ordering, suffixes, limits, notices and error texts as Native `ls`. Read-only. */
export async function runNativeLs(
  directory: string,
  input: NativeLsInput,
  signal: AbortSignal,
): Promise<NativeLsOutput> {
  signal.throwIfAborted()
  const limit = input.limit ?? DEFAULT_LIMIT
  const kind = await isDirectory(directory)
  if (kind === undefined) throw Error(`Path not found: ${directory}`)
  if (!kind) throw Error(`Not a directory: ${directory}`)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    throw Error(`Cannot read directory: ${error instanceof Error ? error.message : String(error)}`)
  }
  entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  const results: string[] = []
  let limitReached = false
  for (const entry of entries) {
    signal.throwIfAborted()
    if (results.length >= limit) {
      limitReached = true
      break
    }
    // Entries that cannot be stat'ed are skipped, as Native does.
    const directoryEntry = await isDirectory(join(directory, entry))
    if (directoryEntry !== undefined) results.push(entry + (directoryEntry ? "/" : ""))
  }
  if (results.length === 0) return { text: "(empty directory)" }
  const truncation = truncateHead(results.join("\n"))
  const notices: string[] = []
  if (limitReached) notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`)
  if (truncation.truncated) notices.push(`${formatSize(MAX_BYTES)} limit reached`)
  if (notices.length === 0) return { text: truncation.content }
  // Native sends the notice as a model-only part; the SDK has no such channel, so it stays model-visible text.
  return {
    text: `${truncation.content}\n[${notices.join(". ")}]`,
    details: {
      ...(limitReached && { entryLimitReached: limit }),
      ...(truncation.truncated && { truncated: true as const }),
    },
  }
}
