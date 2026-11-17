import type { GitExecResult } from "./exec"
import { MemorySecretError, secretPatternClassOf } from "./secret"

type GitResult = (argv: readonly string[], stdin?: string) => Promise<GitExecResult>

/**
 * Refuse a staged commit that would carry secret-like material: first every
 * normalized path string (a file name is repository-controlled text like any
 * body), then every staged blob's full content. Reads come from the INDEX
 * (`:<path>`), never the worktree, and deletions are skipped because their
 * blob is gone.
 */
export async function assertNoSecretLikeStaging(paths: readonly string[], gitResult: GitResult): Promise<void> {
  for (const path of paths) {
    const patternClass = secretPatternClassOf(path)
    if (patternClass !== undefined) throw new MemorySecretError({ path, patternClass, where: "path" })
  }
  const batched = await readStagedBlobs(paths, gitResult)
  for (const path of paths) {
    const content = batched.has(path) ? batched.get(path) : await showStaged(path, gitResult)
    if (content === undefined) continue
    const patternClass = secretPatternClassOf(content)
    if (patternClass !== undefined) throw new MemorySecretError({ path, patternClass, where: "content" })
  }
}

async function showStaged(path: string, gitResult: GitResult): Promise<string | undefined> {
  const result = await gitResult(["show", `:${path}`])
  return result.code === 0 ? result.stdout : undefined
}

// One `git cat-file --batch` reads every staged blob instead of one `git show` per path. It resolves `:<path>`
// with the same parser as `git show`, so a path absent from stage 0 reads as missing exactly where `show`
// failed. A path the line protocol cannot carry (CR or LF), a non-blob entry, or any batch failure is left
// out of the map and read with `git show` as before. A missing path maps to undefined.
async function readStagedBlobs(
  paths: readonly string[],
  gitResult: GitResult,
): Promise<ReadonlyMap<string, string | undefined>> {
  const names = paths.filter((path) => !/[\r\n]/.test(path))
  if (names.length < 2) return new Map()
  const result = await gitResult(["cat-file", "--batch"], `${names.map((path) => `:${path}`).join("\n")}\n`)
  if (result.code !== 0) return new Map()
  const output = result.stdoutBytes ?? Buffer.from(result.stdout, "utf8")
  const blobs = new Map<string, string | undefined>()
  let offset = 0
  for (const path of names) {
    const newline = output.indexOf(0x0a, offset)
    if (newline === -1) return new Map()
    const header = output.toString("utf8", offset, newline)
    offset = newline + 1
    if (header === `:${path} missing`) {
      blobs.set(path, undefined)
      continue
    }
    const [, type, sizeText] = header.split(" ")
    const size = Number(sizeText)
    if (header.split(" ").length !== 3 || !Number.isSafeInteger(size) || size < 0 || offset + size > output.length)
      return new Map()
    if (type === "blob") blobs.set(path, output.toString("utf8", offset, offset + size))
    offset += size + 1
  }
  return blobs
}
