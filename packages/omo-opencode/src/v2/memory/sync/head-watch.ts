// The runner's HEAD reflog watch (memory-core `watchHeadLog` is not on the `sync-runner` export), with
// one V2 addition made by `./host.ts`: the same edge also tells the status RPC the repo moved. Every
// commit appends to `logs/HEAD`, the engine's own converge commits included, so this is the edge after
// which an `updated` snapshot is due.

import { watch } from "@oh-my-opencode/memory-core/fs"
import { join } from "node:path"

export function watchHeadLog(gitDir: string, onChange: () => void, warn: (message: string) => void): () => void {
  const path = join(gitDir, "logs", "HEAD")
  let watcher: ReturnType<typeof watch>
  try {
    watcher = watch(path, { persistent: false }, onChange)
  } catch (error) {
    warn(
      `memory sync: cannot watch ${path} for local commits (${String(error)}); local edits sync on the next stream event or restart`,
    )
    return () => undefined
  }
  watcher.on("error", (error) => warn(`memory sync: the HEAD reflog watch stopped (${String(error)})`))
  return () => watcher.close()
}
