import { DirtyRepoError } from "./errors"
import { describeDirtyMarkdownEncodingIssues, parsePorcelainPath } from "./porcelain"

export async function assertNoUnrelatedChanges(
  dir: string,
  paths: readonly string[],
  status: () => Promise<string>,
): Promise<void> {
  const porcelain = await status()
  const unrelated = porcelain
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const path = parsePorcelainPath(line)
      return (
        path !== null &&
        !paths.some(
          (allowed) =>
            path === allowed ||
            path.startsWith(`${allowed}/`) ||
            allowed.startsWith(path.endsWith("/") ? path : `${path}/`),
        )
      )
    })
  if (unrelated.length === 0) return
  const listing = `${unrelated.join("\n")}\n`
  throw new DirtyRepoError(listing, describeDirtyMarkdownEncodingIssues(dir, listing))
}

// Whether a porcelain listing read BEFORE `git add -A -- <paths>` already proves that, after the add, one of
// the exact paths differs from HEAD, so the post-add `git status -- <paths>` would print something. Only
// one-sided entries prove it: worktree-only (` M`, ` D`, ` T`), index-only with a matching worktree (`M `,
// `A `, `D `, `T `), or an untracked file no other entry names. A rename, a quoted path, an unmerged entry or
// a path listed twice proves nothing, and the caller then asks git.
export function porcelainProvesPathChanges(porcelain: string, paths: readonly string[]): boolean {
  const entries = porcelain
    .split(/\r?\n/)
    .filter((line) => line.length >= 4)
    .map((line) => ({ index: line[0], worktree: line[1], path: line.slice(3) }))
  const named = new Map<string, number>()
  for (const { path } of entries) named.set(path, (named.get(path) ?? 0) + 1)
  const wanted = new Set(paths)
  return entries.some(({ index, worktree, path }) => {
    if (!wanted.has(path) || named.get(path) !== 1 || path.startsWith('"') || path.includes(" -> ")) return false
    if (index === "?" && worktree === "?") return true
    if (index === " ") return worktree === "M" || worktree === "D" || worktree === "T"
    return worktree === " " && (index === "M" || index === "A" || index === "D" || index === "T")
  })
}
