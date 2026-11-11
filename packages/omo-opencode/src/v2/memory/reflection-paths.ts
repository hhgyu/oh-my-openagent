// Path confinement for the reflection child's read-only tools (V2 port of the Senpi worktree
// confinement in `omo-senpi/.../worker/spawn-payload.ts` `resolveDreamTarget`, widened from one
// target document to every read). The Senpi child ran with `cwd=worktree`; the V2 child has no cwd
// of its own, so every path it names is resolved here against the run's worktree:
// - only relative paths are accepted (absolute, drive-letter and UNC paths are refused);
// - a `..` segment is refused before anything touches the filesystem;
// - `.git` (administration files) is refused as a segment and after symlink resolution;
// - the realpath of the target must stay inside the realpath of the worktree, so a symlink that
//   points outside the worktree is refused instead of followed.
// The transcript is not a path the child names: the `transcript` target maps to the one file the
// parent wrote for the run, and nothing else outside the worktree is reachable.

import type { Dirent } from "@oh-my-opencode/memory-core/fs"
import { readdir, realpath, stat } from "@oh-my-opencode/memory-core/fs"
import { isAbsolute, join, relative, sep } from "node:path"

export type ReflectionPathErrorCode = "path_absolute" | "path_traversal" | "path_git" | "path_escape" | "not_found" | "not_file" | "not_directory" | "invalid_input" | "pattern_unsafe"

export class ReflectionPathError extends Error {
  constructor(readonly code: ReflectionPathErrorCode, message: string) {
    super(message)
    this.name = "ReflectionPathError"
  }
}

/** Repo-relative, `/`-joined segments; `""` names the worktree root. Purely lexical. */
export function normalizeReflectionPath(input: string): string {
  const trimmed = input.trim()
  if (isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\")) {
    throw new ReflectionPathError("path_absolute", "paths are relative to the memory worktree; absolute paths are refused")
  }
  const segments = trimmed.split(/[\\/]+/).filter(segment => segment.length > 0 && segment !== ".")
  if (segments.includes("..")) throw new ReflectionPathError("path_traversal", "paths cannot contain '..' segments")
  if (segments.some(isGitSegment)) throw new ReflectionPathError("path_git", "Git administration files are not readable")
  return segments.join("/")
}

/** The realpath of `relativePath` under `root`, refused when it escapes the root or lands in `.git`. */
export async function resolveConfinedPath(root: string, relativePath: string): Promise<{ readonly realRoot: string; readonly real: string; readonly display: string }> {
  const display = normalizeReflectionPath(relativePath)
  const realRoot = await realpath(root)
  const candidate = display === "" ? realRoot : join(realRoot, ...display.split("/"))
  let real: string
  try {
    real = await realpath(candidate)
  } catch (error) {
    if (isMissing(error)) throw new ReflectionPathError("not_found", `${display || "."} does not exist in the memory worktree`)
    throw error
  }
  assertInside(realRoot, real)
  return { realRoot, real, display }
}

/** The realpath of the run's transcript; it must be a regular file. */
export async function resolveTranscriptPath(transcriptPath: string): Promise<string> {
  let real: string
  try {
    real = await realpath(transcriptPath)
  } catch (error) {
    if (isMissing(error)) throw new ReflectionPathError("not_found", "the run transcript does not exist")
    throw error
  }
  if (!(await stat(real)).isFile()) throw new ReflectionPathError("not_file", "the run transcript is not a regular file")
  return real
}

function assertInside(realRoot: string, real: string): void {
  const rel = relative(realRoot, real)
  if (rel === "") return
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ReflectionPathError("path_escape", "the path resolves outside the memory worktree")
  }
  if (rel.split(sep).some(isGitSegment)) throw new ReflectionPathError("path_git", "Git administration files are not readable")
}

export interface ReflectionWalkEntry {
  /** Worktree-relative `/`-joined path. */
  readonly path: string
  readonly real: string
  readonly kind: "file" | "directory"
}

/**
 * Depth-first walk below `start` (inclusive of its children), sorted by name. `.git` is skipped;
 * a symlink is followed only when its realpath stays inside the worktree, and each real directory
 * is entered once. Stops after `maxEntries` entries and reports whether it was cut short.
 */
export async function walkConfined(
  realRoot: string, start: { readonly real: string; readonly display: string }, options: { readonly maxDepth: number; readonly maxEntries: number },
): Promise<{ readonly entries: readonly ReflectionWalkEntry[]; readonly truncated: boolean }> {
  const entries: ReflectionWalkEntry[] = []
  const seen = new Set<string>([start.real])
  let truncated = false
  const visit = async (dir: string, display: string, depth: number): Promise<void> => {
    let children: Dirent[]
    try {
      children = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    children.sort((left, right) => left.name.localeCompare(right.name))
    for (const child of children) {
      if (truncated) return
      if (isGitSegment(child.name)) continue
      const path = display === "" ? child.name : `${display}/${child.name}`
      const resolved = await confinedChild(realRoot, join(dir, child.name))
      if (resolved === undefined) continue
      if (entries.length >= options.maxEntries) {
        truncated = true
        return
      }
      entries.push({ path, real: resolved.real, kind: resolved.kind })
      if (resolved.kind === "directory" && depth + 1 < options.maxDepth && !seen.has(resolved.real)) {
        seen.add(resolved.real)
        await visit(resolved.real, path, depth + 1)
      }
    }
  }
  await visit(start.real, start.display, 0)
  return { entries, truncated }
}

async function confinedChild(realRoot: string, path: string): Promise<{ readonly real: string; readonly kind: "file" | "directory" } | undefined> {
  try {
    const real = await realpath(path)
    assertInside(realRoot, real)
    const info = await stat(real)
    if (info.isDirectory()) return { real, kind: "directory" }
    if (info.isFile()) return { real, kind: "file" }
    return undefined
  } catch (error) {
    if (error instanceof ReflectionPathError || isMissing(error)) return undefined
    throw error
  }
}

function isGitSegment(segment: string): boolean {
  return segment.toLowerCase() === ".git"
}

function isMissing(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false
  return error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP"
}
