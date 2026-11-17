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
// `A `, `D `, `T `), or an untracked file no other entry names. A rename or copy, an unmerged entry or a
// path listed twice proves nothing, and the caller then asks git. A quoted path never equals a requested
// path: git quotes any name holding `"`, and escapes that `"` inside the quotes.
export function porcelainProvesPathChanges(porcelain: string, paths: readonly string[]): boolean {
  const lines = porcelain.split(/\r?\n/).filter((line) => line.length >= 4)
  const names = lines.map((line) => line.slice(3))
  return lines.some((line, index) => {
    const path = names[index] ?? ""
    return (
      paths.includes(path) &&
      names.indexOf(path) === names.lastIndexOf(path) &&
      /^(\?\?| [MDT]|[MADT] )$/.test(line.slice(0, 2))
    )
  })
}
