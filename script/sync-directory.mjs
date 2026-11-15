import { mkdir, readdir, readFile, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { removePath, replaceFileContents } from "./windows-safe-replace.mjs"

// Mirrors source into target in place, replacing `rm -rf target && cp -R source target`. Deleting
// the whole tree fails on Windows while a running OpenCode holds any file under it, and leaves the
// tree half-deleted. Here unchanged files are never touched, changed files are swapped in through a
// temp file, and entries that no longer exist in source are removed, so a held file only blocks the
// build when it really has to change, and then the build fails with the holder's name.
export async function syncDirectory(source, target, options = {}) {
  const sourceEntries = await listTree(source)
  if (sourceEntries === undefined) throw new Error(`sync-directory: source ${source} is not a directory`)
  const targetInfo = await stat(target).catch(() => undefined)
  if (targetInfo !== undefined && !targetInfo.isDirectory()) await removePath(target, options)
  await mkdir(target, { recursive: true })
  const summary = { written: 0, unchanged: 0, removed: 0 }
  const removedDirs = []
  for (const [relative, entry] of (await listTree(target)) ?? new Map()) {
    if (removedDirs.some((dir) => relative.startsWith(`${dir}/`))) continue
    if (sourceEntries.get(relative)?.kind === entry.kind) continue
    await removePath(join(target, relative), options)
    if (entry.kind === "directory") removedDirs.push(relative)
    summary.removed += 1
  }
  for (const [relative, entry] of sourceEntries) {
    const destination = join(target, relative)
    if (entry.kind === "directory") {
      await mkdir(destination, { recursive: true })
      continue
    }
    const changed = await replaceFileContents(destination, await readFile(join(source, relative)), {
      ...options,
      mode: entry.mode,
    })
    summary[changed ? "written" : "unchanged"] += 1
  }
  return summary
}

async function listTree(root) {
  const rootInfo = await stat(root).catch(() => undefined)
  if (rootInfo === undefined || !rootInfo.isDirectory()) return undefined
  const entries = new Map()
  const visit = async (relative) => {
    for (const dirent of await readdir(join(root, relative), { withFileTypes: true })) {
      const child = relative === "" ? dirent.name : `${relative}/${dirent.name}`
      if (dirent.isSymbolicLink())
        throw new Error(`sync-directory: symbolic links are not supported: ${join(root, child)}`)
      if (dirent.isDirectory()) {
        entries.set(child, { kind: "directory" })
        await visit(child)
      } else {
        entries.set(child, { kind: "file", mode: (await stat(join(root, child))).mode & 0o777 })
      }
    }
  }
  await visit("")
  return entries
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const [source, target] = process.argv.slice(2)
  if (source === undefined || target === undefined) {
    console.error("usage: sync-directory.mjs <source-dir> <target-dir>")
    process.exit(2)
  }
  const summary = await syncDirectory(resolve(source), resolve(target))
  console.log(
    `sync-directory: ${target} matches ${source} (${summary.written} written, ${summary.unchanged} unchanged, ${summary.removed} removed)`,
  )
}
