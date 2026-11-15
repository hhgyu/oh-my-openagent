import { cp, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rename, rm } from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"

// Codex fingerprints every plugin entry with symlink_metadata, including node_modules.
// Hooks use component CLIs directly; third-party regular npm shims must remain.
const NPM_BIN_PATH_SEGMENT = `${sep}node_modules${sep}.bin${sep}`

export async function finalizeCachedPluginPayload(pluginRoot: string): Promise<void> {
  await materializeDirectory(pluginRoot)
  const unsupported = await unsupportedEntries(pluginRoot, pluginRoot)
  if (unsupported.length > 0) {
    throw new Error(`Codex plugin contains unsupported entry types: ${unsupported.sort().join(", ")}`)
  }
}

async function materializeDirectory(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    let entry = await lstat(path)
    if (path.includes(NPM_BIN_PATH_SEGMENT) && !entry.isFile() && !entry.isDirectory()) {
      await rm(path, { recursive: true, force: true })
      continue
    }
    if (entry.isSymbolicLink()) {
      const staging = await mkdtemp(join(directory, ".omo-materialize-"))
      try {
        const copyPath = join(staging, "entry")
        await copyResolved(await resolveLinkTarget(path), copyPath, [])
        await rm(path, { force: true, recursive: true })
        await rename(copyPath, path)
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
      entry = await lstat(path)
    }
    if (entry.isDirectory()) await materializeDirectory(path)
  }
}

// Windows resolves a relative link target against the path used to reach the link, not against
// the link's real directory, so a Bun workspace link reached through an npm file: junction points
// at a sibling that does not exist. Resolve every link from its real parent instead.
async function resolveLinkTarget(linkPath: string): Promise<string> {
  const realParent = await realpath(dirname(linkPath))
  return realpath(resolve(realParent, await readlink(linkPath)))
}

async function copyResolved(source: string, destination: string, ancestors: readonly string[]): Promise<void> {
  const entry = await lstat(source)
  if (!entry.isDirectory()) {
    await cp(source, destination)
    return
  }
  if (ancestors.includes(source)) {
    throw new Error(`Codex plugin contains a directory link cycle at ${source}`)
  }
  await mkdir(destination, { recursive: true })
  const nextAncestors = [...ancestors, source]
  for (const name of await readdir(source)) {
    const childSource = join(source, name)
    const childEntry = await lstat(childSource)
    if (childSource.includes(NPM_BIN_PATH_SEGMENT) && !childEntry.isFile() && !childEntry.isDirectory()) continue
    const resolvedSource = childEntry.isSymbolicLink() ? await resolveLinkTarget(childSource) : childSource
    await copyResolved(resolvedSource, join(destination, name), nextAncestors)
  }
}

async function unsupportedEntries(root: string, directory: string): Promise<string[]> {
  const unsupported: string[] = []
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const entry = await lstat(path)
    if (entry.isDirectory()) unsupported.push(...(await unsupportedEntries(root, path)))
    else if (!entry.isFile()) unsupported.push(relative(root, path))
  }
  return unsupported
}
