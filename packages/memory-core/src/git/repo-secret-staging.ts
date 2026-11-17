import type { GitExecResult } from "./exec"
import { type CatFileRecord, parseCatFileRecords } from "./repo-tree"
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
// failed. A path the line protocol cannot carry (CR or LF), a non-blob entry, any other content-less record,
// or any batch failure is left out of the map and read with `git show` as before. A missing path maps to
// undefined.
async function readStagedBlobs(
  paths: readonly string[],
  gitResult: GitResult,
): Promise<ReadonlyMap<string, string | undefined>> {
  const blobs = new Map<string, string | undefined>()
  const names = paths.filter((path) => !/[\r\n]/.test(path))
  if (names.length < 2) return blobs
  const result = await gitResult(["cat-file", "--batch"], `${names.map((path) => `:${path}`).join("\n")}\n`)
  if (result.code !== 0) return blobs
  let records: CatFileRecord[]
  try {
    records = parseCatFileRecords(result.stdoutBytes ?? Buffer.from(result.stdout, "utf8"))
  } catch {
    return blobs
  }
  if (records.length !== names.length) return blobs
  names.forEach((path, index) => {
    const { header, type, content } = records[index] ?? { header: "" }
    if (content === undefined ? header === `:${path} missing` : type === "blob") blobs.set(path, content)
  })
  return blobs
}
