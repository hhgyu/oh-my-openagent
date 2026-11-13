// Transient one-shot identity runs (issue #7765), the host-neutral half (moved from omo-senpi
// transient-identity.ts). A one-shot run binds `<memory>/transient-runs/<token>/agents/<id>` instead of
// a durable `agents/<id>` directory, and its run root is removed when the run ends. `repo/` is the ONLY
// durable/transient discriminator, here and in sweep.ts: a run that persisted memory is never deleted.

import { join } from "node:path"

import { existsSync } from "../fs/resilient"
import { removeTree } from "../fs/remove-tree"
import { REPO_DIRNAME } from "../identity/layout"

export const TRANSIENT_DIRNAME = "transient-runs"

/** `<base36 epoch>-<pid>-<random>`; the pid lets the sweep spare a run whose owner is still alive. */
const RUN_TOKEN_PATTERN = /^[0-9a-z]+-(\d+)-[0-9a-z]+$/

export type TransientWarn = (message: string, fields?: Readonly<Record<string, unknown>>) => void

/** The discriminator: an identity is durable exactly when it owns a `repo/`. */
export function isDurableIdentityRoot(root: string, exists: (path: string) => boolean = existsSync): boolean {
  return exists(join(root, REPO_DIRNAME))
}

export function readRunTokenPid(token: string): number | undefined {
  const pid = RUN_TOKEN_PATTERN.exec(token)?.[1]
  return pid === undefined ? undefined : Number(pid)
}

export async function removeMemoryTree(path: string, warn?: TransientWarn, logPrefix = "memory"): Promise<boolean> {
  try {
    await removeTree(path)
    return true
  } catch (error) {
    warn?.(`${logPrefix} transient run cleanup failed`, {
      path,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}
